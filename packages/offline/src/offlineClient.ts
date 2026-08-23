import {
  createClient,
  SyncStore,
  type LoomupClient,
  type SyncConflict,
  type SyncStorage,
  type SyncStoreStatus,
} from "@loomup/client";
import { browserSQLite, type BrowserSQLiteStorage } from "./browserSQLite.js";

export type OfflineClientOptions = {
  /** Existing client, useful when auth/session state is already configured. */
  client?: LoomupClient;
  /** Required when client is omitted. */
  url?: string;
  resources: readonly string[];
  /** Local SQLite filename. Defaults to loomup-offline.sqlite. */
  database?: string;
  /** Bundler-emitted sql.js WASM asset URL. */
  wasmUrl?: string;
  /** Custom storage for native/test environments. */
  storage?: SyncStorage;
  storageKey?: string;
  primaryKeys?: Record<string, string>;
  online?: boolean;
  live?: boolean;
  pollIntervalMs?: number;
  /** Follow browser online/offline events. Default true. */
  autoConnectivity?: boolean;
};

export class OfflineResource {
  constructor(private readonly store: SyncStore, readonly name: string) {}

  find(): readonly Record<string, unknown>[] {
    return this.store.find(this.name);
  }

  get(id: string | number): Record<string, unknown> | undefined {
    return this.store.get(this.name, id);
  }

  create(data: Record<string, unknown>, options?: { recordId?: string; mutationId?: string }) {
    return this.store.create(this.name, data, options);
  }

  insert(data: Record<string, unknown>, options?: { recordId?: string; mutationId?: string }) {
    return this.create(data, options);
  }

  update(id: string | number, patch: Record<string, unknown>, options?: { mutationId?: string }) {
    return this.store.update(this.name, id, patch, options);
  }

  remove(id: string | number, options?: { mutationId?: string }) {
    return this.store.remove(this.name, id, options);
  }

  delete(id: string | number, options?: { mutationId?: string }) {
    return this.remove(id, options);
  }
}

export class OfflineClient {
  private readonly resources = new Map<string, OfflineResource>();
  private readonly cleanup: Array<() => void> = [];

  constructor(
    readonly store: SyncStore,
    readonly client: LoomupClient,
    readonly storage: SyncStorage,
    private readonly ownsClient: boolean,
  ) {}

  get status(): SyncStoreStatus { return this.store.status; }
  get conflicts(): readonly SyncConflict[] { return this.store.conflicts; }

  from(resource: string): OfflineResource {
    let value = this.resources.get(resource);
    if (!value) {
      value = new OfflineResource(this.store, resource);
      this.resources.set(resource, value);
    }
    return value;
  }

  subscribe(listener: (status: SyncStoreStatus) => void) {
    return this.store.subscribe(listener);
  }

  setOnline(online: boolean) { return this.store.setOnline(online); }
  sync() { return this.store.sync(); }
  resolveConflict(id: string, resolution: "discard" | "retry", data?: Record<string, unknown>) {
    return this.store.resolveConflict(id, resolution, data);
  }

  addCleanup(cleanup: () => void) { this.cleanup.push(cleanup); }

  close() {
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    this.store.close();
    if (this.ownsClient) this.client.closeRealtime();
  }
}

export async function createOfflineClient(options: OfflineClientOptions): Promise<OfflineClient> {
  if (!options.client && !options.url) {
    throw new Error("createOfflineClient requires url or an existing client");
  }
  const ownsClient = !options.client;
  const client = options.client ?? createClient({ url: options.url! });
  const storage = options.storage ?? await browserSQLite(
    options.database ?? "loomup-offline.sqlite",
    { wasmUrl: options.wasmUrl },
  );
  const browserOnline = typeof navigator === "undefined" ? true : navigator.onLine;
  const store = await SyncStore.open(client, {
    resources: options.resources,
    storage,
    storageKey: options.storageKey,
    primaryKeys: options.primaryKeys,
    online: options.online ?? browserOnline,
    live: options.live,
    // A transient network/CORS/server interruption should reconcile without
    // requiring every application to remember to configure a retry loop.
    pollIntervalMs: options.pollIntervalMs ?? 5_000,
  });
  const offline = new OfflineClient(store, client, storage, ownsClient);

  if (options.autoConnectivity !== false && typeof window !== "undefined") {
    const onOffline = () => void offline.setOnline(false);
    const onOnline = () => void offline.setOnline(true);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    offline.addCleanup(() => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    });
  }
  return offline;
}

export function isBrowserSQLiteStorage(storage: SyncStorage): storage is BrowserSQLiteStorage {
  return "databaseName" in storage && typeof (storage as BrowserSQLiteStorage).sizeBytes === "function";
}
