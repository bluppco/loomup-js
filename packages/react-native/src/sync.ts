import type { SyncStorage } from "@loomup/client";

/** Structural subset implemented by Expo SQLite's async database API. */
export type SQLiteSyncDatabase = {
  execAsync(source: string): Promise<unknown>;
  getFirstAsync<T>(source: string, ...params: unknown[]): Promise<T | null>;
  runAsync(source: string, ...params: unknown[]): Promise<unknown>;
};

/**
 * Store the canonical SyncStore state in platform SQLite. No Expo dependency is
 * bundled; pass the database returned by `expo-sqlite/openDatabaseAsync()`.
 */
export async function sqliteSyncStorage(
  database: SQLiteSyncDatabase,
  table = "loomup_sync_store",
): Promise<SyncStorage> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error("invalid sync storage table name");
  }
  await database.execAsync(
    `CREATE TABLE IF NOT EXISTS "${table}" (` +
      "key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL" +
      ")",
  );
  return {
    async getItem(key) {
      const row = await database.getFirstAsync<{ value: string }>(
        `SELECT value FROM "${table}" WHERE key = ? LIMIT 1`,
        key,
      );
      return row?.value ?? null;
    },
    async setItem(key, value) {
      await database.runAsync(
        `INSERT INTO "${table}" (key, value, updated_at) VALUES (?, ?, unixepoch()) ` +
          "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()",
        key,
        value,
      );
    },
    async removeItem(key) {
      await database.runAsync(`DELETE FROM "${table}" WHERE key = ?`, key);
    },
  };
}
