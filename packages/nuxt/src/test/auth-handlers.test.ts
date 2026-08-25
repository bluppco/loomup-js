import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createAuthHandlers } from "../runtime/server/authHandlers.js";
import {
  DEFAULT_ACCESS_COOKIE,
  DEFAULT_REFRESH_COOKIE,
} from "../cookies.js";
import type { CookieMethods, CookieRecord } from "../types.js";

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

function authPayload() {
  return {
    data: {
      access_token: "access-1",
      refresh_token: "refresh-1",
      token_type: "Bearer",
      expires_in: 3600,
      user: {
        id: "u1",
        email: "a@b.com",
        role: "user",
        disabled: false,
        created_at: 0,
      },
    },
  };
}

describe("createAuthHandlers", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("login rejects missing credentials", async () => {
    const handlers = createAuthHandlers({ url: "http://lb.test" });
    const cookies = mockCookies();
    const res = await handlers.login({}, { cookies });
    assert.equal(res.status, 400);
  });

  it("login sets cookies on success", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/login") || url.includes("/auth/signin")) {
        return new Response(JSON.stringify(authPayload()), { status: 200 });
      }
      // client may call different paths
      return new Response(JSON.stringify(authPayload()), { status: 200 });
    }) as typeof fetch;

    const handlers = createAuthHandlers({ url: "http://lb.test" });
    const cookies = mockCookies();
    const res = await handlers.login(
      { email: "a@b.com", password: "secret12" },
      { cookies },
    );
    assert.equal(res.status, 200);
    const body = res.body as { data?: { access_token?: string } };
    assert.equal(body.data?.access_token, "access-1");
    assert.equal(cookies.jar.get(DEFAULT_ACCESS_COOKIE), "access-1");
    assert.equal(cookies.jar.get(DEFAULT_REFRESH_COOKIE), "refresh-1");
  });

  it("logout clears cookies", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
      })) as typeof fetch;

    const handlers = createAuthHandlers({ url: "http://lb.test" });
    const cookies = mockCookies({
      [DEFAULT_ACCESS_COOKIE]: "a",
      [DEFAULT_REFRESH_COOKIE]: "r",
    });
    const res = await handlers.logout({ cookies });
    assert.equal(res.status, 200);
    assert.equal(cookies.jar.has(DEFAULT_ACCESS_COOKIE), false);
    assert.equal(cookies.jar.has(DEFAULT_REFRESH_COOKIE), false);
  });

  it("session returns null without cookies", async () => {
    const handlers = createAuthHandlers({ url: "http://lb.test" });
    const cookies = mockCookies();
    const res = await handlers.session({ cookies });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { data: { user: null, session: null } });
  });

  it("completes OAuth with transient cookies and relays stable errors", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/auth/oauth/authorize")) {
        return Response.json({ data: { authorization_url: "https://accounts.test/authorize", code_verifier: "nuxt-verifier", expires_in: 600 } });
      }
      return new Response(JSON.stringify(authPayload()), { status: 200 });
    }) as typeof fetch;
    const handlers = createAuthHandlers({
      url: "https://api.test",
      oauthCallbackUrl: "https://app.test/api/auth/oauth/callback",
    });
    const cookies = mockCookies();
    const start = await handlers.oauthStart({ provider: "google", returnTo: "/account" }, { cookies });
    assert.equal(start.location, "https://accounts.test/authorize");
    assert.equal(cookies.jar.get("loomup-oauth-verifier"), "nuxt-verifier");
    const callback = await handlers.oauthCallback("handoff", undefined, { cookies });
    assert.equal(callback.location, "/account");
    assert.equal(cookies.jar.get(DEFAULT_ACCESS_COOKIE), "access-1");

    const deniedCookies = mockCookies({
      "loomup-oauth-verifier": "v",
      "loomup-oauth-return": encodeURIComponent("/login"),
    });
    const denied = await handlers.oauthCallback(undefined, "registration_disabled", { cookies: deniedCookies });
    assert.equal(denied.location, "/login?error=registration_disabled");
    assert.equal(deniedCookies.jar.has("loomup-oauth-verifier"), false);

    const unsolicited = await handlers.oauthCallback(undefined, "registration_disabled", { cookies: mockCookies() });
    assert.equal(unsolicited.status, 400);
    assert.equal((unsolicited.body as { error: { code: string } }).error.code, "oauth_flow_expired");
  });
});
