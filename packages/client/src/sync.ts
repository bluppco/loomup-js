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
  dataRevision: number;
  resourceRevisions: Readonly<Record<string, number>>;
  realtime: "connecting" | "live" | "degraded" | "disabled";
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
  /** Healthy-stream reconciliation. Defaults to pollIntervalMs for compatibility. */
  reconcileIntervalMs?: number;
  /** Maximum batching delay from the first live invalidation. Default 120ms. */
  liveDebounceMs?: number;
};

type LocalRecord = { data: Record<string, unknown>; version: number };

/** Compare JSON values without depending on object property order. */
function equalData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) =>
    Object.hasOwn(right, key) && equalData(left[key], right[key]));
}

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
  private active = true;
  private syncTask?: Promise<void>;
  private followup = false;
  private forced = false;
  private eventTimer?: ReturnType<typeof setTimeout>;
  private stopRealtime?: () => void;
  private stopSubscriptions?: () => void;
  private readyResources = new Set<string>();
  private realtime: SyncStoreStatus["realtime"] = "connecting";
  private failures = 0;
  private dirtyVersion = 0;
  private persistedVersion = -1;
  private dataRevision = 0;
  private resourceRevisions: Record<string, number> = {};
  private previousRows = new Map<string, Record<string, LocalRecord>>();

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
    store.stopAuthScope = client.onAuthScopeChange((scope) => store.changeScopeImmediately(scope));
    store.installLiveInvalidation();
    if (store.online) await store.sync();
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
      this.persistedVersion = this.dirtyVersion;
    } else {
      this.state = blankState(this.projectKey(), this.state.scope, this.resourcesKey());
      await this.persist();
    }
  }

  private async persist() {
    if (this.closed || this.persistedVersion === this.dirtyVersion) return;
    const state = this.state;
    const version = this.dirtyVersion;
    await this.options.storage.setItem(this.options.storageKey, JSON.stringify(state));
    if (state === this.state) this.persistedVersion = version;
  }

  private touch(resource?: string) {
    this.dirtyVersion++;
    if (resource && !this.previousRows.has(resource)) {
      this.previousRows.set(resource, { ...this.state.rows[resource] });
    }
  }

  private publishDataChanges() {
    let changed = false;
    for (const [resource, before] of this.previousRows) {
      const after = this.state.rows[resource] ?? {};
      const keys = Object.keys(before);
      if (keys.length === Object.keys(after).length && keys.every((id) =>
        after[id] && equalData(before[id].data, after[id].data))) continue;
      this.resourceRevisions[resource] = (this.resourceRevisions[resource] ?? 0) + 1;
      changed = true;
    }
    this.previousRows.clear();
    if (changed) this.dataRevision++;
  }

  private assertCurrent(state: PersistedState) {
    if (this.closed || state !== this.state) throw new Error("sync scope replaced or store closed");
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
      dataRevision: this.dataRevision,
      resourceRevisions: { ...this.resourceRevisions },
      realtime: this.realtime,
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

  private notify(dataChanged = false) {
    if (this.closed) return;
    if (dataChanged) this.publishDataChanges();
    const status = this.status;
    for (const listener of this.listeners) {
      try { listener(status); } catch { /* observers cannot interrupt durable synchronization */ }
    }
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
    if (this.closed) throw new Error("sync store closed");
    if (!this.options.resources.includes(resource)) {
      throw new Error(`resource ${resource} is not in this sync store`);
    }
  }

  async create(
    resource: string,
    data: Record<string, unknown>,
    options: { recordId?: string; mutationId?: string } = {},
  ): Promise<Record<string, unknown>> {
    const state = this.state;
    let output: Record<string, unknown> = data;
    await this.run(async () => {
      this.assertCurrent(state);
      this.requireResource(resource);
      const primaryKey = this.primaryKey(resource);
      const id = options.recordId ?? scalarId(data[primaryKey]) ?? mutationId();
      output = { ...data, [primaryKey]: id };
      this.touch(resource);
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
      this.notify(true);
    });
    if (this.online) await this.sync();
    return output;
  }

  async update(
    resource: string,
    id: string | number,
    patch: Record<string, unknown>,
    options: { mutationId?: string } = {},
  ): Promise<Record<string, unknown>> {
    const state = this.state;
    let output: Record<string, unknown> = patch;
    await this.run(async () => {
      this.assertCurrent(state);
      this.requireResource(resource);
      const key = String(id);
      const existing = this.state.rows[resource]?.[key];
      if (!existing) throw new Error(`local ${resource}/${key} not found`);
      output = { ...existing.data, ...patch };
      this.touch(resource);
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
      this.notify(true);
    });
    if (this.online) await this.sync();
    return output;
  }

  async remove(
    resource: string,
    id: string | number,
    options: { mutationId?: string } = {},
  ): Promise<void> {
    const state = this.state;
    await this.run(async () => {
      this.assertCurrent(state);
      this.requireResource(resource);
      const key = String(id);
      const existing = this.state.rows[resource]?.[key];
      if (!existing) throw new Error(`local ${resource}/${key} not found`);
      this.touch(resource);
      delete this.state.rows[resource][key];
      this.state.pending.push({
        id: options.mutationId ?? mutationId(),
        resource,
        operation: "delete",
        record_id: key,
        base_sequence: existing.version,
      });
      await this.persist();
      this.notify(true);
    });
    if (this.online) await this.sync();
  }

  async sync(): Promise<void> {
    return this.requestSync(true, false);
  }

  async setOnline(online: boolean): Promise<void> {
    const changed = online !== this.online;
    this.online = online;
    if (!online) {
      this.phase = "offline";
      this.clearTimers();
      this.notify();
    } else if (changed) await this.requestSync(false, true);
  }

  /** Pause automatic work while hidden; explicit sync and durable writes still work. */
  async setActive(active: boolean): Promise<void> {
    const changed = active !== this.active;
    this.active = active;
    if (!active) this.clearTimers();
    else if (changed) await this.requestSync(false, true);
  }

  private clearTimers() {
    clearTimeout(this.pollTimer);
    clearTimeout(this.eventTimer);
    this.pollTimer = this.eventTimer = undefined;
  }

  private requestSync(force: boolean, followup: boolean): Promise<void> {
    if (this.closed || !this.online) return Promise.resolve();
    if (!force && !this.active) { this.followup = true; return Promise.resolve(); }
    this.clearTimers();
    this.forced ||= force;
    if (this.syncTask) {
      this.followup ||= followup;
      return this.syncTask;
    }
    const task = this.run(async () => {
      do {
        this.followup = false;
        await this.syncInternal();
      } while (this.followup && !this.closed && this.online && (this.active || this.forced) && this.phase !== "error");
    }).finally(() => {
      this.syncTask = undefined;
      this.forced = false;
      this.schedulePoll();
    });
    this.syncTask = task;
    return task;
  }

  private invalidate() {
    if (this.closed || !this.online) return;
    if (!this.active) { this.followup = true; return; }
    if (this.syncTask) { this.followup = true; return; }
    if (this.eventTimer) return;
    this.eventTimer = setTimeout(() => {
      this.eventTimer = undefined;
      void this.requestSync(false, true);
    }, Math.max(0, this.options.liveDebounceMs ?? 120));
  }

  private schedulePoll() {
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    if (this.closed || !this.online || !this.active) return;
    const fallback = this.options.pollIntervalMs ?? 0;
    const interval = this.realtime === "live" && this.failures === 0
      ? this.options.reconcileIntervalMs ?? fallback
      : fallback > 0 ? Math.min(Math.max(fallback, 60_000), fallback * 2 ** Math.min(Math.max(0, this.failures - 1), 3)) : 0;
    if (interval > 0) this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.requestSync(false, false);
    }, interval);
  }

  async setScope(scope: string): Promise<void> {
    await this.changeScopeImmediately(scope);
  }

  /** Purge synchronously before any caller can read rows under a new identity. */
  private changeScopeImmediately(scope: string) {
    if (!scope || scope === this.state.scope || this.closed) return;
    for (const resource of this.options.resources) this.touch(resource);
    this.state = blankState(
      this.projectKey(),
      scope,
      this.resourcesKey(),
      this.state.clientId,
    );
    this.phase = this.online ? "syncing" : "offline";
    this.lastError = undefined;
    this.notify(true);
    const task = this.run(async () => {
      await this.persist();
    }).then(() => this.requestSync(false, true));
    // Auth-scope observers are synchronous; explicit setScope still observes failures.
    void task.catch(() => undefined);
    return task;
  }

  async resolveConflict(
    mutationIdValue: string,
    resolution: "discard" | "retry",
    data?: Record<string, unknown>,
  ): Promise<void> {
    await this.run(async () => {
      const index = this.state.conflicts.findIndex(
        (conflict) => conflict.mutation.id === mutationIdValue,
      );
      if (index < 0) return;
      this.touch();
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
      this.notify(true);
    });
    if (this.online) await this.sync();
  }

  private async bootstrapInternal() {
    const state = this.state;
    const response = await this.client.syncBootstrap(
      this.options.resources,
      this.state.clientId,
    );
    this.assertCurrent(state);
    this.applyBootstrap(response);
  }

  private applyBootstrap(response: SyncBootstrapResponse) {
    const rows: PersistedState["rows"] = {};
    for (const resource of this.options.resources) {
      this.touch(resource);
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
      this.touch(mutation.resource);
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
          this.state.rows[mutation.resource][id] = { ...existing, data: { ...existing.data, ...(mutation.data ?? {}) } };
        }
      }
    }
  }

  private async flushPending(): Promise<boolean> {
    while (this.state.pending.length > 0) {
      const mutation = this.state.pending[0];
      const state = this.state;
      const response = await this.client.syncMutations([mutation]);
      this.assertCurrent(state);
      const result = response.results[0];
      if (!result) throw new Error("sync server returned no mutation result");
      if (result.status === "acknowledged" && result.sequence != null) {
        this.touch(mutation.resource);
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
        this.touch();
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
    if (!existing && (event.operation === "DELETE" || !event.after)) return;
    this.touch(event.resource);
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
      const state = this.state;
      const response = await this.client.syncPull(
        this.state.cursor,
        this.options.resources,
        this.state.clientId,
      );
      this.assertCurrent(state);
      if (
        this.state.schemaVersion &&
        response.schema_version !== this.state.schemaVersion
      ) {
        await this.bootstrapInternal();
        this.applyOptimisticPending();
        return;
      }
      for (const event of response.events) this.applyEvent(event);
      if (this.state.cursor !== response.cursor || this.state.schemaVersion !== response.schema_version) this.touch();
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
    const state = this.state;
    this.lastError = undefined;
    this.notify();
    try {
      if (!this.state.schemaVersion) await this.bootstrapInternal();
      this.assertCurrent(state);
      const flushed = await this.flushPending();
      this.assertCurrent(state);
      if (flushed && this.state.conflicts.length === 0) {
        try {
          await this.pullAll();
        } catch (error) {
          this.assertCurrent(state);
          if ((error as { code?: string })?.code === "reset_required") {
            await this.bootstrapInternal();
            this.applyOptimisticPending();
          } else {
            throw error;
          }
        }
      }
      await this.persist();
      this.assertCurrent(state);
      this.phase = this.state.conflicts.length ? "conflict" : this.lastError ? "error" : "idle";
      this.failures = this.lastError ? this.failures + 1 : 0;
    } catch (error) {
      if (this.closed || state !== this.state) return;
      this.failures++;
      this.phase = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    if (!this.online) this.phase = "offline";
    this.notify(true);
  }

  private installLiveInvalidation() {
    const updateHealth = () => {
      const next: SyncStoreStatus["realtime"] = this.options.live === false ? "disabled"
        : this.client.realtimeStatus === "live" && this.options.resources.every((resource) => this.readyResources.has(resource)) ? "live" : "degraded";
      if (next === this.realtime) return;
      this.realtime = next;
      this.notify();
      if (next === "live") void this.requestSync(false, true);
      else this.schedulePoll();
    };
    if (this.options.live !== false) {
      this.stopRealtime = this.client.onRealtimeStatus(updateHealth);
      this.stopSubscriptions = this.client.onSubscriptionStatus((statuses) => {
        this.readyResources = new Set(statuses.filter((status) => status.status === "ready" && status.rowId === undefined).map((status) => status.table));
        updateHealth();
      });
      for (const resource of this.options.resources) {
        try {
          const stop = this.client.from(resource).subscribe(() => this.invalidate());
          this.liveStops.push(stop);
        } catch {
          // REST-only runtimes can use explicit sync() or pollIntervalMs.
        }
      }
    }
    updateHealth();
    this.schedulePoll();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopRealtime?.();
    this.stopSubscriptions?.();
    for (const stop of this.liveStops) stop();
    this.liveStops = [];
    this.clearTimers();
    this.stopAuthScope?.();
    this.listeners.clear();
  }
}
