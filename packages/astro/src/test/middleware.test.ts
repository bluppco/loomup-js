import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createLoomupMiddleware,
  type LoomupMiddlewareContext,
} from "../middleware.js";
import {
  DEFAULT_ACCESS_COOKIE,
  DEFAULT_REFRESH_COOKIE,
  type CookieStore,
} from "../server.js";

function mockCookies(
  initial?: Record<string, string>,
): CookieStore & { jar: Map<string, string> } {
  const jar = new Map(Object.entries(initial ?? {}));
  return {
    jar,
    get(name) {
      const v = jar.get(name);
      return v !== undefined ? { value: v } : undefined;
    },
    set(name, value) {
      jar.set(name, value);
    },
    delete(name) {
      jar.delete(name);
    },
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createLoomupMiddleware", () => {
  it("attaches client and user when access cookie valid", async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
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
      return new Response("not found", { status: 404 });
    };

    const cookies = mockCookies({ [DEFAULT_ACCESS_COOKIE]: "tok" });
    const locals: Record<string, unknown> = {};
    const ctx: LoomupMiddlewareContext = { cookies, locals };
    const mw = createLoomupMiddleware({ url: "http://lb.test" });

    let nextCalled = false;
    await mw(ctx, async () => {
      nextCalled = true;
      return new Response("ok");
    });

    assert.equal(nextCalled, true);
    assert.ok(locals.loomup);
    assert.deepEqual(locals.user, {
      id: "u1",
      email: "a@b.com",
      role: "user",
      disabled: false,
      created_at: 1,
    });
  });

  it("refreshes when only refresh cookie present", async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/refresh")) {
        return new Response(
          JSON.stringify({
            data: {
              access_token: "new-access",
              refresh_token: "new-refresh",
              token_type: "Bearer",
              expires_in: 3600,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/auth/me")) {
        return new Response(
          JSON.stringify({
            data: {
              id: "u2",
              email: "b@c.com",
              role: "user",
              disabled: false,
              created_at: 2,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    };

    const cookies = mockCookies({ [DEFAULT_REFRESH_COOKIE]: "old-refresh" });
    const locals: Record<string, unknown> = {};
    const mw = createLoomupMiddleware({ url: "http://lb.test" });
    await mw({ cookies, locals }, async () => new Response("ok"));

    assert.equal(cookies.jar.get(DEFAULT_ACCESS_COOKIE), "new-access");
    assert.equal(cookies.jar.get(DEFAULT_REFRESH_COOKIE), "new-refresh");
    assert.equal((locals.user as { id: string }).id, "u2");
  });
});
