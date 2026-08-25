import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLoomupAuthHandler } from "../auth.js";
import type { CookieStore } from "../cookies.js";

function cookies(): CookieStore & { jar: Map<string, string> } {
  const jar = new Map<string, string>();
  return {
    jar,
    get(name) {
      const value = jar.get(name);
      return value == null ? undefined : { value };
    },
    set(name, value) {
      jar.set(name, value);
    },
    delete(name) {
      jar.delete(name);
    },
  };
}

describe("createLoomupAuthHandler", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("keeps tokens in httpOnly cookies and returns only the user", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            access_token: "access-1",
            refresh_token: "refresh-secret",
            token_type: "Bearer",
            expires_in: 900,
            user: {
              id: "u1",
              email: "user@example.com",
              role: "user",
              disabled: false,
              created_at: 1,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const store = cookies();
    const handler = createLoomupAuthHandler({ url: "https://project.example" });
    const result = await handler({
      cookies: store,
      params: { loomup: "login" },
      request: new Request("https://app.example/api/loomup/login", {
        method: "POST",
        headers: { Origin: "https://app.example", "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@example.com", password: "password-12" }),
      }),
    });
    const body = (await result.json()) as { data: Record<string, unknown> };
    assert.equal("access_token" in body.data, false);
    assert.equal("refresh_token" in body.data, false);
    assert.equal(store.jar.get("loomup-refresh"), "refresh-secret");
  });

  it("bridges Loomup cookie-mode login tokens into app cookies", async () => {
    globalThis.fetch = (async () => {
      const headers = new Headers({ "Content-Type": "application/json" });
      headers.append("Set-Cookie", "loomup_access=access-cookie; Path=/; HttpOnly; SameSite=Lax");
      headers.append("Set-Cookie", "loomup_refresh=refresh-cookie; Path=/; HttpOnly; SameSite=Lax");
      return new Response(
        JSON.stringify({
          data: {
            access_token: "access-cookie",
            token_type: "Bearer",
            expires_in: 900,
            user: {
              id: "u1",
              email: "user@example.com",
              role: "user",
              disabled: false,
              created_at: 1,
            },
          },
        }),
        { status: 200, headers },
      );
    }) as typeof fetch;
    const store = cookies();
    const handler = createLoomupAuthHandler({ url: "https://project.example" });
    const result = await handler({
      cookies: store,
      params: { loomup: "login" },
      request: new Request("https://app.example/api/loomup/login", {
        method: "POST",
        headers: { Origin: "https://app.example", "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@example.com", password: "password-12" }),
      }),
    });

    assert.equal(result.status, 200);
    assert.equal(store.jar.get("loomup-access"), "access-cookie");
    assert.equal(store.jar.get("loomup-refresh"), "refresh-cookie");
  });

  it("uses and rotates cookie-mode refresh tokens", async () => {
    let receivedRefresh: unknown;
    globalThis.fetch = (async (_input, init) => {
      receivedRefresh = JSON.parse(String(init?.body)).refresh_token;
      const headers = new Headers({ "Content-Type": "application/json" });
      headers.append("Set-Cookie", "loomup_access=access-2; Path=/; HttpOnly");
      headers.append("Set-Cookie", "loomup_refresh=refresh-2; Path=/; HttpOnly");
      return new Response(
        JSON.stringify({
          data: {
            access_token: "access-2",
            expires_in: 900,
            user: {
              id: "u1",
              email: "user@example.com",
              role: "user",
              disabled: false,
              created_at: 1,
            },
          },
        }),
        { status: 200, headers },
      );
    }) as typeof fetch;
    const store = cookies();
    store.jar.set("loomup-refresh", "refresh-1");
    const handler = createLoomupAuthHandler({ url: "https://project.example" });
    const result = await handler({
      cookies: store,
      params: { loomup: "refresh" },
      request: new Request("https://app.example/api/loomup/refresh", {
        method: "POST",
        headers: { Origin: "https://app.example" },
      }),
    });

    assert.equal(result.status, 200);
    assert.equal(receivedRefresh, "refresh-1");
    assert.equal(store.jar.get("loomup-access"), "access-2");
    assert.equal(store.jar.get("loomup-refresh"), "refresh-2");
  });

  it("hydrates a session by refreshing when the access cookie is absent", async () => {
    globalThis.fetch = (async (_input, init) => {
      assert.equal(JSON.parse(String(init?.body)).refresh_token, "refresh-1");
      const headers = new Headers({ "Content-Type": "application/json" });
      headers.append("Set-Cookie", "loomup_access=access-2; Path=/; HttpOnly");
      headers.append("Set-Cookie", "loomup_refresh=refresh-2; Path=/; HttpOnly");
      return new Response(
        JSON.stringify({
          data: {
            access_token: "access-2",
            user: {
              id: "u1",
              email: "user@example.com",
              role: "user",
              disabled: false,
              created_at: 1,
            },
          },
        }),
        { status: 200, headers },
      );
    }) as typeof fetch;
    const store = cookies();
    store.jar.set("loomup-refresh", "refresh-1");
    const result = await createLoomupAuthHandler({ url: "https://project.example" })({
      cookies: store,
      params: { loomup: "session" },
      request: new Request("https://app.example/api/loomup/session"),
    });

    assert.equal(result.status, 200);
    assert.equal(store.jar.get("loomup-access"), "access-2");
    assert.equal(store.jar.get("loomup-refresh"), "refresh-2");
  });

  it("proxies data through the server-held access cookie", async () => {
    let target = "";
    let authorization = "";
    globalThis.fetch = (async (input, init) => {
      target = String(input);
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return Response.json({ data: { id: "1", name: "Mohit" } });
    }) as typeof fetch;
    const store = cookies();
    store.jar.set("loomup-access", "access-secret");
    const result = await createLoomupAuthHandler({ url: "https://project.example/p/one" })({
      cookies: store,
      params: { loomup: "data/api/user/1" },
      request: new Request("https://app.example/api/loomup/data/api/user/1?view=full"),
    });

    assert.equal(result.status, 200);
    assert.equal(target, "https://project.example/p/one/api/user/1?view=full");
    assert.equal(authorization, "Bearer access-secret");
    assert.deepEqual(await result.json(), { data: { id: "1", name: "Mohit" } });
  });

  it("rejects cross-origin data mutations before proxying", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return Response.json({ data: {} });
    }) as typeof fetch;
    const store = cookies();
    store.jar.set("loomup-access", "access-secret");
    const result = await createLoomupAuthHandler({ url: "https://project.example" })({
      cookies: store,
      params: { loomup: "data/api/issues" },
      request: new Request("https://app.example/api/loomup/data/api/issues", {
        method: "POST",
        headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
        body: JSON.stringify({ title: "No" }),
      }),
    });

    assert.equal(result.status, 403);
    assert.equal(called, false);
  });

  it("rejects cross-origin auth mutations", async () => {
    const handler = createLoomupAuthHandler({ url: "https://project.example" });
    const result = await handler({
      cookies: cookies(),
      params: { loomup: "logout" },
      request: new Request("https://app.example/api/loomup/logout", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      }),
    });
    assert.equal(result.status, 403);
  });

  it("does not relay an unsolicited OAuth provider error", async () => {
    const result = await createLoomupAuthHandler({
      url: "https://project.example",
      oauthCallbackUrl: "https://app.example/api/loomup/oauth/callback",
    })({
      cookies: cookies(),
      params: { loomup: "oauth/callback" },
      request: new Request("https://app.example/api/loomup/oauth/callback?error=registration_disabled"),
    });
    assert.equal(result.status, 400);
    assert.equal(((await result.json()) as { error: { code: string } }).error.code, "oauth_flow_expired");
  });
});
