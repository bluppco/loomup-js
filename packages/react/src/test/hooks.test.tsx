/**
 * Hook tests with a fake Loomup client surface.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import React, { useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import {
  LoomupProvider,
  useLoomup,
  useAuth,
  useSelect,
  useSubscribe,
  useLiveQuery,
  useMutation,
  SyncStoreProvider,
  useSyncResource,
  applyChangeToRows,
  rowIdFrom,
  type PersistOptions,
  type TokenStorage,
} from "../index.js";
import type { ChangeEvent, LoomupClient, SyncStore } from "@loomup/client";

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

function createMemoryStorage(): TokenStorage & { store: Map<string, string> } {
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

async function renderHook<T>(
  hook: () => T,
  client: LoomupClient,
  persist?: PersistOptions,
): Promise<{
  result: { current: T };
  unmount: () => void;
  rerender: () => void;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root;
  const result = { current: undefined as unknown as T };

  function Probe() {
    result.current = hook();
    return null;
  }

  function App() {
    return (
      <LoomupProvider client={client} persist={persist}>
        <Probe />
      </LoomupProvider>
    );
  }

  await act(async () => {
    root = createRoot(container);
    root.render(<App />);
  });

  // flush microtasks from effects
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  return {
    result,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
    rerender: () => {
      act(() => {
        root.render(<App />);
      });
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
// Provider
// ---------------------------------------------------------------------------

describe("LoomupProvider / useLoomup", () => {
  it("throws outside provider", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let caught: Error | undefined;

    function Bad() {
      try {
        useLoomup();
      } catch (e) {
        caught = e as Error;
      }
      return null;
    }

    await act(async () => {
      const root = createRoot(container);
      root.render(<Bad />);
    });

    assert.ok(caught);
    assert.match(caught!.message, /LoomupProvider/);
    container.remove();
  });

  it("provides client via useLoomup", async () => {
    const client = createFakeClient();
    const { result, unmount } = await renderHook(() => useLoomup(), client);
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
    const { result, unmount } = await renderHook(() => useAuth(), client);

    // allow me() to resolve
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(result.current.loading, false);
    assert.equal(result.current.user?.email, "a@b.com");
    unmount();
  });

  it("signIn updates user state", async () => {
    const client = createFakeClient();
    const { result, unmount } = await renderHook(() => useAuth(), client);

    await act(async () => {
      await result.current.signIn({ email: "x@y.com", password: "secret12" });
    });

    assert.equal(result.current.user?.email, "x@y.com");
    assert.equal(result.current.session.accessToken, "access");
    unmount();
  });

  it("signOut clears user", async () => {
    const client = createFakeClient({ accessToken: "tok" });
    const { result, unmount } = await renderHook(() => useAuth(), client);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.signOut();
    });

    assert.equal(result.current.user, null);
    unmount();
  });

  it("persists tokens via custom async storage", async () => {
    const memory = createMemoryStorage();
    const client = createFakeClient();
    const { result, unmount } = await renderHook(() => useAuth(), client, {
      enabled: true,
      storageKey: "test",
      storage: memory,
    });

    await act(async () => {
      await result.current.signIn({ email: "x@y.com", password: "secret12" });
    });

    assert.equal(memory.store.get("test:access"), "access");
    assert.equal(memory.store.get("test:refresh"), "refresh");

    await act(async () => {
      await result.current.signOut();
    });

    assert.equal(memory.store.has("test:access"), false);
    assert.equal(memory.store.has("test:refresh"), false);
    unmount();
  });

  it("hydrates session from custom storage on mount", async () => {
    const memory = createMemoryStorage();
    memory.store.set("test:access", "tok");
    memory.store.set("test:refresh", "ref");

    const client = createFakeClient();
    const { result, unmount } = await renderHook(() => useAuth(), client, {
      enabled: true,
      storageKey: "test",
      storage: memory,
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(result.current.loading, false);
    assert.equal(result.current.user?.email, "a@b.com");
    assert.equal(client.accessToken, "tok");
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
    const { result, unmount } = await renderHook(
      () => useSelect("todos", { limit: 10 }),
      client,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(result.current.loading, false);
    assert.equal(result.current.data?.[0]?.title, "hello");
    assert.equal(result.current.meta?.total, 1);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// useMutation
// ---------------------------------------------------------------------------

describe("useMutation", () => {
  it("runs mutation and tracks loading", async () => {
    const client = createFakeClient();
    const { result, unmount } = await renderHook(
      () =>
        useMutation((c, title: string) =>
          c.from("todos").insert({ title, completed: 0 }),
        ),
      client,
    );

    let row: Record<string, unknown> | undefined;
    await act(async () => {
      row = (await result.current.mutate("ship")) as Record<string, unknown>;
    });

    assert.equal(row?.title, "ship");
    assert.equal(result.current.loading, false);
    assert.equal(result.current.error, null);
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

    const { result, unmount } = await renderHook(() => {
      return useSubscribe("todos", (ev) => {
        events.push(ev);
      });
    }, client);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(result.current.ready, true);
    assert.equal(
      client._tableApi.subscribe.mock.calls.length > 0 ||
        client._tableApi.subscribeReady.mock.calls.length > 0,
      true,
    );

    await act(async () => {
      client._emit({
        type: "change",
        table: "todos",
        op: "INSERT",
        id: "1",
        data: { id: "1" },
        ts: 1,
      });
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

    const { result, unmount } = await renderHook(
      () => useLiveQuery("todos", { strategy: "merge" }),
      client,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(result.current.data?.length, 1);
    assert.equal(result.current.ready, true);

    await act(async () => {
      client._emit({
        type: "change",
        table: "todos",
        op: "INSERT",
        id: "2",
        data: { id: "2", title: "b" },
        ts: 2,
      });
      await Promise.resolve();
    });

    assert.equal(result.current.data?.length, 2);
    unmount();
  });

  it("refetch strategy re-selects on change", async () => {
    const client = createFakeClient({
      selectData: [{ id: "1", title: "a" }],
    });
    const { result, unmount } = await renderHook(
      () => useLiveQuery("todos", { strategy: "refetch" }),
      client,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const callsBefore = client._tableApi.select.mock.calls.length;

    await act(async () => {
      client._emit({
        type: "change",
        table: "todos",
        op: "INSERT",
        id: "9",
        data: { id: "9" },
        ts: 1,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.ok(client._tableApi.select.mock.calls.length > callsBefore);
    assert.ok(result.current.data);
    unmount();
  });
});

describe("useSyncResource", () => {
  it("renders local rows and reacts to optimistic store notifications", async () => {
    let rows: Record<string, unknown>[] = [{ id: "1", title: "offline" }];
    const listeners = new Set<() => void>();
    const fake = {
      find: () => rows,
      get status() {
        return { phase: "offline", online: false, cursor: 1, pending: 1, conflicts: 0 };
      },
      get conflicts() {
        return [];
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        listener();
        return () => listeners.delete(listener);
      },
      create: mock.fn(async () => ({})),
      update: mock.fn(async () => ({})),
      remove: mock.fn(async () => undefined),
      sync: mock.fn(async () => undefined),
      setOnline: mock.fn(async () => undefined),
    } as unknown as SyncStore;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let current: ReturnType<typeof useSyncResource>;
    function Probe() {
      current = useSyncResource("notes");
      return null;
    }
    await act(async () => {
      root.render(
        <SyncStoreProvider store={fake}>
          <Probe />
        </SyncStoreProvider>,
      );
    });
    assert.equal(current!.data[0]?.title, "offline");
    rows = [...rows, { id: "2", title: "optimistic" }];
    await act(async () => {
      for (const listener of listeners) listener();
    });
    assert.equal(current!.data.length, 2);
    act(() => root.unmount());
    container.remove();
  });
});

// Silence unused import if tree-shaken oddly
void useEffect;
