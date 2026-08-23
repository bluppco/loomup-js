import type {
  LoomupClient,
  SyncBootstrapResponse,
  SyncEvent,
  SyncMutationInput,
  SyncMutationResult,
} from "./index.js";

export interface SyncStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

export class MemorySyncStorage implements SyncStorage {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

/** Durable browser adapter. Pass `window.localStorage` explicitly in SSR code. */
export function browserSyncStorage(storage: Storage): SyncStorage {
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
  };
}

/**
 * Transactional browser persistence without a bundled database engine. This is
 * the default durable browser path while SQLite/WASM remains an optional adapter
 * behind the same SyncStorage contract.
 */
export function indexedDbSyncStorage(options?: {
  databaseName?: string;
  storeName?: string;
}): SyncStorage {
  const indexedDb = globalThis.indexedDB;
  if (!indexedDb) throw new Error("IndexedDB is not available in this runtime");
  const databaseName = options?.databaseName ?? "loomup-sync-v1";
  const storeName = options?.storeName ?? "state";
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDb.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName);
      }
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked"));
  });
  const transaction = async <T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await database;
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = operation(tx.objectStore(storeName));
      let value: T | undefined;
      request.onsuccess = () => {
        value = request.result;
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
      tx.oncomplete = () => resolve(value as T);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  };
  return {
    getItem: async (key) => {
      const value = await transaction<unknown>("readonly", (store) => store.get(key));
      return typeof value === "string" ? value : null;
    },
    setItem: async (key, value) => {
      await transaction<IDBValidKey>("readwrite", (store) => store.put(value, key));
    },
    removeItem: async (key) => {
      await transaction<undefined>("readwrite", (store) => store.delete(key));
    },
  };
}

export type SyncConflict = {
  mutation: SyncMutationInput;
  error: NonNullable<SyncMutationResult["error"]>;
};

export type SyncStoreStatus = {
  phase: "idle" | "syncing" | "offline" | "conflict" | "error";
  online: boolean;
  cursor: number;
  pending: number;
  conflicts: number;
  lastError?: string;
};

export type SyncStoreOptions = {
  resources: readonly string[];
  storage?: SyncStorage;
  storageKey?: string;
  /** Defaults to the client's authenticated JWT subject. */
  scope?: string;
  primaryKeys?: Record<string, string>;
  online?: boolean;
  /** Use realtime frames as pull invalidations when a WebSocket is available. Default true. */
  live?: boolean;
  /** Optional fallback polling. Realtime invalidation is attempted automatically. */
  pollIntervalMs?: number;
};

type LocalRecord = { data: Record<string, unknown>; version: number };

type PersistedState = {
  format: 1;
  /** Loomup project identity (client URL). Isolates durable caches across projects. */
  projectKey: string;
  scope: string;
  resourcesKey: string;
  clientId: string;
  schemaVersion: string;
  cursor: number;
  rows: Record<string, Record<string, LocalRecord>>;
  pending: SyncMutationInput[];
  conflicts: SyncConflict[];
};

function blankState(
  projectKey: string,
  scope: string,
  resourcesKey: string,
  clientId = mutationId(),
): PersistedState {
  return {
    format: 1,
    projectKey,
    scope,
    resourcesKey,
    clientId,
    schemaVersion: "",
    cursor: 0,
    rows: {},
    pending: [],
    conflicts: [],
  };
}

function mutationId(): string {
  const cryptoLike = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoLike?.randomUUID === "function") return cryptoLike.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function scalarId(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return undefined;
}

/**
 * Persistent authorization-scoped local resource cache with an offline mutation
 * queue. Server mutations are idempotent; local application is sequence-aware.
 */
export class SyncStore {
  private state: PersistedState;
  private online: boolean;
  private phase: SyncStoreStatus["phase"];
  private lastError?: string;
  private chain: Promise<void> = Promise.resolve();
  private listeners = new Set<(status: SyncStoreStatus) => void>();
  private liveStops: Array<() => void> = [];
  private pollTimer?: ReturnType<typeof setInterval>;
  private stopAuthScope?: () => void;
  private closed = false;

  private constructor(
    private readonly client: LoomupClient,
    private readonly options: Required<
      Pick<SyncStoreOptions, "resources" | "storage" | "storageKey" | "primaryKeys">
    > &
      SyncStoreOptions,
    scope: string,
  ) {
    this.state = blankState(client.url, scope, this.resourcesKey());
    this.online = options.online ?? true;
    this.phase = this.online ? "idle" : "offline";
  }

  static async open(client: LoomupClient, options: SyncStoreOptions): Promise<SyncStore> {
    const resources = [...new Set(options.resources)].sort();
    if (resources.length === 0) throw new Error("SyncStore requires at least one resource");
    const normalized = {
      ...options,
      resources,
      storage: options.storage ?? new MemorySyncStorage(),
      storageKey: options.storageKey ?? `loomup.sync.v1:${client.url}`,
      primaryKeys: options.primaryKeys ?? {},
    };
    const store = new SyncStore(client, normalized, options.scope ?? client.authScope);
    await store.load();
    if (store.online) await store.run(() => store.syncInternal());
    store.installLiveInvalidation();
    store.stopAuthScope = client.onAuthScopeChange((scope) => store.changeScopeImmediately(scope));
    return store;
  }

  private projectKey() {
    return this.client.url;
  }

  private resourcesKey() {
    return [...this.options.resources].sort().join(",");
  }

  private primaryKey(resource: string) {
    return this.options.primaryKeys[resource] ?? "id";
  }

  private async load() {
    let loaded: PersistedState | undefined;
    try {
      const raw = await this.options.storage.getItem(this.options.storageKey);
      if (raw) loaded = JSON.parse(raw) as PersistedState;
    } catch {
      await this.options.storage.removeItem(this.options.storageKey);
    }
    if (
      loaded?.format === 1 &&
      loaded.projectKey === this.projectKey() &&
      loaded.scope === this.state.scope &&
      loaded.resourcesKey === this.resourcesKey() &&
      typeof loaded.clientId === "string" &&
      loaded.rows &&
      Array.isArray(loaded.pending) &&
      Array.isArray(loaded.conflicts)
    ) {
      this.state = loaded;
    } else {
      this.state = blankState(this.projectKey(), this.state.scope, this.resourcesKey());
      await this.persist();
    }
  }

  private persist() {
    return Promise.resolve(
      this.options.storage.setItem(this.options.storageKey, JSON.stringify(this.state)),
    );
  }

  private run(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  get status(): SyncStoreStatus {
    return {
      phase: this.phase,
      online: this.online,
      cursor: this.state.cursor,
      pending: this.state.pending.length,
      conflicts: this.state.conflicts.length,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  get conflicts(): readonly SyncConflict[] {
    return this.state.conflicts;
  }

  subscribe(listener: (status: SyncStoreStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    const status = this.status;
    for (const listener of this.listeners) listener(status);
  }

  find(resource: string): readonly Record<string, unknown>[] {
    this.requireResource(resource);
    return Object.values(this.state.rows[resource] ?? {}).map((record) => record.data);
  }

  get(resource: string, id: string | number): Record<string, unknown> | undefined {
    this.requireResource(resource);
    return this.state.rows[resource]?.[String(id)]?.data;
  }

  private requireResource(resource: string) {
    if (!this.options.resources.includes(resource)) {
      throw new Error(`resource ${resource} is not in this sync store`);
    }
  }

  async create(
    resource: string,
    data: Record<string, unknown>,
    options: { recordId?: string; mutationId?: string } = {},
  ): Promise<Record<string, unknown>> {
    let output: Record<string, unknown> = data;
    await this.run(async () => {
      this.requireResource(resource);
      const primaryKey = this.primaryKey(resource);
      const id = options.recordId ?? scalarId(data[primaryKey]) ?? mutationId();
      output = { ...data, [primaryKey]: id };
      this.state.rows[resource] ??= {};
      this.state.rows[resource][id] = { data: output, version: 0 };
      this.state.pending.push({
        id: options.mutationId ?? mutationId(),
        resource,
        operation: "create",
        record_id: id,
        data: output,
      });
      await this.persist();
      this.notify();
      if (this.online) await this.syncInternal();
    });
    return output;
  }

  async update(
    resource: string,
    id: string | number,
    patch: Record<string, unknown>,
    options: { mutationId?: string } = {},
  ): Promise<Record<string, unknown>> {
    let output: Record<string, unknown> = patch;
    await this.run(async () => {
      this.requireResource(resource);
      const key = String(id);
      const existing = this.state.rows[resource]?.[key];
      if (!existing) throw new Error(`local ${resource}/${key} not found`);
      output = { ...existing.data, ...patch };
      this.state.rows[resource][key] = { data: output, version: existing.version };
      this.state.pending.push({
        id: options.mutationId ?? mutationId(),
        resource,
        operation: "update",
        record_id: key,
        data: patch,
        base_sequence: existing.version,
      });
      await this.persist();
      this.notify();
      if (this.online) await this.syncInternal();
    });
    return output;
  }

  async remove(
    resource: string,
    id: string | number,
    options: { mutationId?: string } = {},
  ): Promise<void> {
    await this.run(async () => {
      this.requireResource(resource);
      const key = String(id);
      const existing = this.state.rows[resource]?.[key];
      if (!existing) throw new Error(`local ${resource}/${key} not found`);
      delete this.state.rows[resource][key];
      this.state.pending.push({
        id: options.mutationId ?? mutationId(),
        resource,
        operation: "delete",
        record_id: key,
        base_sequence: existing.version,
      });
      await this.persist();
      this.notify();
      if (this.online) await this.syncInternal();
    });
  }

  async sync(): Promise<void> {
    return this.run(() => this.syncInternal());
  }

  async setOnline(online: boolean): Promise<void> {
    return this.run(async () => {
      this.online = online;
      this.phase = online ? "idle" : "offline";
      this.notify();
      if (online) await this.syncInternal();
    });
  }

  async setScope(scope: string): Promise<void> {
    this.changeScopeImmediately(scope);
    await this.chain;
  }

  /** Purge synchronously before any caller can read rows under a new identity. */
  private changeScopeImmediately(scope: string) {
    if (!scope || scope === this.state.scope || this.closed) return;
    this.state = blankState(
      this.projectKey(),
      scope,
      this.resourcesKey(),
      this.state.clientId,
    );
    this.phase = this.online ? "syncing" : "offline";
    this.lastError = undefined;
    this.notify();
    void this.run(async () => {
      await this.persist();
      if (this.online) await this.syncInternal();
    });
  }

  async resolveConflict(
    mutationIdValue: string,
    resolution: "discard" | "retry",
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.run(async () => {
      const index = this.state.conflicts.findIndex(
        (conflict) => conflict.mutation.id === mutationIdValue,
      );
      if (index < 0) return;
      const [conflict] = this.state.conflicts.splice(index, 1);
      if (resolution === "retry") {
        const current = conflict.error.details?.current;
        const mutation = {
          ...conflict.mutation,
          ...(typeof current === "number" ? { base_sequence: current } : {}),
          ...(data ? { data } : {}),
        };
        this.state.pending.unshift(mutation);
      }
      await this.bootstrapInternal();
      this.applyOptimisticPending();
      await this.persist();
      if (this.online) await this.syncInternal();
    });
  }

  private async bootstrapInternal() {
    const response = await this.client.syncBootstrap(
      this.options.resources,
      this.state.clientId,
    );
    this.applyBootstrap(response);
  }

  private applyBootstrap(response: SyncBootstrapResponse) {
    const rows: PersistedState["rows"] = {};
    for (const resource of this.options.resources) {
      rows[resource] = {};
      for (const record of response.resources[resource]?.records ?? []) {
        const id = scalarId(record.data[this.primaryKey(resource)]);
        if (id != null) rows[resource][id] = record;
      }
    }
    this.state.rows = rows;
    this.state.cursor = response.cursor;
    this.state.schemaVersion = response.schema_version;
  }

  private applyOptimisticPending() {
    for (const mutation of this.state.pending) {
      const id = mutation.record_id;
      if (!id) continue;
      this.state.rows[mutation.resource] ??= {};
      if (mutation.operation === "delete") {
        delete this.state.rows[mutation.resource][id];
      } else if (mutation.operation === "create") {
        this.state.rows[mutation.resource][id] = {
          data: mutation.data ?? {},
          version: mutation.base_sequence ?? 0,
        };
      } else {
        const existing = this.state.rows[mutation.resource][id];
        if (existing) {
          existing.data = { ...existing.data, ...(mutation.data ?? {}) };
        }
      }
    }
  }

  private async flushPending(): Promise<boolean> {
    while (this.state.pending.length > 0) {
      const mutation = this.state.pending[0];
      const response = await this.client.syncMutations([mutation]);
      const result = response.results[0];
      if (!result) throw new Error("sync server returned no mutation result");
      if (result.status === "acknowledged" && result.sequence != null) {
        this.state.pending.shift();
        const id = mutation.record_id;
        if (id && mutation.operation === "delete") {
          delete this.state.rows[mutation.resource]?.[id];
        } else if (id && result.record) {
          this.state.rows[mutation.resource] ??= {};
          this.state.rows[mutation.resource][id] = {
            data: result.record,
            version: result.sequence,
          };
        }
        for (const later of this.state.pending) {
          if (
            later.resource === mutation.resource &&
            later.record_id === mutation.record_id &&
            later.operation !== "create"
          ) {
            later.base_sequence = result.sequence;
          }
        }
        await this.persist();
        continue;
      }
      if (result.status === "conflict" || result.status === "rejected") {
        this.state.pending.shift();
        this.state.conflicts.push({
          mutation,
          error: result.error ?? { code: "conflict", message: "mutation rejected" },
        });
        await this.persist();
        return false;
      }
      // Retryable result stays at the front with its stable mutation ID.
      this.lastError = result.error?.message ?? "mutation retry requested";
      await this.persist();
      return false;
    }
    return true;
  }

  private applyEvent(event: SyncEvent) {
    this.state.rows[event.resource] ??= {};
    const existing = this.state.rows[event.resource][event.record_id];
    if (existing && existing.version >= event.sequence) return;
    if (event.operation === "DELETE" || !event.after) {
      delete this.state.rows[event.resource][event.record_id];
    } else {
      this.state.rows[event.resource][event.record_id] = {
        data: event.after,
        version: event.sequence,
      };
    }
  }

  private async pullAll() {
    do {
      const response = await this.client.syncPull(
        this.state.cursor,
        this.options.resources,
        this.state.clientId,
      );
      if (
        this.state.schemaVersion &&
        response.schema_version !== this.state.schemaVersion
      ) {
        await this.bootstrapInternal();
        this.applyOptimisticPending();
        return;
      }
      for (const event of response.events) this.applyEvent(event);
      this.state.cursor = response.cursor;
      this.state.schemaVersion = response.schema_version;
      if (!response.has_more) break;
    } while (true);
  }

  private async syncInternal() {
    if (this.closed || !this.online) {
      this.phase = "offline";
      this.notify();
      return;
    }
    this.phase = "syncing";
    this.lastError = undefined;
    this.notify();
    try {
      if (!this.state.schemaVersion) await this.bootstrapInternal();
      const flushed = await this.flushPending();
      if (flushed && this.state.conflicts.length === 0) {
        try {
          await this.pullAll();
        } catch (error) {
          if ((error as { code?: string })?.code === "reset_required") {
            await this.bootstrapInternal();
            this.applyOptimisticPending();
          } else {
            throw error;
          }
        }
      }
      await this.persist();
      this.phase = this.state.conflicts.length ? "conflict" : "idle";
    } catch (error) {
      this.phase = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    this.notify();
  }

  private installLiveInvalidation() {
    if (this.options.live !== false) {
      for (const resource of this.options.resources) {
        try {
          const stop = this.client.from(resource).subscribe(() => {
            if (this.online) void this.sync();
          });
          this.liveStops.push(stop);
        } catch {
          // REST-only runtimes can use explicit sync() or pollIntervalMs.
        }
      }
    }
    const interval = this.options.pollIntervalMs ?? 0;
    if (interval > 0) {
      this.pollTimer = setInterval(() => {
        if (this.online) void this.sync();
      }, interval);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.liveStops) stop();
    this.liveStops = [];
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.stopAuthScope?.();
    this.listeners.clear();
  }
}
