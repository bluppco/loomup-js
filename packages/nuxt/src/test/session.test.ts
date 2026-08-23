import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { updateSession } from "../runtime/server/session.js";
import {
  DEFAULT_ACCESS_COOKIE,
  DEFAULT_REFRESH_COOKIE,
  jwtExpiresAt,
} from "../cookies.js";
import type { CookieMethods, CookieRecord } from "../types.js";

function makeJwt(exp: number): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp, sub: "u1" })).toString(
    "base64url",
  );
  return `${header}.${payload}.sig`;
}

function mockCookies(
  initial: Record<string, string> = {},
): CookieMethods & { jar: Map<string, string> } {
  const jar = new Map(Object.entries(initial));
  return {
    jar,
    getAll: () =>
      Array.from(jar.entries()).map(([name, value]) => ({ name, value })),
    setAll: (records: CookieRecord[]) => {
      for (const c of records) {
        if (c.value === "" || c.options?.maxAge === 0) jar.delete(c.name);
        else jar.set(c.name, c.value);
      }
    },
  };
}

describe("updateSession", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("no-ops when no refresh cookie", async () => {
    const cookies = mockCookies({ [DEFAULT_ACCESS_COOKIE]: "a" });
    const result = await updateSession({
      url: "http://lb.test",
      cookies,
      fetchImpl: (async () => {
        throw new Error("should not fetch");
      }) as typeof fetch,
    });
    assert.deepEqual(result, { refreshed: false, cleared: false });
  });

  it("no-ops when access is still fresh", async () => {
    const now = Math.floor(Date.now() / 1000);
    const access = makeJwt(now + 3600);
    assert.ok(jwtExpiresAt(access)! > now + 60);
    const cookies = mockCookies({
      [DEFAULT_ACCESS_COOKIE]: access,
      [DEFAULT_REFRESH_COOKIE]: "r1",
    });
    let fetched = false;
    const result = await updateSession({
      url: "http://lb.test",
      cookies,
      fetchImpl: (async () => {
        fetched = true;
        return new Response("{}");
      }) as typeof fetch,
    });
    assert.equal(fetched, false);
    assert.deepEqual(result, { refreshed: false, cleared: false });
  });

  it("refreshes near-expired access token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const access = makeJwt(now + 10); // within 60s skew
    const cookies = mockCookies({
      [DEFAULT_ACCESS_COOKIE]: access,
      [DEFAULT_REFRESH_COOKIE]: "r1",
    });
    const result = await updateSession({
      url: "http://lb.test",
      cookies,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            data: {
              access_token: "new-a",
              refresh_token: "new-r",
              expires_in: 900,
              token_type: "Bearer",
            },
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    assert.equal(result.refreshed, true);
    assert.equal(cookies.jar.get(DEFAULT_ACCESS_COOKIE), "new-a");
    assert.equal(cookies.jar.get(DEFAULT_REFRESH_COOKIE), "new-r");
  });

  it("clears cookies when refresh fails", async () => {
    const cookies = mockCookies({
      [DEFAULT_REFRESH_COOKIE]: "r1",
    });
    const result = await updateSession({
      url: "http://lb.test",
      cookies,
      fetchImpl: (async () =>
        new Response("nope", { status: 401 })) as typeof fetch,
    });
    assert.equal(result.cleared, true);
    assert.equal(cookies.jar.has(DEFAULT_REFRESH_COOKIE), false);
  });
});
