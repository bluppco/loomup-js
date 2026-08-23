/**
 * Composable tests with a fake Loomup client surface.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createApp, defineComponent, nextTick, type App } from "vue";
import {
  LoomupPlugin,
  useLoomup,
  useAuth,
  useSelect,
  useSubscribe,
  useLiveQuery,
  useMutation,
  applyChangeToRows,
  rowIdFrom,
} from "../index.js";
import type { ChangeEvent, LoomupClient } from "@loomup/client";

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------

type Handler = (ev: ChangeEvent) => void;

function createFakeClient(overrides?: {
  accessToken?: string;
  selectData?: Record<string, unknown>[];
  meUser?: { id: string; email: string; role: string; disabled: boolean; created_at: number };
}) {
  const handlers = new Map<string, Set<Handler>>();
  let accessToken = overrides?.accessToken;
  let refreshToken: string | undefined;

  const tableApi = {
    select: mock.fn(async () => ({
      data: overrides?.selectData ?? [{ id: 1, title: "a" }],
      meta: { limit: 100, offset: 0, total: 1 },
    })),
    get: mock.fn(async (id: string | number) => ({ id, title: "row" })),
    insert: mock.fn(async (row: Record<string, unknown>) => ({ id: 99, ...row })),
    update: mock.fn(async (id: string | number, patch: Record<string, unknown>) => ({
      id,
      ...patch,
    })),
    delete: mock.fn(async (id: string | number) => ({ id })),
    subscribe: mock.fn((handler: Handler, rowId?: string) => {
      const key = rowId ? `t#${rowId}` : "t";
      if (!handlers.has(key)) handlers.set(key, new Set());
      handlers.get(key)!.add(handler);
      return () => {
        handlers.get(key)?.delete(handler);
      };
    }),
    subscribeReady: mock.fn(async (handler: Handler, rowId?: string) => {
      return tableApi.subscribe(handler, rowId);
    }),
  };

  const client = {
    url: "http://test",
    get accessToken() {
      return accessToken;
    },
    setToken(t: string | undefined) {
      accessToken = t;
    },
    setRefreshToken(t: string | undefined) {
      refreshToken = t;
    },
    auth: {
      signIn: mock.fn(async (creds: { email: string; password: string }) => {
        accessToken = "access";
        refreshToken = "refresh";
        return {
          access_token: "access",
          refresh_token: "refresh",
          token_type: "Bearer",
          expires_in: 3600,
          user: {
            id: "u1",
            email: creds.email,
            role: "user",
            disabled: false,
            created_at: 1,
          },
        };
      }),
      signUp: mock.fn(async (creds: { email: string; password: string }) => {
        return client.auth.signIn(creds);
      }),
      signOut: mock.fn(async () => {
        accessToken = undefined;
        refreshToken = undefined;
      }),
      me: mock.fn(async () => {
        if (!accessToken) throw new Error("unauthorized");
        return (
          overrides?.meUser ?? {
            id: "u1",
            email: "a@b.com",
            role: "user",
            disabled: false,
            created_at: 1,
          }
        );
      }),
      refresh: mock.fn(async () => ({
        access_token: "access2",
        refresh_token: "refresh2",
        token_type: "Bearer",
        expires_in: 3600,
      })),
      login: mock.fn(async () => {
        throw new Error("unused");
      }),
      register: mock.fn(async () => {
        throw new Error("unused");
      }),
      logout: mock.fn(async () => {
        throw new Error("unused");
      }),
    },
    from: mock.fn((_table: string) => tableApi),
    closeRealtime: mock.fn(),
    _emit(ev: ChangeEvent) {
      for (const set of handlers.values()) {
        set.forEach((h) => h(ev));
      }
    },
    _handlers: handlers,
    _tableApi: tableApi,
    get _refreshToken() {
      return refreshToken;
    },
  };

  return client as unknown as LoomupClient & {
    _emit: (ev: ChangeEvent) => void;
    _handlers: Map<string, Set<Handler>>;
    _tableApi: typeof tableApi;
    _refreshToken: string | undefined;
  };
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

async function flush() {
  await nextTick();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

async function renderComposable<T>(
  factory: () => T,
  client: LoomupClient,
  persist?: { enabled?: boolean; storageKey?: string },
): Promise<{
  result: { current: T };
  unmount: () => void;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const result = { current: undefined as unknown as T };

  const Probe = defineComponent({
    setup() {
      result.current = factory();
      return () => null;
    },
  });

  const app: App = createApp(Probe);
  app.use(LoomupPlugin, { client, persist });
  app.mount(container);

  await flush();

  return {
    result,
    unmount: () => {
      app.unmount();
      container.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

describe("utils", () => {
  it("rowIdFrom prefers event id", () => {
    assert.equal(rowIdFrom({ id: 1 }, "42"), "42");
    assert.equal(rowIdFrom({ slug: "a" }, undefined, "slug"), "a");
  });

  it("applyChangeToRows merges insert/update/delete", () => {
    let rows: Record<string, unknown>[] = [{ id: "1", title: "a" }];
    rows = applyChangeToRows(rows, {
      type: "change",
      table: "todos",
      op: "INSERT",
      id: "2",
      data: { id: "2", title: "b" },
      ts: 1,
    });
    assert.equal(rows.length, 2);

    rows = applyChangeToRows(rows, {
      type: "change",
      table: "todos",
      op: "UPDATE",
      id: "1",
      data: { id: "1", title: "a2" },
      ts: 2,
    });
    assert.equal(rows.find((r) => r.id === "1")?.title, "a2");

    rows = applyChangeToRows(rows, {
      type: "change",
      table: "todos",
      op: "DELETE",
      id: "2",
      ts: 3,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, "1");
  });
});

// ---------------------------------------------------------------------------
// Plugin / useLoomup
// ---------------------------------------------------------------------------

describe("LoomupPlugin / useLoomup", () => {
  it("throws outside plugin", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let caught: Error | undefined;

    const Bad = defineComponent({
      setup() {
        try {
          useLoomup();
        } catch (e) {
          caught = e as Error;
        }
        return () => null;
      },
    });

    const app = createApp(Bad);
    app.mount(container);

    assert.ok(caught);
    assert.match(caught!.message, /LoomupPlugin|provideLoomup/);
    app.unmount();
    container.remove();
  });

  it("provides client via useLoomup", async () => {
    const client = createFakeClient();
    const { result, unmount } = await renderComposable(() => useLoomup(), client);
    assert.equal(result.current, client);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// useAuth
// ---------------------------------------------------------------------------

describe("useAuth", () => {
  it("hydrates user when access token present", async () => {
    const client = createFakeClient({ accessToken: "tok" });
    const { result, unmount } = await renderComposable(() => useAuth(), client);

    await flush();

    assert.equal(result.current.loading.value, false);
    assert.equal(result.current.user.value?.email, "a@b.com");
    unmount();
  });

  it("signIn updates user state", async () => {
    const client = createFakeClient();
    const { result, unmount } = await renderComposable(() => useAuth(), client);

    await result.current.signIn({ email: "x@y.com", password: "secret12" });
    await flush();

    assert.equal(result.current.user.value?.email, "x@y.com");
    assert.equal(result.current.session.value.accessToken, "access");
    unmount();
  });

  it("signOut clears user", async () => {
    const client = createFakeClient({ accessToken: "tok" });
    const { result, unmount } = await renderComposable(() => useAuth(), client);
    await flush();

    await result.current.signOut();
    await flush();

    assert.equal(result.current.user.value, null);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// useSelect
// ---------------------------------------------------------------------------

describe("useSelect", () => {
  it("loads data", async () => {
    const client = createFakeClient({
      selectData: [{ id: 1, title: "hello" }],
    });
    const { result, unmount } = await renderComposable(
      () => useSelect("todos", { limit: 10 }),
      client,
    );

    await flush();

    assert.equal(result.current.loading.value, false);
    assert.equal(result.current.data.value?.[0]?.title, "hello");
    assert.equal(result.current.meta.value?.total, 1);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// useMutation
// ---------------------------------------------------------------------------

describe("useMutation", () => {
  it("runs mutation and tracks loading", async () => {
    const client = createFakeClient();
    const { result, unmount } = await renderComposable(
      () =>
        useMutation((c, title: string) =>
          c.from("todos").insert({ title, completed: 0 }),
        ),
      client,
    );

    const row = (await result.current.mutate("ship")) as Record<string, unknown>;
    await flush();

    assert.equal(row?.title, "ship");
    assert.equal(result.current.loading.value, false);
    assert.equal(result.current.error.value, null);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// useSubscribe
// ---------------------------------------------------------------------------

describe("useSubscribe", () => {
  it("subscribes and unsubscribes on unmount", async () => {
    const client = createFakeClient();
    const events: ChangeEvent[] = [];

    const { result, unmount } = await renderComposable(() => {
      return useSubscribe("todos", (ev) => {
        events.push(ev);
      });
    }, client);

    await flush();

    assert.equal(result.current.ready.value, true);
    assert.equal(
      client._tableApi.subscribe.mock.calls.length > 0 ||
        client._tableApi.subscribeReady.mock.calls.length > 0,
      true,
    );

    client._emit({
      type: "change",
      table: "todos",
      op: "INSERT",
      id: "1",
      data: { id: "1" },
      ts: 1,
    });
    assert.equal(events.length, 1);

    unmount();
    // after unmount handlers should be empty
    let remaining = 0;
    for (const set of client._handlers.values()) remaining += set.size;
    assert.equal(remaining, 0);
  });
});

// ---------------------------------------------------------------------------
// useLiveQuery
// ---------------------------------------------------------------------------

describe("useLiveQuery", () => {
  it("loads initial data and merges events", async () => {
    const client = createFakeClient({
      selectData: [{ id: "1", title: "a" }],
    });

    const { result, unmount } = await renderComposable(
      () => useLiveQuery("todos", { strategy: "merge" }),
      client,
    );

    await flush();

    assert.equal(result.current.data.value?.length, 1);
    assert.equal(result.current.ready.value, true);

    client._emit({
      type: "change",
      table: "todos",
      op: "INSERT",
      id: "2",
      data: { id: "2", title: "b" },
      ts: 2,
    });
    await flush();

    assert.equal(result.current.data.value?.length, 2);
    unmount();
  });

  it("refetch strategy re-selects on change", async () => {
    const client = createFakeClient({
      selectData: [{ id: "1", title: "a" }],
    });
    const { result, unmount } = await renderComposable(
      () => useLiveQuery("todos", { strategy: "refetch" }),
      client,
    );

    await flush();

    const callsBefore = client._tableApi.select.mock.calls.length;

    client._emit({
      type: "change",
      table: "todos",
      op: "INSERT",
      id: "9",
      data: { id: "9" },
      ts: 1,
    });
    await flush();

    assert.ok(client._tableApi.select.mock.calls.length > callsBefore);
    assert.ok(result.current.data.value);
    unmount();
  });
});
