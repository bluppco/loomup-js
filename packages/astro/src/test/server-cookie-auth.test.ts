import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoomupError, type AuthTokens } from "@loomup/client";
import { createServerClient, type CookieStore, type CookieWriteOptions } from "../server.js";
import { createLoomupAuthHandler } from "../auth.js";
import { normalizeAuthTokens } from "../authTokens.js";

const user = { id: "u1", email: "user@example.com", role: "user", disabled: false, created_at: 1 };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function cookieStore() {
  const jar = new Map<string, string>([["loomup-access", "old-access"], ["loomup-refresh", "refresh-1"]]);
  const writes: { name: string; value: string; options?: CookieWriteOptions }[] = [];
  const store: CookieStore = {
    get: (name) => jar.has(name) ? { value: jar.get(name)! } : undefined,
    set(name, value, options) {
      // Unlike the old Map-only mock, reject values that Astro cannot serialize.
      assert.equal(typeof value, "string");
      assert.ok(value.length);
      writes.push({ name, value, options });
      jar.set(name, value);
    },
    delete(name) { jar.delete(name); },
  };
  return { store, jar, writes };
}

function cookieResponse(generation = 2): Response {
  const headers = new Headers();
  headers.append("Set-Cookie", `loomup_access=access-${generation}; HttpOnly; Path=/`);
  headers.append("Set-Cookie", `loomup_refresh=refresh-${generation}; HttpOnly; Path=/`);
  return Response.json({ data: { access_token: `access-${generation}`, expires_in: 900, token_type: "Bearer", user } }, { headers });
}

describe("server cookie-mode authentication", () => {
  it("refreshes after access expiry and uses the rotated credential after grace expires", async () => {
    const { store, jar, writes } = cookieStore();
    jar.delete("loomup-access");
    let current = 1;
    const received: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const token = JSON.parse(String(init?.body)).refresh_token;
      received.push(token);
      // No grace: a predecessor is rejected immediately after rotation.
      if (token !== `refresh-${current}`) return Response.json({ error: { code: "invalid_token" } }, { status: 401 });
      return cookieResponse(++current);
    };
    const first = createServerClient(store, { url: "https://project.example" });
    await first.auth.refresh();
    assert.equal(first.accessToken, "access-2");
    assert.equal(first.refreshTokenValue, "refresh-2");
    assert.equal(jar.get("loomup-refresh"), "refresh-2");
    // A new SSR request reads only what the previous response persisted.
    const next = createServerClient(store, { url: "https://project.example" });
    await next.auth.refresh();
    assert.deepEqual(received, ["refresh-1", "refresh-2"]);
    assert.equal(jar.get("loomup-refresh"), "refresh-3");
    assert.equal(writes.length, 4);
  });

  for (const hasAccess of [false, true]) {
    it(`coalesces automatic me/table refresh with ${hasAccess ? "expired" : "missing"} access`, async () => {
      const { store, jar, writes } = cookieStore();
      if (!hasAccess) jar.delete("loomup-access");
      let exchanges = 0;
      globalThis.fetch = async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/auth/refresh") {
          exchanges++;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return cookieResponse();
        }
        if (new Headers(init?.headers).get("Authorization") !== "Bearer access-2") {
          return Response.json({ error: { code: "invalid_token" } }, { status: 401 });
        }
        return Response.json({ data: path === "/auth/me" ? user : [{ id: "item-1" }] });
      };
      const client = createServerClient(store, { url: "https://project.example" });
      const [me, rows] = await Promise.all([client.auth.me(), client.from("items").select()]);
      assert.equal(me.id, user.id);
      assert.deepEqual(rows.data, [{ id: "item-1" }]);
      assert.equal(exchanges, 1);
      assert.equal(writes.length, 2);
    });
  }

  for (const operation of ["signIn", "signUp", "oauth", "verification", "invitation"] as const) {
    it(`persists cookie-mode ${operation} before notifying observers`, async () => {
      const { store, jar, writes } = cookieStore();
      let notified = 0;
      let persistedBeforeNotification = false;
      globalThis.fetch = async () => cookieResponse();
      const client = createServerClient(store, {
        url: "https://project.example",
        client: { onTokens(tokens) {
          if (!tokens) return;
          notified++;
          persistedBeforeNotification = jar.get("loomup-refresh") === tokens.refresh_token;
        } },
      });
      const creds = { email: "user@example.com", password: "synthetic-password" };
      const result = operation === "signIn" ? await client.auth.signIn(creds)
        : operation === "signUp" ? await client.auth.signUp(creds)
          : operation === "oauth" ? await client.auth.exchangeOAuthCode({ code: "code", codeVerifier: "verifier" })
            : operation === "verification" ? await client.auth.confirmVerification("verification")
              : await client.auth.acceptInvitation({ token: "invitation", password: creds.password });
      assert.ok("refresh_token" in result);
      assert.equal(result.refresh_token, "refresh-2");
      assert.equal(client.refreshTokenValue, "refresh-2");
      assert.equal(writes.length, 2);
      assert.equal(notified, 1);
      assert.equal(persistedBeforeNotification, true);
    });
  }

  it("leaves verification-pending registration and non-auth responses unchanged", async () => {
    const { store, writes } = cookieStore();
    const pending = { verification_required: true, expires_in: 900, user };
    globalThis.fetch = async () => Response.json({ data: pending });
    const client = createServerClient(store, { url: "https://project.example" });
    assert.deepEqual(await client.auth.signUp({ email: user.email, password: "synthetic" }), pending);
    assert.deepEqual(await client.request("POST", "/api/commands/example", {}), { data: pending });
    assert.equal(client.accessToken, "old-access");
    assert.equal(writes.length, 0);
  });

  for (const data of [null, [], {}, { access_token: "new" }, { access_token: 1, refresh_token: "new" }, { access_token: "new", refresh_token: " " }]) {
    it(`rejects incomplete auth data without partial writes: ${JSON.stringify(data)}`, async () => {
      const { store, jar, writes } = cookieStore();
      let notified = 0;
      globalThis.fetch = async () => Response.json({ data });
      const client = createServerClient(store, { url: "https://project.example", client: { onTokens: () => { notified++; } } });
      await assert.rejects(client.auth.refresh(), (error: unknown) => error instanceof LoomupError && error.code === "invalid_response" && error.status === 502);
      assert.equal(client.accessToken, "old-access");
      assert.equal(client.refreshTokenValue, "refresh-1");
      assert.equal(jar.get("loomup-refresh"), "refresh-1");
      assert.equal(writes.length, 0);
      assert.equal(notified, 0);
    });
  }

  it("rejects non-JSON success, then permits a later refresh", async () => {
    const { store, writes } = cookieStore();
    const client = createServerClient(store, { url: "https://project.example" });
    globalThis.fetch = async () => new Response("upstream proxy page");
    await assert.rejects(client.auth.refresh(), { code: "invalid_response", status: 502 });
    assert.equal(writes.length, 0);
    globalThis.fetch = async () => cookieResponse();
    await client.auth.refresh();
    assert.equal(client.refreshTokenValue, "refresh-2");
  });

  for (const status of [401, 503]) {
    it(`preserves upstream ${status} and session state`, async () => {
      const { store, writes } = cookieStore();
      globalThis.fetch = async () => Response.json({ error: { code: status === 401 ? "invalid_token" : "unavailable" } }, { status });
      const client = createServerClient(store, { url: "https://project.example" });
      await assert.rejects(client.auth.refresh(), { status });
      assert.equal(client.accessToken, "old-access");
      assert.equal(client.refreshTokenValue, "refresh-1");
      assert.equal(writes.length, 0);
    });
  }

  it("persists setSession with custom cookie attributes and validates before writing", () => {
    const { store, jar, writes } = cookieStore();
    const client = createServerClient(store, { url: "https://project.example", cookies: {
      names: { access: "custom-access", refresh: "custom-refresh" }, secure: true, path: "/app", refreshMaxAge: 1200,
    } });
    client.setSession({ access_token: "manual-access", refresh_token: "manual-refresh", expires_in: 60 });
    assert.equal(jar.get("custom-refresh"), "manual-refresh");
    assert.deepEqual(writes.map((write) => write.options), [
      { path: "/app", httpOnly: true, secure: true, sameSite: "lax", maxAge: 60 },
      { path: "/app", httpOnly: true, secure: true, sameSite: "lax", maxAge: 1200 },
    ]);
    assert.throws(() => client.setSession({ access_token: "new", refresh_token: undefined } as unknown as AuthTokens), { code: "invalid_response" });
    assert.equal(writes.length, 2);
    assert.equal(client.refreshTokenValue, "manual-refresh");
  });

  it("propagates cookie persistence errors before applying client state", async () => {
    const { store } = cookieStore();
    store.set = () => { throw new Error("headers already sent"); };
    globalThis.fetch = async () => cookieResponse();
    let notified = false;
    const client = createServerClient(store, { url: "https://project.example", client: { onTokens: () => { notified = true; } } });
    await assert.rejects(client.auth.refresh(), /headers already sent/);
    assert.equal(client.accessToken, "old-access");
    assert.equal(client.refreshTokenValue, "refresh-1");
    assert.equal(notified, false);
  });

  it("uses the configured cookie lifetime when setSession has no expiry metadata", () => {
    const { store, writes } = cookieStore();
    const client = createServerClient(store, { url: "https://project.example", cookies: { accessMaxAge: 120 } });
    client.setSession({ access_token: "manual-access", refresh_token: "manual-refresh" });
    assert.equal(writes[0].options?.maxAge, 120);
  });

  it("the session endpoint also rejects a missing rotated credential", async () => {
    const { store, jar, writes } = cookieStore();
    globalThis.fetch = async () => Response.json({ data: { access_token: "new-access", user } });
    const handler = createLoomupAuthHandler({ url: "https://project.example" });
    const response = await handler({ cookies: store, params: { loomup: "refresh" }, request: new Request("https://app.example/api/loomup/refresh", { method: "POST" }) });
    assert.equal(response.status, 502);
    assert.equal(jar.get("loomup-refresh"), "refresh-1");
    assert.equal(writes.length, 0);
  });
});

describe("upstream auth cookie parsing", () => {
  for (const mode of ["getSetCookie", "getAll", "combined"] as const) {
    it(`reads ${mode} headers without splitting Expires commas`, () => {
      const values = [
        "unrelated=x; Expires=Wed, 09 Sep 2026 12:00:00 GMT; Path=/",
        "loomup_access=header-access; Expires=Wed, 09 Sep 2026 12:00:00 GMT; HttpOnly",
        'loomup_refresh="header-refresh"; Expires=Wed, 09 Sep 2026 12:00:00 GMT; HttpOnly',
      ];
      const headers = new Headers();
      values.forEach((value) => headers.append("Set-Cookie", value));
      if (mode !== "getSetCookie") Object.defineProperty(headers, "getSetCookie", { value: undefined });
      if (mode === "getAll") Object.defineProperty(headers, "getAll", { value: (name: string) => { assert.equal(name, "Set-Cookie"); return values; } });
      assert.deepEqual(normalizeAuthTokens({}, headers), { access_token: "header-access", refresh_token: "header-refresh" });
      assert.deepEqual(normalizeAuthTokens({ access_token: "json-access", refresh_token: "json-refresh" }, headers), { access_token: "json-access", refresh_token: "json-refresh" });
    });
  }
});
