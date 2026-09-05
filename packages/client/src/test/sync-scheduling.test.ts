import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createClient, MemorySyncStorage, SyncStore, type SyncEvent, type SubscriptionStatus } from "../index.js";

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: (event: unknown) => void;
  onclose?: (event: unknown) => void;
  onmessage?: (event: { data: string }) => void;
  sent: Array<Record<string, any>> = [];
  constructor() { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.onopen?.({}); }
  close() { this.readyState = 3; this.onclose?.({}); }
  message(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
  ack(table: string) {
    const frame = this.sent.filter((item) => item.type === "subscribe" && item.table === table).at(-1)!;
    this.message({ type: "subscribed", table, requestId: frame.requestId });
  }
  change(table = "notes") { this.message({ type: "change", table, id: "n1", op: "UPDATE", ts: 1 }); }
}

class Storage extends MemorySyncStorage {
  writes = 0;
  override setItem(key: string, value: string) { this.writes++; super.setItem(key, value); }
}

async function drain() { for (let index = 0; index < 80; index++) await Promise.resolve(); }

async function fixture(t: TestContext, resources = ["notes"], acknowledge = true) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  t.mock.method(Math, "random", () => 0.5);
  Socket.instances = [];
  const state = { cursor: 1, events: [] as SyncEvent[], pulls: 0, bootstraps: 0, tableReads: 0,
    failures: false, reset: false, rows: [{ data: { id: "n1", title: "first" }, version: 1 }],
    hold: undefined as Promise<void> | undefined, concurrent: 0, maxConcurrent: 0 };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("bootstrap")) {
      state.bootstraps++;
      return Response.json({ data: { protocol_version: 1, schema_version: "s1", cursor: state.cursor,
        resources: Object.fromEntries(resources.map((resource) => [resource, { records: resource === "notes" ? state.rows : [] }])) } });
    }
    if (!url.pathname.endsWith("pull")) { state.tableReads++; return Response.json({ data: [], meta: { total: 0 } }); }
    state.pulls++;
    state.maxConcurrent = Math.max(state.maxConcurrent, ++state.concurrent);
    try {
      await state.hold;
      if (state.failures) throw new TypeError("network unavailable");
      if (state.reset) { state.reset = false; return Response.json({ error: { code: "reset_required", message: "access changed" } }, { status: 409 }); }
      return Response.json({ data: { protocol_version: 1, schema_version: "s1", cursor: state.cursor,
        events: state.events.filter((event) => event.sequence > Number(url.searchParams.get("cursor"))), has_more: false } });
    } finally { state.concurrent--; }
  });
  const client = createClient({ url: "https://sync.test", realtimeHeartbeat: false, realtimeResync: false,
    WebSocketImpl: Socket as unknown as typeof WebSocket });
  const storage = new Storage();
  const store = await SyncStore.open(client, { resources, storage, online: false, pollIntervalMs: 15_000, reconcileIntervalMs: 300_000 });
  t.after(() => { store.close(); client.closeRealtime(); });
  const socket = Socket.instances[0];
  socket.open();
  if (acknowledge) for (const resource of resources) socket.ack(resource);
  await store.setOnline(true);
  state.pulls = storage.writes = 0;
  return { client, store, storage, socket, state };
}

describe("event-driven synchronization", () => {
  it("checks healthy idle tabs only every five minutes and never rewrites unchanged snapshots", async (t) => {
    const { store, state, storage } = await fixture(t);
    const revision = store.status.dataRevision;
    assert.equal(store.status.realtime, "live");
    for (let minute = 0; minute < 10; minute++) { t.mock.timers.tick(60_000); await drain(); }
    assert.equal(state.pulls, 2);
    assert.equal(storage.writes, 0);
    assert.equal(store.status.dataRevision, revision);
  });

  it("persists cursor-only advancement without a data revision", async (t) => {
    const { store, state, storage } = await fixture(t);
    const revision = store.status.dataRevision;
    state.cursor = 2;
    await store.sync();
    assert.equal(storage.writes, 1);
    assert.equal(store.status.cursor, 2);
    assert.equal(store.status.dataRevision, revision);
    await store.sync();
    assert.equal(storage.writes, 1);
  });

  it("batches twenty events and allows only one follow-up during an in-flight pull", async (t) => {
    const { store, state, socket } = await fixture(t);
    for (let index = 0; index < 20; index++) socket.change();
    t.mock.timers.tick(119); await drain();
    assert.equal(state.pulls, 0);
    t.mock.timers.tick(1); await drain();
    assert.equal(state.pulls, 1);
    let release!: () => void;
    state.hold = new Promise((resolve) => { release = resolve; });
    const running = store.sync();
    await drain();
    for (let index = 0; index < 20; index++) socket.change();
    state.hold = undefined;
    release();
    await running;
    assert.equal(state.pulls, 3);
    assert.equal(state.maxConcurrent, 1);
  });

  it("invalidates only changed resource data, not record versions or property order", async (t) => {
    const { store, state, storage } = await fixture(t, ["notes", "notifications"]);
    const revision = store.status.dataRevision;
    state.cursor = 2;
    state.events = [{ resource: "notes", record_id: "n1", sequence: 2, operation: "UPDATE",
      after: { title: "first", id: "n1" }, event_id: "e2", origin: "test", committed_at: 1, schema_version: 1 }];
    await store.sync();
    assert.equal(store.status.dataRevision, revision);
    assert.equal(storage.writes, 1);
    state.cursor = 3;
    state.events.push({ ...state.events[0], sequence: 3, after: { id: "n1", title: "changed" } });
    await store.sync();
    assert.equal(store.status.dataRevision, revision + 1);
    assert.equal(store.status.resourceRevisions.notifications ?? 0, 0);
    assert.equal(store.get("notes", "n1")?.title, "changed");
  });

  it("does not apply or persist a response arriving after close", async (t) => {
    const { store, state, storage } = await fixture(t);
    let release!: () => void;
    state.hold = new Promise((resolve) => { release = resolve; });
    const running = store.sync(); await drain();
    store.close(); state.cursor = 2; release();
    await running;
    assert.equal(store.status.cursor, 1);
    assert.equal(storage.writes, 0);
  });

  it("keeps fallback polling until every subscription is acknowledged", async (t) => {
    const { store, socket, state } = await fixture(t, ["notes", "notifications"], false);
    socket.ack("notes");
    assert.equal(store.status.realtime, "degraded");
    t.mock.timers.tick(15_000); await drain();
    assert.equal(state.pulls, 1);
    socket.ack("notes"); socket.ack("notifications"); await drain();
    assert.equal(store.status.realtime, "live");
    assert.equal(state.pulls, 2);
    t.mock.timers.tick(60_000); await drain();
    assert.equal(state.pulls, 2);
  });

  it("pauses automatic work while hidden or offline and catches up once on resume", async (t) => {
    const { store, socket, state } = await fixture(t);
    await store.setActive(false);
    socket.change(); t.mock.timers.tick(900_000); await drain();
    assert.equal(state.pulls, 0);
    await store.sync();
    assert.equal(state.pulls, 1, "explicit refresh is not paused");
    await store.setActive(true);
    assert.equal(state.pulls, 2);
    await store.setOnline(false);
    socket.change(); t.mock.timers.tick(900_000); await drain();
    assert.equal(state.pulls, 2);
    await store.setOnline(true);
    assert.equal(state.pulls, 3);
  });

  it("backs off failed pulls at 15, 30 and 60 seconds, then restores healthy cadence", async (t) => {
    const { store, state } = await fixture(t);
    state.failures = true;
    await store.sync();
    for (const interval of [15_000, 30_000, 60_000]) { t.mock.timers.tick(interval); await drain(); }
    assert.equal(state.pulls, 4);
    state.failures = false;
    t.mock.timers.tick(60_000); await drain();
    assert.equal(state.pulls, 5);
    t.mock.timers.tick(60_000); await drain();
    assert.equal(state.pulls, 5);
  });

  it("does not extend an explicit refresh with hidden socket invalidations", async (t) => {
    const { store, socket, state } = await fixture(t);
    let release!: () => void;
    state.hold = new Promise((resolve) => { release = resolve; });
    const running = store.sync();
    await drain();
    await store.setActive(false);
    for (let index = 0; index < 20; index++) socket.change();
    state.hold = undefined; release();
    await running;
    assert.equal(state.pulls, 1, "the explicit cycle finishes without a hidden follow-up");
    t.mock.timers.tick(900_000); await drain();
    assert.equal(state.pulls, 1);
    await store.sync();
    assert.equal(state.pulls, 2, "another explicit refresh is still allowed");
    await store.setActive(true);
    assert.equal(state.pulls, 3, "deferred invalidations catch up once on resume");
  });

  it("rechecks visibility before a queued automatic cycle starts", async (t) => {
    const { store, state } = await fixture(t);
    await store.setActive(false);
    const activating = store.setActive(true);
    await store.setActive(false);
    await activating;
    assert.equal(state.pulls, 0);
    await store.setActive(true);
    assert.equal(state.pulls, 1);
  });

  it("honors an explicit refresh joining queued automatic work after hiding", async (t) => {
    const { store, state } = await fixture(t);
    await store.setActive(false);
    const activating = store.setActive(true);
    const hiding = store.setActive(false);
    const explicit = store.sync();
    await Promise.all([activating, hiding, explicit]);
    assert.equal(state.pulls, 1, "the explicit caller upgrades only the queued cycle");
    t.mock.timers.tick(900_000); await drain();
    assert.equal(state.pulls, 1, "joining the cycle does not restart hidden polling");
  });

  it("does not let a just-skipped automatic task swallow a new explicit refresh", async (t) => {
    const { store, state } = await fixture(t);
    await store.setActive(false);
    const activating = store.setActive(true);
    await store.setActive(false); // Let the queued task observe the hidden state.
    await Promise.all([activating, store.sync()]);
    assert.equal(state.pulls, 1);
  });

  it("recovers an empty table after reconnect with one cursor pull and no REST row resync", async (t) => {
    const { store, socket, state } = await fixture(t);
    state.cursor = 2;
    state.rows = [];
    state.events = [{ resource: "notes", record_id: "n1", sequence: 2, operation: "DELETE", after: null, event_id: "e2", origin: "test", committed_at: 1, schema_version: 1 }];
    socket.close(); t.mock.timers.tick(1000); await drain();
    const replacement = Socket.instances.at(-1)!;
    replacement.open(); replacement.ack("notes"); await drain();
    assert.equal(state.pulls, 1);
    assert.equal(state.tableReads, 0);
    assert.equal(store.get("notes", "n1"), undefined);
  });

  it("rebootstraps on access invalidation and discards late responses after scope replacement", async (t) => {
    const { store, state, socket } = await fixture(t);
    state.rows = []; state.reset = true;
    socket.change(); t.mock.timers.tick(120); await drain();
    assert.equal(state.bootstraps, 2);
    assert.equal(store.find("notes").length, 0);
    let release!: () => void;
    state.hold = new Promise((resolve) => { release = resolve; });
    const running = store.sync(); await drain();
    await store.setActive(false);
    const changeScope = store.setScope("other-user");
    state.events = [{ resource: "notes", record_id: "secret", sequence: 2, operation: "INSERT", after: { id: "secret" }, event_id: "e2", origin: "test", committed_at: 1, schema_version: 1 }];
    state.cursor = 2; state.hold = undefined; release();
    await Promise.all([running, changeScope]); await drain();
    assert.equal(store.find("notes").length, 0);
    assert.equal(store.status.cursor, 0);
  });

  it("retains subscriptions after timeout and ignores acknowledgments from previous authentication epochs", async (t) => {
    const { client, socket } = await fixture(t, ["notes"], false);
    let statuses: readonly SubscriptionStatus[] = [];
    client.onSubscriptionStatus((next) => { statuses = next; });
    t.mock.timers.tick(5000); await drain();
    assert.equal(statuses[0].status, "error");
    socket.ack("notes");
    assert.equal(statuses[0].status, "ready", "a still-current late ack restores health");
    const oldId = socket.sent.filter((frame) => frame.type === "subscribe").at(-1)!.requestId;
    client.setToken("new-token");
    socket.message({ type: "subscribed", table: "notes", requestId: oldId });
    assert.equal(statuses[0].status, "pending");
    socket.ack("notes");
    assert.equal(statuses[0].status, "ready");
    socket.message({ type: "error", code: "AUTH_ERROR" });
    assert.equal(statuses[0].status, "error");
    client.setToken("renewed-token"); socket.ack("notes");
    assert.equal(statuses[0].status, "ready");
  });
});
