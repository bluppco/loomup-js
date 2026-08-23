import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  accessNeedsRefresh,
  clearSessionCookies,
  DEFAULT_ACCESS_COOKIE,
  DEFAULT_REFRESH_COOKIE,
  jwtExpiresAt,
  readTokensFromCookies,
  serializeCookie,
  sessionCookiesFromTokens,
} from "../cookies.js";

function makeJwt(exp: number): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp, sub: "u1" })).toString(
    "base64url",
  );
  return `${header}.${payload}.sig`;
}

describe("cookies", () => {
  it("sessionCookiesFromTokens uses default names and httpOnly", () => {
    const cookies = sessionCookiesFromTokens({
      access_token: "a",
      refresh_token: "r",
      expires_in: 120,
    });
    assert.equal(cookies.length, 2);
    assert.equal(cookies[0].name, DEFAULT_ACCESS_COOKIE);
    assert.equal(cookies[0].value, "a");
    assert.equal(cookies[0].options?.maxAge, 120);
    assert.equal(cookies[0].options?.httpOnly, true);
    assert.equal(cookies[0].options?.sameSite, "lax");
    assert.equal(cookies[1].name, DEFAULT_REFRESH_COOKIE);
    assert.equal(cookies[1].value, "r");
  });

  it("clearSessionCookies zeroes maxAge", () => {
    const cookies = clearSessionCookies();
    assert.ok(cookies.every((c) => c.options?.maxAge === 0 && c.value === ""));
  });

  it("readTokensFromCookies finds both", () => {
    const t = readTokensFromCookies([
      { name: DEFAULT_ACCESS_COOKIE, value: "ax" },
      { name: DEFAULT_REFRESH_COOKIE, value: "rx" },
      { name: "other", value: "z" },
    ]);
    assert.deepEqual(t, { access: "ax", refresh: "rx" });
  });

  it("serializeCookie builds Set-Cookie string", () => {
    const s = serializeCookie("loomup-access", "tok", {
      httpOnly: true,
      path: "/",
      maxAge: 60,
      sameSite: "lax",
      secure: true,
    });
    assert.ok(s.includes("loomup-access=tok"));
    assert.ok(s.includes("HttpOnly"));
    assert.ok(s.includes("Path=/"));
    assert.ok(s.includes("Max-Age=60"));
    assert.ok(s.includes("SameSite=Lax"));
    assert.ok(s.includes("Secure"));
  });

  it("jwtExpiresAt and accessNeedsRefresh", () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = makeJwt(now + 3600);
    const expired = makeJwt(now - 10);
    assert.equal(jwtExpiresAt(fresh), now + 3600);
    assert.equal(accessNeedsRefresh(fresh, 60), false);
    assert.equal(accessNeedsRefresh(expired, 60), true);
    assert.equal(accessNeedsRefresh(undefined), true);
    assert.equal(accessNeedsRefresh("not-a-jwt"), false);
  });
});
