/**
 * Unit tests for the SDK that drive real shipped code paths (not pure shape checks).
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  createClient,
  createProject,
  encodeObjectPath,
  LoomupClient,
  LoomupError,
  indexedDbSyncStorage,
  makeSubKey,
  parseSubKey,
} from "../index.js";

describe("createClient", () => {
  it("stores url and optional token", () => {
    const c = createClient({ url: "http://localhost:3000/", token: "abc" });
    assert.equal(c.url, "http://localhost:3000");
    assert.equal(c.accessToken, "abc");
    assert.ok(c instanceof LoomupClient);
  });

  it("from(table) returns query builder with CRUD methods", () => {
    const c = createClient({ url: "http://127.0.0.1:3000" });
    const q = c.from("todos");
    assert.equal(typeof q.select, "function");
    assert.equal(typeof q.insert, "function");
    assert.equal(typeof q.update, "function");
    assert.equal(typeof q.delete, "function");
    assert.equal(typeof q.subscribe, "function");
    assert.equal(typeof q.subscribeReady, "function");
    assert.equal(typeof c.auth.signUp, "function");
    assert.equal(typeof c.auth.signIn, "function");
    assert.equal(typeof c.auth.login, "function");
    assert.equal(typeof c.auth.register, "function");
    assert.equal(typeof c.auth.logout, "function");
    assert.equal(typeof c.auth.refresh, "function");
    assert.equal(typeof c.users.find, "function");
    assert.equal(typeof c.users.get, "function");
    assert.equal(typeof c.files.from("avatars").find, "function");
    assert.equal(typeof c.files.from("avatars").create, "function");
  });

  it("select encodes boolean where filters as 0/1", async () => {
    const urls: string[] = [];
    const g = globalThis as { fetch?: typeof fetch };
    const prev = g.fetch;
    g.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ data: [], meta: { limit: 10, offset: 0, total: 0 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const c = createClient({ url: "http://localhost:3000" });
      await c.from("todos").select({ where: { completed: true }, limit: 5 });
      assert.ok(urls[0]?.includes("where%5Bcompleted%5D=1") || urls[0]?.includes("where[completed]=1"), urls[0]);
      urls.length = 0;
      await c.from("todos").select({ where: { completed: false } });
      assert.ok(urls[0]?.includes("where%5Bcompleted%5D=0") || urls[0]?.includes("where[completed]=0"), urls[0]);
    } finally {
      if (prev) g.fetch = prev;
      else delete g.fetch;
    }
  });

  it("routes object record keys through the composite-key endpoint", async () => {
    const calls: { method: string; url: string }[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(input) });
      return new Response(
        JSON.stringify({ data: { project_id: "p1", user_id: "u1", role: "member" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const client = createClient({ url: "http://localhost:3000" });
      const key = { user_id: "u1", project_id: "p1" };
      await client.from("project_members").get(key);
      await client.from("project_members").update(key, { role: "owner" });
      await client.from("project_members").delete(key);
      assert.deepEqual(
        calls.map((call) => call.method),
        ["GET", "PATCH", "DELETE"],
      );
      assert.ok(calls.every((call) => call.url.includes("/api/project_members/_loomup/key?")));
      assert.ok(calls.every((call) => call.url.includes("project_id=p1")));
      assert.ok(calls.every((call) => call.url.includes("user_id=u1")));
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("LoomupError carries code", () => {
    const e = new LoomupError("nope", "forbidden", 403);
    assert.equal(e.code, "forbidden");
    assert.equal(e.status, 403);
  });

  it("IndexedDB sync storage fails clearly outside a browser", () => {
    if (!(globalThis as { indexedDB?: unknown }).indexedDB) {
      assert.throws(() => indexedDbSyncStorage(), /IndexedDB is not available/);
    }
  });

  it("REST-only createClient does not require WebSocket", async () => {
    const g = globalThis as { WebSocket?: unknown };
    const hadWs = "WebSocket" in globalThis;
    const prev = g.WebSocket;
    // Simulate Node without global WebSocket
    delete g.WebSocket;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          data: {
            access_token: "a",
            refresh_token: "r",
            token_type: "Bearer",
            expires_in: 60,
            user: {
              id: "u1",
              email: "a@b.com",
              role: "user",
              disabled: false,
              created_at: 1,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      // Construct must not throw no_websocket
      const c = createClient({ url: "http://example.test" });
      const tokens = await c.signIn({ email: "a@b.com", password: "secret12" });
      assert.equal(tokens.access_token, "a");
      assert.equal(c.accessToken, "a");
    } finally {
      globalThis.fetch = originalFetch;
      if (hadWs && prev !== undefined) {
        g.WebSocket = prev;
      }
    }
  });
});

describe("resource facade", () => {
  type Tables = { todos: { id: number; title: string } };
  type Inserts = { todos: { title: string } };
  type Updates = { todos: { title?: string } };

  interface GeneratedTables {
    todos: { id: string; title: string };
  }
  interface GeneratedInserts {
    todos: { id?: string; title: string };
  }
  interface GeneratedUpdates {
    todos: { title?: string };
  }

  // Compile-time regression: generated interfaces intentionally have no
  // catch-all string index signature.
  const generatedProject = createProject<
    GeneratedTables,
    GeneratedInserts,
    GeneratedUpdates
  >({ url: "http://example.test" });
  const generatedResource = generatedProject.todos;
  void generatedResource;

  it("supports generated property access and domain CRUD verbs", async () => {
    const calls: { method: string; url: string }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(input) });
      const method = init?.method ?? "GET";
      const data = method === "GET" ? [] : { id: 1, title: "resource" };
      return new Response(
        JSON.stringify({ data, meta: { limit: 100, offset: 0, total: 0 } }),
        { status: method === "POST" ? 201 : 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const project = createProject<Tables, Inserts, Updates>({
        url: "http://example.test",
      });
      assert.equal(project.todos, project.todos, "resource proxies should be stable");
      assert.equal(project.todos.name, "todos");
      assert.equal(project.resource("todos").name, "todos");
      await project.todos.find();
      assert.deepEqual(await project.todos.list(), []);
      await project.todos.create({ title: "resource" });
      await project.todos.update(1, { title: "updated" });
      await project.todos.remove(1);
      await project.todos.delete(1);
      assert.deepEqual(
        calls.map((call) => call.method),
        ["GET", "GET", "POST", "PATCH", "DELETE", "DELETE"],
      );
      assert.ok(calls.every((call) => call.url.includes("/api/todos")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("exposes history, point-in-time state, and permissions on one resource", async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/history")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                sequence: 9,
                event_id: "e9",
                resource: "todos",
                record_id: "1",
                operation: "UPDATE",
                before: { id: 1, title: "before" },
                after: { id: 1, title: "after" },
                origin: "loomup",
                schema_version: 1,
                committed_at: 10,
              },
            ],
            meta: { limit: 10, next_before_sequence: 9 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/at?")) {
        return new Response(
          JSON.stringify({
            data: {
              record: { id: 1, title: "before" },
              sequence: 8,
              event_id: "e8",
              committed_at: 9,
              schema_version: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            read: true,
            create: true,
            update: true,
            delete: true,
            subscribe: true,
            history: true,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const project = createProject<Tables, Inserts, Updates>({
        url: "http://example.test",
      });
      const history = await project.todos.history(1, {
        beforeSequence: 10,
        limit: 10,
      });
      const state = await project.todos.at(1, { sequence: 8 });
      const permissions = await project.todos.permissions(1);
      assert.equal(history.data[0]?.after?.title, "after");
      assert.equal(state.record.title, "before");
      assert.equal(permissions.history, true);
      assert.ok(calls[0]?.includes("before_sequence=10"), calls[0]);
      assert.ok(calls[1]?.includes("sequence=8"), calls[1]);
      assert.ok(calls[2]?.endsWith("/permissions"), calls[2]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("opens a race-free live collection and merges events", async () => {
    let ws: FakeProjectWs | undefined;
    class FakeProjectWs {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = FakeProjectWs.CONNECTING;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onclose: ((ev: unknown) => void) | null = null;
      constructor(public url: string) {
        ws = this;
        queueMicrotask(() => {
          this.readyState = FakeProjectWs.OPEN;
          this.onopen?.({});
        });
      }
      send(raw: string) {
        const frame = JSON.parse(raw) as { type: string; requestId?: string };
        if (frame.type === "subscribe") {
          queueMicrotask(() =>
            this.onmessage?.({
              data: JSON.stringify({
                type: "subscribed",
                table: "todos",
                requestId: frame.requestId,
              }),
            }),
          );
        }
      }
      close() {
        this.readyState = FakeProjectWs.CLOSED;
        this.onclose?.({});
      }
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 1, title: "initial" }],
          meta: { limit: 100, offset: 0, total: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    try {
      const project = createProject<Tables, Inserts, Updates>({
        url: "http://example.test",
        WebSocketImpl: FakeProjectWs as unknown as typeof WebSocket,
      });
      const live = await project.todos.live({ strategy: "merge" });
      assert.deepEqual(live.data, [{ id: 1, title: "initial" }]);
      let observed = 0;
      const off = live.onChange((snapshot) => {
        observed = snapshot.data.length;
      });
      ws?.onmessage?.({
        data: JSON.stringify({
          type: "change",
          table: "todos",
          channel: "todos",
          op: "INSERT",
          id: "2",
          sequence: 2,
          data: { id: 2, title: "live" },
          ts: 1,
        }),
      });
      assert.equal(observed, 2);
      assert.equal(live.data[1]?.title, "live");
      off();
      live.close();
      project.closeRealtime();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("onTokens and setSession", () => {
  it("onTokens fires on signIn, refresh, and signOut(null)", async () => {
    const seen: (null | { access: string; refresh: string })[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return new Response(
          JSON.stringify({
            data: {
              access_token: "a1",
              refresh_token: "r1",
              token_type: "Bearer",
              expires_in: 60,
              user: {
                id: "u1",
                email: "a@b.com",
                role: "user",
                disabled: false,
                created_at: 1,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/auth/refresh")) {
        return new Response(
          JSON.stringify({
            data: {
              access_token: "a2",
              refresh_token: "r2",
              token_type: "Bearer",
              expires_in: 60,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/auth/logout")) {
        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      void init;
      return new Response("nope", { status: 500 });
    }) as typeof fetch;

    try {
      const c = createClient({
        url: "http://example.test",
        onTokens: (t) => {
          if (t === null) seen.push(null);
          else seen.push({ access: t.access_token, refresh: t.refresh_token });
        },
      });
      await c.auth.signIn({ email: "a@b.com", password: "secret12" });
      assert.deepEqual(seen[0], { access: "a1", refresh: "r1" });
      await c.auth.refresh();
      assert.deepEqual(seen[1], { access: "a2", refresh: "r2" });
      await c.auth.signOut();
      assert.equal(seen[2], null);
      assert.equal(c.accessToken, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("setSession updates tokens and invokes onTokens", () => {
    const seen: string[] = [];
    const c = createClient({
      url: "http://example.test",
      onTokens: (t) => {
        if (t) seen.push(t.access_token);
      },
    });
    c.setSession({ access_token: "ax", refresh_token: "rx", expires_in: 90 });
    assert.equal(c.accessToken, "ax");
    assert.equal(c.refreshTokenValue, "rx");
    assert.deepEqual(seen, ["ax"]);
  });
});

describe("request auto refresh/retry", () => {
  it("on 401 refreshes once and retries the original request", async () => {
    const calls: { url: string; method: string; auth?: string }[] = [];
    let access = "old-access";
    const refreshTok = "refresh-1";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      calls.push({ url, method, auth });

      if (url.endsWith("/auth/refresh")) {
        access = "new-access";
        return new Response(
          JSON.stringify({
            data: {
              access_token: access,
              refresh_token: "refresh-2",
              token_type: "Bearer",
              expires_in: 900,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/auth/me")) {
        if (auth === "Bearer old-access") {
          return new Response(
            JSON.stringify({ error: { code: "unauthorized", message: "expired" } }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }
        if (auth === "Bearer new-access") {
          return new Response(
            JSON.stringify({
              data: {
                id: "u1",
                email: "a@b.com",
                role: "user",
                disabled: false,
                created_at: 1,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const c = createClient({
        url: "http://example.test",
        token: access,
        refreshToken: refreshTok,
      });
      const me = await c.me();
      assert.equal(me.email, "a@b.com");
      assert.equal(c.accessToken, "new-access");
      // First /auth/me (401), then /auth/refresh, then retry /auth/me (200).
      assert.ok(calls.some((x) => x.url.endsWith("/auth/refresh")));
      const meCalls = calls.filter((x) => x.url.endsWith("/auth/me"));
      assert.equal(meCalls.length, 2);
      assert.equal(meCalls[0].auth, "Bearer old-access");
      assert.equal(meCalls[1].auth, "Bearer new-access");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("manual refresh updates tokens via shipped refresh()", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/refresh")) {
        return new Response(
          JSON.stringify({
            data: {
              access_token: "a2",
              refresh_token: "r2",
              token_type: "Bearer",
              expires_in: 60,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    try {
      const c = createClient({
        url: "http://example.test",
        refreshToken: "r1",
      });
      const tokens = await c.refresh();
      assert.equal(tokens.access_token, "a2");
      assert.equal(c.accessToken, "a2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("can refresh through a framework-owned httpOnly session", async () => {
    const originalFetch = globalThis.fetch;
    const authHeaders: Array<string | null> = [];
    let providerCalls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      authHeaders.push(authorization);
      if (authorization === "Bearer expired") {
        return new Response(JSON.stringify({ error: { message: "expired" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: [], meta: { limit: 50, offset: 0, total: 0 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const client = createClient({
        url: "https://project.example",
        token: "expired",
        accessTokenProvider: async () => {
          providerCalls += 1;
          return "fresh";
        },
      });
      await client.from("issues").select();
      assert.equal(providerCalls, 1);
      assert.deepEqual(authHeaders, ["Bearer expired", "Bearer fresh"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("WebSocketImpl injection", () => {
  it("uses injected WebSocket constructor (no global required)", () => {
    let constructed = false;
    let constructedUrl = "";
    class FakeWs {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = FakeWs.CONNECTING;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: unknown) => void) | null = null;
      onclose: ((ev: unknown) => void) | null = null;
      constructor(public url: string) {
        constructed = true;
        constructedUrl = url;
        queueMicrotask(() => {
          this.readyState = FakeWs.OPEN;
          this.onopen?.({});
        });
      }
      send(_data: string) {}
      close() {
        this.readyState = FakeWs.CLOSED;
        this.onclose?.({});
      }
    }
    const c = createClient({
      url: "https://cloud.example.test/p/project-1",
      WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    });
    // Construct alone must not open WS
    assert.equal(constructed, false);
    const unsub = c.from("todos").subscribe(() => {});
    assert.equal(constructed, true);
    assert.equal(
      constructedUrl,
      "wss://cloud.example.test/p/project-1/realtime",
    );
    unsub();
    c.closeRealtime();
  });

  it("surfaces generic error control frames with code", async () => {
    const controls: { type: string; message?: string; code?: string }[] = [];
    let messageHandler: ((ev: { data: string }) => void) | null = null;
    class FakeWs {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = FakeWs.CONNECTING;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: unknown) => void) | null = null;
      onclose: ((ev: unknown) => void) | null = null;
      constructor(public url: string) {
        queueMicrotask(() => {
          this.readyState = FakeWs.OPEN;
          this.onopen?.({});
          messageHandler = (ev) => this.onmessage?.(ev);
          // Server uses generic error frame with code (not ad-hoc auth_error types).
          this.onmessage?.({
            data: JSON.stringify({
              type: "error",
              code: "AUTH_ERROR",
              message: "invalid or expired token",
            }),
          });
          this.onmessage?.({
            data: JSON.stringify({
              type: "error",
              code: "SUBSCRIBE_ERROR",
              table: "todos",
              message: "subscribe forbidden",
            }),
          });
        });
      }
      send(_data: string) {}
      close() {
        this.readyState = FakeWs.CLOSED;
        this.onclose?.({});
      }
    }
    void messageHandler;
    const c = createClient({
      url: "http://localhost:3000",
      WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    });
    c.onControl((ev) =>
      controls.push({ type: ev.type, message: ev.message, code: (ev as { code?: string }).code }),
    );
    const unsub = c.from("todos").subscribe(() => {});
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(controls.some((x) => x.type === "error" && x.code === "AUTH_ERROR"));
    assert.ok(controls.some((x) => x.type === "error" && x.code === "SUBSCRIBE_ERROR"));
    unsub();
    c.closeRealtime();
  });

  it("setToken reauthenticates and resubscribes open socket", async () => {
    const sent: string[] = [];
    class FakeWs {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = FakeWs.CONNECTING;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: unknown) => void) | null = null;
      onclose: ((ev: unknown) => void) | null = null;
      constructor(public url: string) {
        queueMicrotask(() => {
          this.readyState = FakeWs.OPEN;
          this.onopen?.({});
        });
      }
      send(data: string) {
        sent.push(data);
      }
      close() {
        this.readyState = FakeWs.CLOSED;
        this.onclose?.({});
      }
    }
    const c = createClient({
      url: "http://localhost:3000",
      token: "old-token",
      WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    });
    const unsub = c.from("todos").subscribe(() => {}, "1");
    await new Promise((r) => setTimeout(r, 20));
    sent.length = 0;
    c.setToken("new-token");
    await new Promise((r) => setTimeout(r, 10));
    const frames = sent.map((s) => JSON.parse(s) as { type: string; token?: string });
    assert.ok(
      frames.some((m) => m.type === "auth" && m.token === "new-token"),
      `expected auth with new token, got ${JSON.stringify(frames)}`,
    );
    assert.ok(
      frames.some((m) => m.type === "subscribe" && m.token === "new-token"),
      `expected resubscribe with new token, got ${JSON.stringify(frames)}`,
    );
    unsub();
    c.closeRealtime();
  });

  it("row unsub sends id so other row subs stay", async () => {
    const sent: string[] = [];
    class FakeWs {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = FakeWs.OPEN;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: unknown) => void) | null = null;
      onclose: ((ev: unknown) => void) | null = null;
      constructor(public url: string) {
        queueMicrotask(() => this.onopen?.({}));
      }
      send(data: string) {
        sent.push(data);
      }
      close() {
        this.readyState = FakeWs.CLOSED;
        this.onclose?.({});
      }
    }
    const c = createClient({
      url: "http://localhost:3000",
      WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    });
    const u1 = c.from("todos").subscribe(() => {}, "1");
    const u2 = c.from("todos").subscribe(() => {}, "2");
    await new Promise((r) => setTimeout(r, 10));
    u1();
    await new Promise((r) => setTimeout(r, 10));
    const unsubs = sent
      .map((s) => JSON.parse(s) as { type: string; id?: string })
      .filter((m) => m.type === "unsubscribe");
    assert.ok(
      unsubs.some((m) => m.id === "1"),
      `expected row unsub with id: ${JSON.stringify(unsubs)}`,
    );
    u2();
    c.closeRealtime();
  });

  it("subscribe/unsub with injected WS works when global WebSocket is absent", async () => {
    const g = globalThis as { WebSocket?: unknown };
    const prev = g.WebSocket;
    delete g.WebSocket;

    const sent: string[] = [];
    class FakeWs {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = FakeWs.CONNECTING;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: unknown) => void) | null = null;
      onclose: ((ev: unknown) => void) | null = null;
      constructor(public url: string) {
        queueMicrotask(() => {
          this.readyState = FakeWs.OPEN;
          this.onopen?.({});
        });
      }
      send(data: string) {
        sent.push(data);
      }
      close() {
        this.readyState = FakeWs.CLOSED;
        this.onclose?.({});
      }
    }

    try {
      // Must not throw ReferenceError on WebSocket.OPEN when global is missing.
      const c = createClient({
        url: "http://localhost:3000",
        token: "tok",
        WebSocketImpl: FakeWs as unknown as typeof WebSocket,
      });
      const unsub = c.from("todos").subscribe(() => {}, "9");
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(
        sent.some((s) => {
          const m = JSON.parse(s) as { type: string };
          return m.type === "subscribe" || m.type === "auth";
        }),
        `expected outbound frames without throw, got: ${JSON.stringify(sent)}`,
      );
      unsub();
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(
        sent.some((s) => {
          const m = JSON.parse(s) as { type: string; id?: string };
          return m.type === "unsubscribe" && m.id === "9";
        }),
        `expected row unsub after delete global WS: ${JSON.stringify(sent)}`,
      );
      c.closeRealtime();
    } finally {
      if (prev !== undefined) g.WebSocket = prev;
    }
  });
});

describe("subscription keys with # in row id", () => {
  it("parseSubKey splits only on the first #", () => {
    assert.deepEqual(parseSubKey("todos"), { table: "todos" });
    assert.deepEqual(parseSubKey("todos#1"), { table: "todos", rowId: "1" });
    assert.deepEqual(parseSubKey("todos#a#b#c"), {
      table: "todos",
      rowId: "a#b#c",
    });
    assert.equal(makeSubKey("todos", "a#b"), "todos#a#b");
    assert.deepEqual(parseSubKey(makeSubKey("notes", "x#y")), {
      table: "notes",
      rowId: "x#y",
    });
  });

  it("reconnect resubscribes with full row id containing #", async () => {
    const sent: string[] = [];
    let instance: {
      readyState: number;
      onopen: ((ev: unknown) => void) | null;
      onclose: ((ev: unknown) => void) | null;
    } | null = null;
    class FakeWs {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = FakeWs.CONNECTING;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: unknown) => void) | null = null;
      onclose: ((ev: unknown) => void) | null = null;
      constructor(public url: string) {
        instance = this;
        queueMicrotask(() => {
          this.readyState = FakeWs.OPEN;
          this.onopen?.({});
        });
      }
      send(data: string) {
        sent.push(data);
      }
      close() {
        this.readyState = FakeWs.CLOSED;
        this.onclose?.({});
      }
    }
    const c = createClient({
      url: "http://localhost:3000",
      token: "tok1",
      WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    });
    const rowId = "prefix#with#hashes";
    const unsub = c.from("items").subscribe(() => {}, rowId);
    await new Promise((r) => setTimeout(r, 20));
    const firstSubs = sent
      .map((s) => JSON.parse(s) as { type: string; id?: string; table?: string })
      .filter((m) => m.type === "subscribe");
    assert.ok(
      firstSubs.some((m) => m.id === rowId && m.table === "items"),
      `expected subscribe with full row id, got ${JSON.stringify(firstSubs)}`,
    );
    // Simulate reconnect open path by calling onopen again (as ensureWs would).
    sent.length = 0;
    instance!.onopen?.({});
    await new Promise((r) => setTimeout(r, 20));
    const reSubs = sent
      .map((s) => JSON.parse(s) as { type: string; id?: string })
      .filter((m) => m.type === "subscribe");
    assert.ok(
      reSubs.some((m) => m.id === rowId),
      `reconnect must keep full row id with #: ${JSON.stringify(reSubs)}`,
    );
    unsub();
    c.closeRealtime();
  });
});

describe("token rotation re-auths active realtime subscriptions", () => {
  it("refresh applyTokens sends auth + resubscribe with new token", async () => {
    const sent: string[] = [];
    class FakeWs {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = FakeWs.OPEN;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: unknown) => void) | null = null;
      onclose: ((ev: unknown) => void) | null = null;
      constructor(public url: string) {
        queueMicrotask(() => {
          this.readyState = FakeWs.OPEN;
          this.onopen?.({});
        });
      }
      send(data: string) {
        sent.push(data);
      }
      close() {
        this.readyState = FakeWs.CLOSED;
        this.onclose?.({});
      }
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/refresh")) {
        return new Response(
          JSON.stringify({
            data: {
              access_token: "rotated-access",
              refresh_token: "rotated-refresh",
              token_type: "Bearer",
              expires_in: 900,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("nope", { status: 500 });
    }) as typeof fetch;

    try {
      const c = createClient({
        url: "http://example.test",
        token: "old-access",
        refreshToken: "r1",
        WebSocketImpl: FakeWs as unknown as typeof WebSocket,
      });
      const unsub = c.from("todos").subscribe(() => {}, "42");
      await new Promise((r) => setTimeout(r, 20));
      sent.length = 0;

      await c.refresh();
      assert.equal(c.accessToken, "rotated-access");
      await new Promise((r) => setTimeout(r, 10));

      const frames = sent.map((s) => JSON.parse(s) as {
        type: string;
        token?: string;
        id?: string;
        table?: string;
      });
      assert.ok(
        frames.some(
          (m) => m.type === "auth" && m.token === "rotated-access",
        ),
        `expected auth with new token after rotation: ${JSON.stringify(frames)}`,
      );
      assert.ok(
        frames.some(
          (m) =>
            m.type === "subscribe" &&
            m.token === "rotated-access" &&
            m.table === "todos" &&
            m.id === "42",
        ),
        `expected resubscribe with new token: ${JSON.stringify(frames)}`,
      );
      unsub();
      c.closeRealtime();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("reconnect resync", () => {
  it("after reconnect open, REST resync delivers RESYNC events to handlers", async () => {
    const events: { op: string; id: string; data?: unknown }[] = [];
    let openCount = 0;
    let wsInstance: {
      readyState: number;
      onopen: ((ev: unknown) => void) | null;
      onclose: ((ev: unknown) => void) | null;
    } | null = null;

    class FakeWs {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = FakeWs.CONNECTING;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: unknown) => void) | null = null;
      onclose: ((ev: unknown) => void) | null = null;
      constructor(public url: string) {
        wsInstance = this;
        openCount += 1;
        queueMicrotask(() => {
          this.readyState = FakeWs.OPEN;
          this.onopen?.({});
        });
      }
      send(_data: string) {}
      close() {
        this.readyState = FakeWs.CLOSED;
        this.onclose?.({});
      }
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/todos/7")) {
        return new Response(
          JSON.stringify({ data: { id: 7, title: "after-outage" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    try {
      const c = createClient({
        url: "http://example.test",
        token: "t",
        WebSocketImpl: FakeWs as unknown as typeof WebSocket,
      });
      const unsub = c.from("todos").subscribe((ev) => {
        events.push({ op: ev.op, id: ev.id, data: ev.data });
      }, "7");
      await new Promise((r) => setTimeout(r, 30));
      // First open must NOT resync (hasOpenedOnce was false).
      assert.equal(events.filter((e) => e.op === "RESYNC").length, 0);

      // Simulate drop + reconnect: close, then ensureWs via onclose path manually.
      // Force a second open by closing and constructing a new WS through ensureWs.
      wsInstance!.readyState = FakeWs.CLOSED;
      wsInstance!.onclose?.({});
      // Bypass 1s timer: call ensureWs by re-subscribing path — open hasOpenedOnce.
      // Directly invoke a second connection by closing intentional and reopening.
      // The client schedules reconnect after 1s; speed it up by calling subscribe's ensure.
      // We re-trigger open: create a new WS by ensuring the closed state and calling
      // from subscribe again is wrong; instead patch timer:
      await new Promise((r) => setTimeout(r, 1100));
      await new Promise((r) => setTimeout(r, 50));

      const resyncs = events.filter((e) => e.op === "RESYNC");
      assert.ok(
        resyncs.length >= 1,
        `expected RESYNC after reconnect, events=${JSON.stringify(events)} openCount=${openCount}`,
      );
      assert.equal(resyncs[0].id, "7");
      assert.deepEqual(resyncs[0].data, { id: 7, title: "after-outage" });
      unsub();
      c.closeRealtime();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("subscribeReady awaits server subscribed ack", () => {
  it("promise stays pending until subscribed frame for the requestId", async () => {
    type Handler = ((ev: unknown) => void) | null;
    const sent: string[] = [];
    const holders: { onmessage: Handler }[] = [];

    class FakeWs {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = FakeWs.CONNECTING;
      onopen: Handler = null;
      onmessage: Handler = null;
      onclose: Handler = null;
      constructor(_url: string) {
        holders.push(this);
        queueMicrotask(() => {
          this.readyState = FakeWs.OPEN;
          this.onopen?.({});
        });
      }
      send(data: string) {
        sent.push(data);
      }
      close() {
        this.readyState = FakeWs.CLOSED;
        this.onclose?.({});
      }
    }

    const c = createClient({
      url: "http://example.test",
      WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    });

    let resolved = false;
    const ready = c
      .from("todos")
      .subscribeReady(() => {})
      .then((unsub) => {
        resolved = true;
        return unsub;
      });

    // Wait until OPEN + subscribe frame sent, but before server ack.
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(resolved, false, "must not resolve before subscribed frame");
    assert.equal(
      sent.filter((frame) => frame.includes('"type":"subscribe"')).length,
      1,
      "subscribeReady must emit exactly one subscribe frame",
    );
    const lastSub = [...sent]
      .reverse()
      .find((s) => s.includes('"type":"subscribe"'));
    assert.ok(lastSub, `subscribe frame sent, got ${JSON.stringify(sent)}`);
    const parsed = JSON.parse(lastSub as string) as {
      requestId: string;
      table: string;
    };
    assert.equal(parsed.table, "todos");
    assert.ok(parsed.requestId);
    assert.ok(holders.length > 0, "ws constructed");

    // Emit subscribed with matching requestId.
    holders[0].onmessage?.({
      data: JSON.stringify({
        type: "subscribed",
        requestId: parsed.requestId,
        table: "todos",
        channel: "todos",
      }),
    });

    const unsub = await ready;
    assert.equal(resolved, true);
    assert.equal(sent.filter((frame) => frame.includes('"type":"subscribe"')).length, 1);
    unsub();
    c.closeRealtime();
  });

  it("rejects on subscribe acknowledgement timeout", async () => {
    class FakeWs {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = FakeWs.CONNECTING;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: unknown) => void) | null = null;
      onclose: ((ev: unknown) => void) | null = null;
      constructor(_url: string) {
        queueMicrotask(() => {
          this.readyState = FakeWs.OPEN;
          this.onopen?.({});
        });
      }
      send(_data: string) {}
      close() {
        this.readyState = FakeWs.CLOSED;
        this.onclose?.({});
      }
    }

    const c = createClient({
      url: "http://example.test",
      WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    });

    await assert.rejects(
      () => c.from("todos").subscribeReady(() => {}, undefined, 80),
      /subscribe acknowledgement timeout/,
    );
    // Timeout must not leave handlers registered (cleanup on failure).
    assert.equal((c as unknown as { subs: Map<string, Set<unknown>> }).subs?.size ?? 0, 0);
    c.closeRealtime();
  });

  it("rejects on server error frame and cleans up subscription", async () => {
    const sent: string[] = [];
    const holders: { onmessage: ((ev: unknown) => void) | null }[] = [];

    class FakeWs {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = FakeWs.CONNECTING;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: unknown) => void) | null = null;
      onclose: ((ev: unknown) => void) | null = null;
      constructor(_url: string) {
        holders.push(this);
        queueMicrotask(() => {
          this.readyState = FakeWs.OPEN;
          this.onopen?.({});
        });
      }
      send(data: string) {
        sent.push(data);
      }
      close() {
        this.readyState = FakeWs.CLOSED;
        this.onclose?.({});
      }
    }

    const c = createClient({
      url: "http://example.test",
      WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    });

    const ready = c.from("todos").subscribeReady(() => {});
    await new Promise((r) => setTimeout(r, 40));
    const lastSub = [...sent]
      .reverse()
      .find((s) => s.includes('"type":"subscribe"'));
    assert.ok(lastSub);
    const parsed = JSON.parse(lastSub as string) as { requestId: string };
    holders[0].onmessage?.({
      data: JSON.stringify({
        type: "error",
        code: "SUBSCRIBE_ERROR",
        requestId: parsed.requestId,
        message: "table not exposed or realtime disabled",
      }),
    });
    await assert.rejects(() => ready, /table not exposed|SUBSCRIBE_ERROR|subscribe failed/);
    c.closeRealtime();
  });
});

describe("storage API", () => {
  it("encodeObjectPath encodes segments but keeps slashes", () => {
    assert.equal(encodeObjectPath("a b/c"), "a%20b/c");
    assert.equal(encodeObjectPath("user-1/profile.png"), "user-1/profile.png");
  });

  it("storage.from exposes upload/download/list/remove", () => {
    const c = createClient({ url: "http://localhost:3000" });
    const b = c.storage.from("avatars");
    assert.equal(typeof b.upload, "function");
    assert.equal(typeof b.download, "function");
    assert.equal(typeof b.list, "function");
    assert.equal(typeof b.remove, "function");
    assert.equal(typeof b.createSignedUrl, "function");
    assert.equal(typeof c.storage.listBuckets, "function");
  });

  it("upload posts raw body with content-type and upsert header", async () => {
    const calls: { url: string; method: string; headers: Headers; body: string }[] = [];
    const g = globalThis as { fetch?: typeof fetch };
    const prev = g.fetch;
    g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? init.body : String(init?.body ?? ""),
      });
      return new Response(
        JSON.stringify({
          data: {
            id: "1",
            bucket: "avatars",
            path: "u/me.png",
            name: "me.png",
            size: 3,
            created_at: 1,
            updated_at: 1,
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const c = createClient({ url: "http://localhost:3000", token: "tok" });
      const meta = await c.storage.from("avatars").upload("u/me.png", "abc", {
        contentType: "image/png",
        upsert: true,
      });
      assert.equal(meta.path, "u/me.png");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, "POST");
      assert.ok(calls[0].url.includes("/storage/v1/avatars/object/u/me.png"), calls[0].url);
      assert.equal(calls[0].headers.get("content-type"), "image/png");
      assert.equal(calls[0].headers.get("x-loomup-upsert"), "true");
      assert.equal(calls[0].headers.get("authorization"), "Bearer tok");
      assert.equal(calls[0].body, "abc");
    } finally {
      if (prev) g.fetch = prev;
      else delete g.fetch;
    }
  });

  it("normalizeStorageUpload and downloadResponse work for server-style bytes", async () => {
    const { normalizeStorageUpload } = await import("../index.js");
    const n = normalizeStorageUpload(new Uint8Array([1, 2]), {
      contentType: "application/octet-stream",
    });
    assert.equal(n.contentType, "application/octet-stream");
    assert.ok(n.body);

    const g = globalThis as { fetch?: typeof fetch };
    const prev = g.fetch;
    g.fetch = (async () =>
      new Response(new Uint8Array([9, 9]), {
        status: 200,
        headers: { "Content-Type": "image/png", ETag: '"abc"' },
      })) as typeof fetch;
    try {
      const c = createClient({ url: "http://localhost:3000", token: "t" });
      const res = await c.storage.from("avatars").downloadResponse("x.png");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/png");
      const buf = new Uint8Array(await res.arrayBuffer());
      assert.deepEqual([...buf], [9, 9]);
    } finally {
      if (prev) g.fetch = prev;
      else delete g.fetch;
    }
  });

  it("download returns blob; list encodes prefix query", async () => {
    const urls: string[] = [];
    const g = globalThis as { fetch?: typeof fetch };
    const prev = g.fetch;
    g.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/object/")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      return new Response(
        JSON.stringify({
          data: [{ id: "1", bucket: "avatars", path: "a/x", name: "x", size: 1, created_at: 0, updated_at: 0 }],
          meta: { limit: 10, offset: 0, total: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const c = createClient({ url: "http://localhost:3000", token: "t" });
      const blob = await c.storage.from("avatars").download("a/x");
      assert.equal(blob.size, 3);
      const listed = await c.storage.from("avatars").list({ prefix: "a/", limit: 10 });
      assert.equal(listed.data.length, 1);
      assert.ok(
        urls.some((u) => u.includes("prefix=a%2F") || u.includes("prefix=a/")),
        urls.join(","),
      );
    } finally {
      if (prev) g.fetch = prev;
      else delete g.fetch;
    }
  });

  it("creates an absolute short-lived signed URL", async () => {
    const calls: { url: string; body: string }[] = [];
    const g = globalThis as { fetch?: typeof fetch };
    const prev = g.fetch;
    g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(
        JSON.stringify({
          data: {
            url: "/storage/v1/attachments/signed/a%20b/file.pdf?token=signed",
            expires_at: 123,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const client = createClient({ url: "https://project.example", token: "access" });
      const signed = await client.storage
        .from("attachments")
        .createSignedUrl("a b/file.pdf", 600);
      assert.equal(
        signed.url,
        "https://project.example/storage/v1/attachments/signed/a%20b/file.pdf?token=signed",
      );
      assert.equal(signed.expires_at, 123);
      assert.ok(calls[0].url.includes("/storage/v1/attachments/sign/a%20b/file.pdf"));
      assert.deepEqual(JSON.parse(calls[0].body), { expires_in: 600 });
    } finally {
      if (prev) g.fetch = prev;
      else delete g.fetch;
    }
  });
});

describe("identity import", () => {
  it("posts stable ids through the server-only client surface", async () => {
    const g = globalThis as { fetch?: typeof fetch };
    const prev = g.fetch;
    let request: { authorization: string | null; body: unknown } | undefined;
    g.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      request = {
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      };
      return new Response(
        JSON.stringify({
          data: [{
            id: "old-user-id",
            email: "old@example.com",
            role: "user",
            disabled: false,
            password_reset_required: true,
            created_at: 1,
          }],
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const client = createClient({
        url: "https://project.example",
        serviceKey: "loomup_sk_secret",
      });
      const users = await client.users.importForPasswordReset([
        { id: "old-user-id", email: "old@example.com" },
      ]);
      assert.equal(users[0].id, "old-user-id");
      assert.equal(users[0].password_reset_required, true);
      assert.equal(request?.authorization, "Bearer loomup_sk_secret");
      assert.deepEqual(request?.body, {
        users: [{ id: "old-user-id", email: "old@example.com" }],
      });
    } finally {
      if (prev) g.fetch = prev;
      else delete g.fetch;
    }
  });
});

// silence unused mock import when node:test version lacks it in types
void mock;
