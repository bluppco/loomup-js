import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createClient, MemorySyncStorage, SyncStore, type SubscriptionStatus } from "../index.js";

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  closeCalls = 0;
  onopen?: (event: unknown) => void;
  onclose?: (event: unknown) => void;
  onmessage?: (event: { data: string }) => void;
  sent: Array<Record<string, unknown>> = [];
  constructor() { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.onopen?.({}); }
  close() { this.closeCalls++; this.readyState = 3; this.onclose?.({}); }
  message(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
  subscription(table: string) {
    return this.sent.filter((frame) => frame.type === "subscribe" && frame.table === table).at(-1)!;
  }
  ack(table: string) {
    this.message({ type: "subscribed", table, requestId: this.subscription(table).requestId });
  }
}

async function drain() { for (let index = 0; index < 40; index++) await Promise.resolve(); }

function fixture(t: TestContext, options: {
  online?: boolean; heartbeat?: boolean; browser?: boolean; navigator?: boolean; resync?: boolean;
} = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  t.mock.method(Math, "random", () => 0.5);
  Socket.instances = [];
  const network = { onLine: options.online ?? true };
  const runtime = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const listeners = new Map<string, Set<() => void>>();
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const replace = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  replace("navigator", options.navigator === false ? undefined : network);
  replace("document", options.browser === false ? undefined : document);
  replace("addEventListener", options.browser === false ? undefined : (type: string, listener: () => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(listener);
    runtime.addEventListener(type, listener);
  });
  replace("removeEventListener", options.browser === false ? undefined : (type: string, listener: () => void) => {
    listeners.get(type)?.delete(listener);
    runtime.removeEventListener(type, listener);
  });
  const state = { reads: 0, subscriptions: [] as readonly SubscriptionStatus[] };
  t.mock.method(globalThis, "fetch", async () => {
    state.reads++;
    return Response.json({ data: [], meta: { total: 0 } });
  });
  const client = createClient({
    url: "https://realtime.test", token: "old-token",
    realtimeHeartbeat: options.heartbeat === false ? false : { intervalMs: 1000, timeoutMs: 500, staleAfterMs: 2000 },
    realtimeResync: options.resync ?? false,
    WebSocketImpl: Socket as unknown as typeof WebSocket,
  });
  client.onSubscriptionStatus((statuses) => { state.subscriptions = statuses; });
  t.after(() => {
    client.closeRealtime();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const online = () => { network.onLine = true; runtime.dispatchEvent(new Event("online")); };
  const offline = () => { network.onLine = false; runtime.dispatchEvent(new Event("offline")); };
  const resume = () => {
    runtime.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
  };
  return { client, network, runtime, document, listeners, state, online, offline, resume };
}

describe("browser realtime connectivity", () => {
  for (const heartbeat of [true, false]) {
    it(`defers offline startup and opens once on online (heartbeat=${heartbeat})`, (t) => {
      const { client, online, resume, state } = fixture(t, { online: false, heartbeat });
      client.from("notes").subscribe(() => {});
      client.from("notes").subscribe(() => {});
      client.from("tasks").subscribe(() => {});
      assert.equal(Socket.instances.length, 0);
      assert.equal(client.realtimeStatus, "stale");
      t.mock.timers.tick(60_000);
      resume();
      assert.equal(Socket.instances.length, 0);
      online(); online(); resume();
      assert.equal(Socket.instances.length, 1);
      const socket = Socket.instances[0];
      assert.equal(socket.closeCalls, 0);
      socket.open(); socket.ack("notes"); socket.ack("tasks");
      assert.equal(socket.sent.filter((frame) => frame.type === "auth").length, 1);
      assert.equal(socket.sent.filter((frame) => frame.type === "subscribe").length, 2);
      assert.ok(state.subscriptions.every((subscription) => subscription.status === "ready"));
      assert.equal(client.realtimeStatus, "live");
      if (!heartbeat) {
        resume(); online(); t.mock.timers.tick(60_000);
        assert.equal(socket.sent.filter((frame) => frame.type === "ping").length, 0);
        assert.equal(Socket.instances.length, 1);
      }
    });
  }

  it("retires an open socket, pauses all transport timers, and restores subscriptions once", async (t) => {
    const { client, offline, online, resume, state } = fixture(t, { resync: true });
    let changes = 0;
    client.from("notes").subscribe(() => { changes++; });
    client.from("tasks").subscribe(() => {});
    const old = Socket.instances[0];
    old.open(); old.ack("notes");
    old.message({ type: "error", requestId: old.subscription("tasks").requestId, code: "SUBSCRIBE_ERROR" });
    t.mock.timers.tick(1000); // Pending pong timeout and subscription retry.
    const ping = old.sent.find((frame) => frame.type === "ping")!;
    assert.ok(ping);
    offline(); offline();
    assert.equal(old.closeCalls, 1);
    assert.equal(client.realtimeStatus, "stale");
    assert.ok(state.subscriptions.every((subscription) => subscription.status === "pending"));
    const sent = old.sent.length;
    t.mock.timers.tick(120_000); await drain();
    resume();
    assert.equal(Socket.instances.length, 1);
    assert.equal(old.sent.length, sent);
    assert.equal(state.reads, 0);
    client.setToken("new-token");
    online(); online(); resume();
    assert.equal(Socket.instances.length, 2);
    const replacement = Socket.instances[1];
    replacement.open(); replacement.ack("notes"); replacement.ack("tasks");
    old.open(); old.close(); old.ack("notes");
    old.message({ type: "pong", requestId: ping.requestId });
    old.message({ type: "change", table: "notes", id: "n1", op: "UPDATE", ts: 1 });
    await drain();
    assert.equal(changes, 0, "retired socket events cannot reach subscribers");
    assert.deepEqual(replacement.sent.filter((frame) => frame.type === "auth"), [{ type: "auth", token: "new-token" }]);
    assert.equal(replacement.sent.filter((frame) => frame.type === "subscribe").length, 2);
    assert.equal(state.reads, 2, "one catch-up per subscribed table");
    assert.equal(Socket.instances.length, 2);
    assert.equal(client.realtimeStatus, "live");
    assert.ok(state.subscriptions.every((subscription) => subscription.status === "ready"));
  });

  it("cancels pending backoff offline and resumes immediately without resetting failure backoff", (t) => {
    const { client, offline, online, resume } = fixture(t, { heartbeat: false });
    client.from("notes").subscribe(() => {});
    Socket.instances[0].close();
    t.mock.timers.tick(500);
    Socket.instances[1].close();
    t.mock.timers.tick(1000);
    Socket.instances[2].close(); // Next attempt would wait 2000 ms.
    offline(); t.mock.timers.tick(120_000); resume();
    assert.equal(Socket.instances.length, 3);
    online();
    assert.equal(Socket.instances.length, 4, "online bypasses the old retry delay");
    Socket.instances[3].close();
    resume(); // Ordinary page resume does not bypass server-failure backoff.
    t.mock.timers.tick(3999);
    assert.equal(Socket.instances.length, 4);
    t.mock.timers.tick(1);
    assert.equal(Socket.instances.length, 5);
  });

  it("online cancels an existing backoff even if the offline event was missed", (t) => {
    const { client, online, resume } = fixture(t);
    client.from("notes").subscribe(() => {});
    Socket.instances[0].close();
    t.mock.timers.tick(100);
    online(); online(); resume();
    assert.equal(Socket.instances.length, 2);
    t.mock.timers.tick(500);
    assert.equal(Socket.instances.length, 2, "old timer cannot create another attempt");
    assert.equal(Socket.instances[1].closeCalls, 0);
  });

  it("rechecks connectivity when a backoff timer fires before offline is dispatched", (t) => {
    const { client, network, online } = fixture(t);
    client.from("notes").subscribe(() => {});
    Socket.instances[0].close();
    network.onLine = false;
    t.mock.timers.tick(500);
    assert.equal(Socket.instances.length, 1);
    assert.equal(client.realtimeStatus, "stale");
    t.mock.timers.tick(120_000);
    assert.equal(Socket.instances.length, 1);
    online();
    assert.equal(Socket.instances.length, 2);
  });

  it("does not schedule retries when close arrives before the offline event", (t) => {
    const { client, network, online } = fixture(t);
    client.from("notes").subscribe(() => {});
    network.onLine = false;
    Socket.instances[0].close();
    assert.equal(client.realtimeStatus, "stale");
    t.mock.timers.tick(120_000);
    assert.equal(Socket.instances.length, 1);
    online();
    assert.equal(Socket.instances.length, 2);
  });

  it("retires a connecting socket offline and ignores a late open", (t) => {
    const { client, offline, online } = fixture(t);
    client.from("notes").subscribe(() => {});
    const old = Socket.instances[0];
    offline(); old.open();
    assert.equal(old.sent.length, 0);
    assert.equal(old.closeCalls, 1);
    online();
    assert.equal(Socket.instances.length, 2);
    Socket.instances[1].open(); Socket.instances[1].ack("notes");
    assert.equal(client.realtimeStatus, "live");
  });

  it("does not authenticate or subscribe if open races ahead of the offline event", (t) => {
    const { client, network, online } = fixture(t);
    client.from("notes").subscribe(() => {});
    const old = Socket.instances[0];
    network.onLine = false; old.open();
    assert.equal(old.sent.length, 0);
    assert.equal(old.closeCalls, 1);
    assert.equal(client.realtimeStatus, "stale");
    online();
    assert.equal(Socket.instances.length, 2);
  });

  it("still recovers a stalled connecting socket on resume without churning fresh attempts", (t) => {
    const { client, resume } = fixture(t);
    client.from("notes").subscribe(() => {});
    resume();
    assert.equal(Socket.instances[0].closeCalls, 0);
    t.mock.timers.tick(2000); resume();
    assert.equal(Socket.instances[0].closeCalls, 1);
    t.mock.timers.tick(500); resume();
    assert.equal(Socket.instances.length, 2);
    assert.equal(Socket.instances[1].closeCalls, 0);
  });

  it("coalesces healthy resume probes without extending the pending pong deadline", (t) => {
    const { client, resume, online } = fixture(t);
    client.from("notes").subscribe(() => {});
    const socket = Socket.instances[0];
    socket.open(); socket.ack("notes");
    resume(); t.mock.timers.tick(300); online(); resume();
    assert.equal(socket.sent.filter((frame) => frame.type === "ping").length, 1);
    t.mock.timers.tick(200);
    assert.equal(socket.closeCalls, 1, "repeated resume cannot hide a missed pong");
  });

  for (const cleanup of ["close", "unsubscribe"] as const) {
    it(`removes lifecycle listeners on ${cleanup} offline and allows a later fresh subscription`, (t) => {
      const { client, offline, online, resume, listeners } = fixture(t, { heartbeat: false });
      const unsubscribe = client.from("notes").subscribe(() => {});
      offline();
      if (cleanup === "close") client.closeRealtime();
      else unsubscribe();
      assert.ok([...listeners.values()].every((handlers) => handlers.size === 0));
      online(); resume(); t.mock.timers.tick(120_000);
      assert.equal(Socket.instances.length, 1);
      assert.equal(client.reconnectEnabled, false);
      offline(); client.from("tasks").subscribe(() => {});
      assert.equal(Socket.instances.length, 1);
      online(); resume();
      assert.equal(Socket.instances.length, 2);
      const socket = Socket.instances[1];
      socket.open();
      assert.deepEqual(socket.sent.filter((frame) => frame.type === "subscribe").map((frame) => frame.table), ["tasks"]);
      assert.ok([...listeners.values()].every((handlers) => handlers.size === 1));
    });
  }

  it("keeps subscribeReady deadlines finite while offline", async (t) => {
    const { client, online, listeners } = fixture(t, { online: false });
    const ready = client.from("notes").subscribeReady(() => {}, undefined, 1000);
    const rejected = assert.rejects(ready, /subscribe acknowledgement timeout/);
    t.mock.timers.tick(1000); await rejected;
    assert.ok([...listeners.values()].every((handlers) => handlers.size === 0));
    online();
    assert.equal(Socket.instances.length, 0);
  });

  it("does not resurrect the connection if an online-resume observer disposes the client", (t) => {
    const { client, online } = fixture(t);
    client.from("notes").subscribe(() => {});
    Socket.instances[0].close();
    client.onRealtimeStatus((status) => { if (status === "stale") client.closeRealtime(); });
    online(); t.mock.timers.tick(60_000);
    assert.equal(Socket.instances.length, 1);
    assert.equal(client.reconnectEnabled, false);
  });

  it("performs one cursor catch-up after the app's offline subscription-readiness gate", async (t) => {
    const { client, offline, online, resume } = fixture(t, { heartbeat: false });
    let pulls = 0;
    let tableReads = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("bootstrap")) {
        return Response.json({ data: { protocol_version: 1, schema_version: "s1", cursor: 462,
          resources: { notes: { records: [] }, tasks: { records: [] } } } });
      }
      if (url.pathname.endsWith("pull")) {
        pulls++;
        assert.equal(url.searchParams.get("cursor"), "462");
        return Response.json({ data: { protocol_version: 1, schema_version: "s1", cursor: 462,
          events: [], has_more: false } });
      }
      tableReads++;
      return Response.json({ data: [], meta: { total: 0 } });
    });
    const store = await SyncStore.open(client, { resources: ["notes", "tasks"],
      storage: new MemorySyncStorage(), online: false, pollIntervalMs: 15_000, reconcileIntervalMs: 300_000 });
    t.after(() => store.close());
    Socket.instances[0].open(); Socket.instances[0].ack("notes"); Socket.instances[0].ack("tasks");
    await store.setOnline(true);
    await store.setOnline(false);
    offline(); pulls = 0;
    t.mock.timers.tick(120_000); await drain();
    assert.equal(pulls, 0);
    online(); online(); resume();
    assert.equal(Socket.instances.length, 2);
    const socket = Socket.instances[1];
    socket.open(); socket.ack("notes"); await drain();
    assert.equal(store.status.realtime, "degraded");
    assert.equal(pulls, 0);
    socket.ack("tasks");
    assert.equal(store.status.realtime, "live");
    await store.setOnline(true); await drain();
    t.mock.timers.tick(60_000); await drain();
    assert.equal(pulls, 1);
    assert.equal(tableReads, 0, "SyncStore owns catch-up; legacy REST resync stays disabled");
    assert.equal(Socket.instances.length, 2);
  });

  it("can acknowledge an offline subscribeReady once connectivity returns", async (t) => {
    const { client, online } = fixture(t, { online: false });
    const ready = client.from("notes").subscribeReady(() => {});
    online();
    const socket = Socket.instances[0];
    socket.open(); socket.ack("notes");
    const unsubscribe = await ready;
    assert.equal(socket.sent.filter((frame) => frame.type === "subscribe").length, 1);
    unsubscribe();
    assert.equal(socket.closeCalls, 1);
  });

  for (const options of [{ browser: false, online: false }, { navigator: false }]) {
    it(`preserves retry behavior without browser connectivity APIs (${JSON.stringify(options)})`, (t) => {
      const { client } = fixture(t, options);
      client.from("notes").subscribe(() => {});
      assert.equal(Socket.instances.length, 1);
      Socket.instances[0].close();
      t.mock.timers.tick(499);
      assert.equal(Socket.instances.length, 1);
      t.mock.timers.tick(1);
      assert.equal(Socket.instances.length, 2);
    });
  }
});
