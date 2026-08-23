import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, MemorySyncStorage, SyncStore } from "../index.js";

describe("SyncStore", () => {
  it("persists offline mutations, uploads them in order, and purges on identity change", async () => {
    const storage = new MemorySyncStorage();
    const uploaded: Array<Record<string, unknown>> = [];
    let sequence = 0;
    let serverRow: Record<string, unknown> | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/sync/v1/bootstrap")) {
        return Response.json({
          data: {
            protocol_version: 1,
            schema_version: "schema-1",
            cursor: sequence,
            resources: {
              notes: { records: serverRow ? [{ data: serverRow, version: sequence }] : [] },
            },
          },
        });
      }
      if (url.includes("/sync/v1/pull")) {
        return Response.json({
          data: {
            protocol_version: 1,
            schema_version: "schema-1",
            cursor: sequence,
            has_more: false,
            events: [],
          },
        });
      }
      if (url.includes("/sync/v1/mutations")) {
        const body = JSON.parse(String(init?.body)) as {
          mutations: Array<Record<string, any>>;
        };
        const mutation = body.mutations[0];
        uploaded.push(mutation);
        sequence += 1;
        if (mutation.operation === "create") {
          serverRow = { ...mutation.data };
        } else if (mutation.operation === "update") {
          serverRow = { ...serverRow, ...mutation.data };
        } else {
          serverRow = undefined;
        }
        return Response.json({
          data: {
            protocol_version: 1,
            results: [
              {
                mutation_id: mutation.id,
                status: "acknowledged",
                record: serverRow,
                sequence,
              },
            ],
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const client = createClient({ url: "http://sync.test" });
      const store = await SyncStore.open(client, {
        resources: ["notes"],
        scope: "user-1",
        storage,
        online: false,
        live: false,
      });
      await store.create(
        "notes",
        { title: "offline" },
        { recordId: "n1", mutationId: "device:1" },
      );
      await store.update(
        "notes",
        "n1",
        { title: "edited offline" },
        { mutationId: "device:2" },
      );
      assert.equal(store.status.pending, 2);
      assert.equal(store.get("notes", "n1")?.title, "edited offline");

      await store.setOnline(true);
      assert.equal(store.status.phase, "idle");
      assert.equal(store.status.pending, 0);
      assert.equal(uploaded.length, 2);
      assert.equal(uploaded[0].id, "device:1");
      assert.equal(uploaded[1].id, "device:2");
      assert.equal(uploaded[1].base_sequence, 1, "dependent mutation uses create ack");
      assert.equal(store.get("notes", "n1")?.title, "edited offline");
      store.close();

      const reopened = await SyncStore.open(client, {
        resources: ["notes"],
        scope: "user-1",
        storage,
        online: false,
        live: false,
      });
      assert.equal(reopened.get("notes", "n1")?.title, "edited offline");
      await reopened.remove("notes", "n1", { mutationId: "device:3" });
      assert.equal(reopened.get("notes", "n1"), undefined);
      await reopened.setOnline(true);
      assert.equal(uploaded[2]?.operation, "delete");
      assert.equal(reopened.status.pending, 0);

      const payload = globalThis
        .btoa(JSON.stringify({ sub: "user-2" }))
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
      client.setToken(`e30.${payload}.sig`);
      assert.deepEqual(reopened.find("notes"), [], "identity change purges synchronously");
      assert.equal(reopened.status.pending, 0);
      reopened.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not load another project's durable cache", async () => {
    const storage = new MemorySyncStorage();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("project-a") && url.includes("/sync/v1/bootstrap")) {
        return Response.json({
          data: {
            protocol_version: 1,
            schema_version: "schema-a",
            cursor: 3,
            resources: {
              notes: {
                records: [{ data: { id: "secret-a", title: "private from A" }, version: 3 }],
              },
            },
          },
        });
      }
      if (url.includes("/sync/v1/pull")) {
        return Response.json({
          data: {
            protocol_version: 1,
            schema_version: "schema-a",
            cursor: 3,
            has_more: false,
            events: [],
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const clientA = createClient({ url: "https://cloud.example/p/project-a" });
      const storeA = await SyncStore.open(clientA, {
        resources: ["notes"],
        scope: "user-1",
        storage,
        live: false,
      });
      assert.equal(storeA.get("notes", "secret-a")?.title, "private from A");
      storeA.close();

      // Same user + resources, different project URL, shared storage adapter.
      // Default keys are URL-scoped so both caches can coexist offline.
      const clientB = createClient({ url: "https://cloud.example/p/project-b" });
      const storeB = await SyncStore.open(clientB, {
        resources: ["notes"],
        scope: "user-1",
        storage,
        online: false,
        live: false,
      });
      assert.equal(
        storeB.get("notes", "secret-a"),
        undefined,
        "project B must not load project A's cached private row",
      );
      assert.deepEqual(storeB.find("notes"), []);
      storeB.close();

      const reopenedA = await SyncStore.open(clientA, {
        resources: ["notes"],
        scope: "user-1",
        storage,
        online: false,
        live: false,
      });
      assert.equal(
        reopenedA.get("notes", "secret-a")?.title,
        "private from A",
        "project A cache remains available under its own storage key",
      );
      reopenedA.close();

      // Even an explicit shared storageKey must not surface foreign project rows.
      const sharedKey = "loomup.sync.shared-test";
      const storeAShared = await SyncStore.open(clientA, {
        resources: ["notes"],
        scope: "user-1",
        storage,
        storageKey: sharedKey,
        live: false,
      });
      assert.equal(storeAShared.get("notes", "secret-a")?.title, "private from A");
      storeAShared.close();
      const storeBShared = await SyncStore.open(clientB, {
        resources: ["notes"],
        scope: "user-1",
        storage,
        storageKey: sharedKey,
        online: false,
        live: false,
      });
      assert.equal(storeBShared.get("notes", "secret-a"), undefined);
      storeBShared.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces optimistic conflicts and can discard back to server state", async () => {
    const originalFetch = globalThis.fetch;
    let mutationCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/sync/v1/bootstrap")) {
        return Response.json({
          data: {
            protocol_version: 1,
            schema_version: "schema-1",
            cursor: 7,
            resources: {
              notes: { records: [{ data: { id: "n1", title: "server" }, version: 7 }] },
            },
          },
        });
      }
      if (url.includes("/sync/v1/pull")) {
        return Response.json({
          data: {
            protocol_version: 1,
            schema_version: "schema-1",
            cursor: 7,
            has_more: false,
            events: [],
          },
        });
      }
      if (url.includes("/sync/v1/mutations")) {
        mutationCalls += 1;
        return Response.json({
          data: {
            protocol_version: 1,
            results: [
              {
                mutation_id: "conflict-1",
                status: "conflict",
                error: {
                  code: "version_conflict",
                  message: "stale",
                  details: { expected: 7, current: 8 },
                },
              },
            ],
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    try {
      const client = createClient({ url: "http://sync.test" });
      const store = await SyncStore.open(client, {
        resources: ["notes"],
        scope: "user-1",
        live: false,
      });
      await store.setOnline(false);
      await store.update(
        "notes",
        "n1",
        { title: "local" },
        { mutationId: "conflict-1" },
      );
      await store.setOnline(true);
      assert.equal(mutationCalls, 1);
      assert.equal(store.status.phase, "conflict");
      assert.equal(store.conflicts[0]?.error.code, "version_conflict");
      assert.equal(store.get("notes", "n1")?.title, "local");

      await store.setOnline(false);
      await store.resolveConflict("conflict-1", "discard");
      assert.equal(store.status.conflicts, 0);
      assert.equal(store.get("notes", "n1")?.title, "server");
      store.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
