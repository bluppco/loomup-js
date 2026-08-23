import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sqliteSyncStorage,
  type SQLiteSyncDatabase,
} from "../sync.js";

describe("sqliteSyncStorage", () => {
  it("persists SyncStore values through a platform SQLite-shaped adapter", async () => {
    const values = new Map<string, string>();
    let initialized = false;
    const database: SQLiteSyncDatabase = {
      async execAsync(source) {
        initialized = source.includes("CREATE TABLE IF NOT EXISTS");
      },
      async getFirstAsync<T>(_source: string, ...params: unknown[]) {
        const value = values.get(String(params[0]));
        return (value == null ? null : { value }) as T | null;
      },
      async runAsync(source: string, ...params: unknown[]) {
        if (source.startsWith("INSERT")) {
          values.set(String(params[0]), String(params[1]));
        } else if (source.startsWith("DELETE")) {
          values.delete(String(params[0]));
        }
      },
    };
    const storage = await sqliteSyncStorage(database);
    assert.equal(initialized, true);
    assert.equal(await storage.getItem("state"), null);
    await storage.setItem("state", '{"cursor":4}');
    assert.equal(await storage.getItem("state"), '{"cursor":4}');
    await storage.removeItem("state");
    assert.equal(await storage.getItem("state"), null);
  });

  it("rejects interpolated table names", async () => {
    const database = {
      execAsync: async () => undefined,
      getFirstAsync: async () => null,
      runAsync: async () => undefined,
    } as SQLiteSyncDatabase;
    await assert.rejects(
      () => sqliteSyncStorage(database, 'state"; DROP TABLE users;--'),
      /invalid sync storage table name/,
    );
  });
});
