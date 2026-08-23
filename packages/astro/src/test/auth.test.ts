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

  it("keeps refresh tokens in httpOnly cookies and returns only access", async () => {
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
    assert.equal(body.data.access_token, "access-1");
    assert.equal("refresh_token" in body.data, false);
    assert.equal(store.jar.get("loomup-refresh"), "refresh-secret");
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
});
