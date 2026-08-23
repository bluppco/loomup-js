import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/query-core";
import { createClient } from "@loomup/client";
import { createLoomupQuery } from "../options.js";
import { loomupKeys } from "../keys.js";

function mockJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createLoomupQuery options", () => {
  it("selectOptions builds key and queryFn hits list endpoint", async () => {
    const urls: string[] = [];
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return mockJson({
        data: [{ id: "1", title: "a" }],
        meta: { limit: 20, offset: 0, total: 1 },
      });
    }) as typeof fetch;

    try {
      const client = createClient({ url: "http://localhost:3000" });
      const lb = createLoomupQuery(client);
      const opts = lb.from("todos").selectOptions({
        where: { completed: false },
        limit: 20,
      });

      assert.equal(opts.queryKey[0], "loomup");
      assert.equal(opts.queryKey[1], "todos");
      assert.equal(opts.queryKey[2], "list");

      const result = await opts.queryFn();
      assert.equal(result.data.length, 1);
      assert.equal(result.meta.total, 1);
      assert.ok(
        urls[0]?.includes("/api/todos"),
        `expected /api/todos, got ${urls[0]}`,
      );
      assert.ok(
        urls[0]?.includes("where") || urls[0]?.includes("completed"),
        urls[0],
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("getOptions fetches detail by id", async () => {
    const urls: string[] = [];
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return mockJson({ data: { id: "9", title: "x" } });
    }) as typeof fetch;

    try {
      const client = createClient({ url: "http://example.test" });
      const lb = createLoomupQuery(client);
      const opts = lb.from("todos").getOptions(9);
      assert.deepEqual(opts.queryKey, loomupKeys.detail("todos", 9));
      const row = await opts.queryFn();
      assert.equal((row as { id: string }).id, "9");
      assert.ok(urls[0]?.includes("/api/todos/9"));
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("insertOptions mutationFn posts row; with queryClient invalidates", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(init?.method, "POST");
      return mockJson({ data: { id: "3", title: "new" } });
    }) as typeof fetch;

    try {
      const client = createClient({ url: "http://example.test" });
      const lb = createLoomupQuery(client);
      const qc = new QueryClient();
      let invalidated = false;
      const orig = qc.invalidateQueries.bind(qc);
      qc.invalidateQueries = ((opts: { queryKey: readonly unknown[] }) => {
        if (
          Array.isArray(opts.queryKey) &&
          opts.queryKey[0] === "loomup" &&
          opts.queryKey[1] === "todos"
        ) {
          invalidated = true;
        }
        return orig(opts as never);
      }) as typeof qc.invalidateQueries;

      const pure = lb.from("todos").insertOptions();
      const inserted = await pure.mutationFn({ title: "new" });
      assert.equal((inserted as { id: string }).id, "3");
      assert.equal(
        "onSuccess" in pure ? (pure as { onSuccess?: unknown }).onSuccess : undefined,
        undefined,
      );

      const withCache = lb.from("todos").insertOptions({ queryClient: qc });
      assert.equal(typeof withCache.onSuccess, "function");
      await withCache.onSuccess!(inserted as never);
      assert.ok(invalidated);
      assert.deepEqual(qc.getQueryData(loomupKeys.detail("todos", "3")), {
        id: "3",
        title: "new",
      });
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("updateOptions and deleteOptions mutate with cache side-effects", async () => {
    const methods: string[] = [];
    const prev = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(String(init?.method || "GET"));
      if (init?.method === "PATCH") {
        return mockJson({ data: { id: "1", title: "upd" } });
      }
      return mockJson({ data: { id: "1", title: "gone" } });
    }) as typeof fetch;

    try {
      const client = createClient({ url: "http://example.test" });
      const lb = createLoomupQuery(client);
      const qc = new QueryClient();
      qc.setQueryData(loomupKeys.detail("todos", "1"), {
        id: "1",
        title: "old",
      });

      const upd = lb.from("todos").updateOptions({ queryClient: qc });
      const updated = await upd.mutationFn({
        id: "1",
        patch: { title: "upd" },
      });
      await upd.onSuccess!(
        updated as never,
        { id: "1", patch: { title: "upd" } } as never,
      );
      assert.deepEqual(qc.getQueryData(loomupKeys.detail("todos", "1")), {
        id: "1",
        title: "upd",
      });

      const del = lb.from("todos").deleteOptions({ queryClient: qc });
      await del.mutationFn("1");
      await del.onSuccess!({ id: "1" } as never, "1" as never);
      assert.equal(qc.getQueryData(loomupKeys.detail("todos", "1")), undefined);
      assert.ok(methods.includes("PATCH"));
      assert.ok(methods.includes("DELETE"));
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("auth meOptions and signOut clears cache when queryClient set", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return mockJson({
          data: {
            id: "u1",
            email: "a@b.com",
            role: "user",
            disabled: false,
            created_at: 1,
          },
        });
      }
      if (url.includes("/auth/logout")) {
        return mockJson({});
      }
      if (url.includes("/auth/login")) {
        return mockJson({
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
        });
      }
      return mockJson({ error: { message: `unexpected ${url} ${init?.method}` } }, 500);
    }) as typeof fetch;

    try {
      const client = createClient({
        url: "http://example.test",
        refreshToken: "r",
      });
      const lb = createLoomupQuery(client);
      const qc = new QueryClient();

      const me = await lb.auth.meOptions().queryFn();
      assert.equal(me.email, "a@b.com");

      const signIn = lb.auth.signInOptions({ queryClient: qc });
      const tokens = await signIn.mutationFn({
        email: "a@b.com",
        password: "secret12",
      });
      await signIn.onSuccess!(tokens as never);
      assert.equal(
        (qc.getQueryData(loomupKeys.me()) as { email: string }).email,
        "a@b.com",
      );

      qc.setQueryData(loomupKeys.list("todos"), { data: [], meta: {} });
      const signOut = lb.auth.signOutOptions({ queryClient: qc });
      await signOut.mutationFn();
      await signOut.onSuccess!();
      assert.equal(qc.getQueryData(loomupKeys.me()), undefined);
      assert.equal(qc.getQueryData(loomupKeys.list("todos")), undefined);
    } finally {
      globalThis.fetch = prev;
    }
  });
});
