import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createServerClient,
  createServerProject,
  DEFAULT_ACCESS_COOKIE,
  DEFAULT_REFRESH_COOKIE,
  type CookieStore,
} from "../server.js";

function mockCookies(): CookieStore & { jar: Map<string, string> } {
  const jar = new Map<string, string>();
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

describe("createServerClient", () => {
  const originalFetch = globalThis.fetch;
  let lastRequest: { url: string; init?: RequestInit } | null = null;

  beforeEach(() => {
    lastRequest = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reads tokens from cookies on construct", () => {
    const cookies = mockCookies();
    cookies.jar.set(DEFAULT_ACCESS_COOKIE, "from-cookie");
    cookies.jar.set(DEFAULT_REFRESH_COOKIE, "refresh-cookie");
    const client = createServerClient(cookies, {
      url: "http://lb.test",
    });
    assert.equal(client.accessToken, "from-cookie");
    assert.equal(client.url, "http://lb.test");
  });

  it("requires url when env missing", () => {
    const prevL = process.env.LOOMUP_URL;
    const prevP = process.env.PUBLIC_LOOMUP_URL;
    delete process.env.LOOMUP_URL;
    delete process.env.PUBLIC_LOOMUP_URL;
    try {
      assert.throws(
        () => createServerClient(mockCookies()),
        /requires `url`/,
      );
    } finally {
      if (prevL !== undefined) process.env.LOOMUP_URL = prevL;
      if (prevP !== undefined) process.env.PUBLIC_LOOMUP_URL = prevP;
    }
  });

  it("signIn writes access and refresh cookies", async () => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      lastRequest = { url: String(input), init };
      return new Response(JSON.stringify(authPayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const cookies = mockCookies();
    const client = createServerClient(cookies, { url: "http://lb.test" });
    const tokens = await client.auth.signIn({
      email: "a@b.com",
      password: "secret12",
    });

    assert.equal(tokens.access_token, "access-1");
    assert.equal(cookies.jar.get(DEFAULT_ACCESS_COOKIE), "access-1");
    assert.equal(cookies.jar.get(DEFAULT_REFRESH_COOKIE), "refresh-1");
    assert.equal(client.accessToken, "access-1");
    assert.ok(lastRequest?.url.includes("/auth/login"));
  });

  it("signUp writes cookies", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(authPayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const cookies = mockCookies();
    const client = createServerClient(cookies, { url: "http://lb.test" });
    await client.auth.signUp({ email: "a@b.com", password: "secret12" });
    assert.equal(cookies.jar.get(DEFAULT_ACCESS_COOKIE), "access-1");
  });

  it("signOut clears cookies", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const cookies = mockCookies();
    cookies.jar.set(DEFAULT_ACCESS_COOKIE, "a");
    cookies.jar.set(DEFAULT_REFRESH_COOKIE, "r");
    const client = createServerClient(cookies, {
      url: "http://lb.test",
      token: "a",
      refreshToken: "r",
    });
    await client.auth.signOut();
    assert.equal(cookies.jar.has(DEFAULT_ACCESS_COOKIE), false);
    assert.equal(cookies.jar.has(DEFAULT_REFRESH_COOKIE), false);
    assert.equal(client.accessToken, undefined);
  });

  it("refresh writes rotated cookies", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            access_token: "access-2",
            refresh_token: "refresh-2",
            token_type: "Bearer",
            expires_in: 3600,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const cookies = mockCookies();
    const client = createServerClient(cookies, {
      url: "http://lb.test",
      token: "old",
      refreshToken: "refresh-1",
    });
    await client.auth.refresh();
    assert.equal(cookies.jar.get(DEFAULT_ACCESS_COOKIE), "access-2");
    assert.equal(cookies.jar.get(DEFAULT_REFRESH_COOKIE), "refresh-2");
  });

  it("from() is available for CRUD", () => {
    const client = createServerClient(mockCookies(), {
      url: "http://lb.test",
    });
    const q = client.from("todos");
    assert.equal(typeof q.select, "function");
    assert.equal(typeof q.insert, "function");
  });

  it("createServerProject exposes typed resource properties", () => {
    type Tables = { issues: { id: string; title: string } };
    const db = createServerProject<Tables>(mockCookies(), {
      url: "http://lb.test",
    });
    assert.equal(db.issues.name, "issues");
    assert.equal(typeof db.issues.find, "function");
    assert.equal(typeof db.auth.me, "function");
  });
});
