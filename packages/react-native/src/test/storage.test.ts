/**
 * Unit tests for asyncStorageAdapter (no RN runtime required).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asyncStorageAdapter, type AsyncStorageLike } from "../storage.js";
import { createNativeClient } from "../createNativeClient.js";

function createMemoryAsyncStorage(): AsyncStorageLike & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    async getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async setItem(key: string, value: string) {
      store.set(key, value);
    },
    async removeItem(key: string) {
      store.delete(key);
    },
  };
}

describe("asyncStorageAdapter", () => {
  it("maps get/set/remove to AsyncStorage", async () => {
    const mem = createMemoryAsyncStorage();
    const storage = asyncStorageAdapter(mem);

    assert.equal(await storage.getItem("k"), null);
    await storage.setItem("k", "v");
    assert.equal(await storage.getItem("k"), "v");
    assert.equal(mem.store.get("k"), "v");
    await storage.removeItem("k");
    assert.equal(await storage.getItem("k"), null);
    assert.equal(mem.store.has("k"), false);
  });

  it("supports loomup access/refresh key pattern", async () => {
    const mem = createMemoryAsyncStorage();
    const storage = asyncStorageAdapter(mem);
    const prefix = "loomup";

    await storage.setItem(`${prefix}:access`, "a");
    await storage.setItem(`${prefix}:refresh`, "r");
    assert.equal(await storage.getItem(`${prefix}:access`), "a");
    assert.equal(await storage.getItem(`${prefix}:refresh`), "r");
  });
});

describe("createNativeClient", () => {
  it("returns a client with the given url", () => {
    const client = createNativeClient({ url: "http://10.0.2.2:3000/" });
    assert.equal(client.url, "http://10.0.2.2:3000");
  });
});
