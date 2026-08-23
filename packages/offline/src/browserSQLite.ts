import initSqlJs, { type Database } from "sql.js";
import type { SyncStorage } from "@loomup/client";

export type BrowserSQLiteStorage = SyncStorage & {
  readonly databaseName: string;
  sizeBytes(): number;
};

export type BrowserSQLiteOptions = {
  /** URL emitted by a bundler import such as `sql-wasm.wasm?url`. */
  wasmUrl?: string;
  /** IndexedDB container used to persist SQLite file snapshots. */
  fileStoreDatabase?: string;
};

const FILE_STORE = "files";

function openFileStore(databaseName: string): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) {
    throw new Error("browserSQLite requires IndexedDB");
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(FILE_STORE)) {
        request.result.createObjectStore(FILE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the SQLite file store"));
  });
}

async function readFile(container: string, databaseName: string): Promise<Uint8Array | undefined> {
  const indexedDatabase = await openFileStore(container);
  return new Promise((resolve, reject) => {
    const transaction = indexedDatabase.transaction(FILE_STORE, "readonly");
    const request = transaction.objectStore(FILE_STORE).get(databaseName);
    request.onsuccess = () => {
      const value = request.result;
      resolve(value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : undefined);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not read the SQLite file"));
    transaction.oncomplete = () => indexedDatabase.close();
  });
}

async function writeFile(container: string, databaseName: string, bytes: Uint8Array): Promise<void> {
  const indexedDatabase = await openFileStore(container);
  await new Promise<void>((resolve, reject) => {
    const transaction = indexedDatabase.transaction(FILE_STORE, "readwrite");
    transaction.objectStore(FILE_STORE).put(bytes, databaseName);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not persist the SQLite file"));
    transaction.onabort = () => reject(transaction.error ?? new Error("SQLite file transaction aborted"));
  });
  indexedDatabase.close();
}

function firstValue(database: Database, key: string): string | null {
  const statement = database.prepare("SELECT value FROM loomup_sync_store WHERE key = ? LIMIT 1");
  try {
    statement.bind([key]);
    if (!statement.step()) return null;
    const row = statement.getAsObject();
    return typeof row.value === "string" ? row.value : null;
  } finally {
    statement.free();
  }
}

/**
 * Open a real SQLite/WASM file as SyncStore persistence. Applications name a
 * database; Loomup owns the storage table, serialization, and IndexedDB file container.
 */
export async function browserSQLite(
  databaseName: string,
  options: BrowserSQLiteOptions = {},
): Promise<BrowserSQLiteStorage> {
  const container = options.fileStoreDatabase ?? "loomup-browser-sqlite";
  const wasmUrl = options.wasmUrl ?? new URL("./sql-wasm.wasm", import.meta.url).href;
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const saved = await readFile(container, databaseName);
  const database = saved ? new SQL.Database(saved) : new SQL.Database();
  database.run(`
    CREATE TABLE IF NOT EXISTS loomup_sync_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  let bytes = database.export();
  const persist = async () => {
    bytes = database.export();
    await writeFile(container, databaseName, bytes);
  };
  await persist();

  return {
    databaseName,
    sizeBytes: () => bytes.byteLength,
    getItem: (key) => firstValue(database, key),
    async setItem(key, value) {
      database.run(
        `INSERT INTO loomup_sync_store (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, value, Math.floor(Date.now() / 1000)],
      );
      await persist();
    },
    async removeItem(key) {
      database.run("DELETE FROM loomup_sync_store WHERE key = ?", [key]);
      await persist();
    },
  };
}
