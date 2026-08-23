import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ACCESS_COOKIE,
  DEFAULT_REFRESH_COOKIE,
} from "../cookies.js";
import { createClientFromCookies } from "../storage.js";
import { createServerClient } from "../createServerClient.js";
import { createPagesServerClient } from "../createPagesServerClient.js";
import { updateSession } from "../createMiddlewareClient.js";
import { createBrowserClient } from "../createBrowserClient.js";
import { createAuthRouteHandlers } from "../createAuthRouteHandlers.js";
import type { CookieMethods, CookieRecord } from "../types.js";

function getSetCookieHeaders(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") {
    return h.getSetCookie();
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function mockJar(
  initial: { name: string; value: string }[] = [],
): CookieMethods & { store: Map<string, CookieRecord> } {
  const store = new Map<string, CookieRecord>();
  for (const c of initial) {
    store.set(c.name, { name: c.name, value: c.value });
  }
  return {
    store,
    getAll: () =>
      [...store.values()].map((c) => ({ name: c.name, value: c.value })),
    setAll: (records) => {
      for (const r of records) {
        if (r.options?.maxAge === 0 || r.value === "") {
          store.delete(r.name);
        } else {
          store.set(r.name, r);
        }
      }
    },
  };
}

function makeJwt(exp: number): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp, sub: "u1" })).toString(
    "base64url",
  );
  return `${header}.${payload}.sig`;
}

describe("createClientFromCookies", () => {
  it("hydrates Bearer from cookies and writes onTokens", async () => {
    const jar = mockJar([
      { name: DEFAULT_ACCESS_COOKIE, value: "old-a" },
      { name: DEFAULT_REFRESH_COOKIE, value: "old-r" },
    ]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/refresh")) {
        return new Response(
          JSON.stringify({
            data: {
              access_token: "new-a",
              refresh_token: "new-r",
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
      const client = createClientFromCookies({
        url: "http://lb.test",
        cookies: jar,
      });
      assert.equal(client.accessToken, "old-a");
      await client.auth.refresh();
      assert.equal(client.accessToken, "new-a");
      assert.equal(jar.store.get(DEFAULT_ACCESS_COOKIE)?.value, "new-a");
      assert.equal(jar.store.get(DEFAULT_REFRESH_COOKIE)?.value, "new-r");

      await client.auth.signOut();
      assert.equal(jar.store.has(DEFAULT_ACCESS_COOKIE), false);
      assert.equal(jar.store.has(DEFAULT_REFRESH_COOKIE), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("createServerClient accepts CookieMethods", async () => {
    const jar = mockJar([
      { name: DEFAULT_ACCESS_COOKIE, value: "tok" },
    ]);
    const client = await createServerClient({
      url: "http://lb.test",
      cookies: jar,
    });
    assert.equal(client.accessToken, "tok");
  });
});

describe("createPagesServerClient", () => {
  it("reads req.cookies and writes Set-Cookie on res", async () => {
    const setCookies: string[] = [];
    const headers: Record<string, string | string[]> = {};
    const client = createPagesServerClient({
      url: "http://lb.test",
      context: {
        req: {
          cookies: {
            [DEFAULT_ACCESS_COOKIE]: "page-a",
            [DEFAULT_REFRESH_COOKIE]: "page-r",
          },
        },
        res: {
          getHeader: (name) => headers[name.toLowerCase()],
          setHeader: (name, value) => {
            headers[name.toLowerCase()] = value;
            if (name.toLowerCase() === "set-cookie") {
              if (Array.isArray(value)) setCookies.push(...value);
              else setCookies.push(String(value));
            }
          },
        },
      },
    });
    assert.equal(client.accessToken, "page-a");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            access_token: "rotated",
            refresh_token: "rotated-r",
            token_type: "Bearer",
            expires_in: 60,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    try {
      await client.auth.refresh();
      assert.ok(
        setCookies.some((c) => c.includes("loomup-access=rotated")),
        JSON.stringify(setCookies),
      );
      assert.ok(
        setCookies.some((c) => c.includes("loomup-refresh=rotated-r")),
        JSON.stringify(setCookies),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("updateSession middleware", () => {
  it("refreshes when access JWT is expired", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = makeJwt(now - 5);
    const setCalls: { name: string; value: string }[] = [];
    const request = {
      cookies: {
        getAll: () => [
          { name: DEFAULT_ACCESS_COOKIE, value: expired },
          { name: DEFAULT_REFRESH_COOKIE, value: "ref-1" },
        ],
      },
      url: "http://app.test/",
    };
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.ok(String(input).endsWith("/auth/refresh"));
      assert.equal(init?.method, "POST");
      return new Response(
        JSON.stringify({
          data: {
            access_token: makeJwt(now + 900),
            refresh_token: "ref-2",
            token_type: "Bearer",
            expires_in: 900,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await updateSession(request, {
      url: "http://lb.test",
      fetchImpl,
      createResponse: () => ({
        cookies: {
          set: (name, value) => {
            setCalls.push({ name, value });
          },
        },
      }),
    });

    assert.ok(
      setCalls.some((c) => c.name === DEFAULT_ACCESS_COOKIE),
      JSON.stringify(setCalls),
    );
    assert.ok(
      setCalls.some(
        (c) => c.name === DEFAULT_REFRESH_COOKIE && c.value === "ref-2",
      ),
      JSON.stringify(setCalls),
    );
  });

  it("skips refresh when access is still valid", async () => {
    const now = Math.floor(Date.now() / 1000);
    let fetchCalled = false;
    await updateSession(
      {
        cookies: {
          getAll: () => [
            { name: DEFAULT_ACCESS_COOKIE, value: makeJwt(now + 3600) },
            { name: DEFAULT_REFRESH_COOKIE, value: "ref-1" },
          ],
        },
        url: "http://app.test/",
      },
      {
        url: "http://lb.test",
        fetchImpl: (async () => {
          fetchCalled = true;
          return new Response("no", { status: 500 });
        }) as typeof fetch,
        createResponse: () => ({
          cookies: { set: () => {} },
        }),
      },
    );
    assert.equal(fetchCalled, false);
  });
});

describe("createBrowserClient", () => {
  it("uses initial accessToken", () => {
    const c = createBrowserClient({
      url: "http://lb.test",
      accessToken: "browser-tok",
    });
    assert.equal(c.accessToken, "browser-tok");
  });
});

describe("createAuthRouteHandlers", () => {
  it("login sets session cookies", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/auth/login")) {
        return new Response(
          JSON.stringify({
            data: {
              access_token: "a1",
              refresh_token: "r1",
              token_type: "Bearer",
              expires_in: 900,
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
      return new Response("no", { status: 404 });
    }) as typeof fetch;

    try {
      const handlers = createAuthRouteHandlers({ url: "http://lb.test" });
      const res = await handlers.login(
        new Request("http://app.test/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "a@b.com", password: "secret12" }),
        }),
      );
      assert.equal(res.status, 200);
      const raw = getSetCookieHeaders(res);
      assert.ok(
        raw.some((c) => c.includes("loomup-access=a1")),
        JSON.stringify(raw),
      );
      assert.ok(
        raw.some((c) => c.includes("loomup-refresh=r1")),
        JSON.stringify(raw),
      );
      const body = (await res.json()) as {
        data: { user?: { email: string }; access_token?: string };
      };
      assert.equal(body.data.user?.email, "a@b.com");
      assert.equal(body.data.access_token, "a1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("logout clears cookies", async () => {
    const handlers = createAuthRouteHandlers({ url: "http://lb.test" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    try {
      const res = await handlers.logout(
        new Request("http://app.test/api/auth/logout", {
          method: "POST",
          headers: {
            cookie: `${DEFAULT_REFRESH_COOKIE}=r1; ${DEFAULT_ACCESS_COOKIE}=a1`,
          },
        }),
      );
      assert.equal(res.status, 200);
      const raw = getSetCookieHeaders(res);
      assert.ok(raw.some((c) => c.includes("Max-Age=0")), JSON.stringify(raw));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
