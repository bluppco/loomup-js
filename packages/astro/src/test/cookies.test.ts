import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clearTokens,
  DEFAULT_ACCESS_COOKIE,
  DEFAULT_REFRESH_COOKIE,
  isSecureDefault,
  readTokens,
  resolveCookieNames,
  writeTokens,
  type CookieStore,
} from "../cookies.js";

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

describe("cookie helpers", () => {
  it("resolveCookieNames uses defaults", () => {
    assert.deepEqual(resolveCookieNames(), {
      access: DEFAULT_ACCESS_COOKIE,
      refresh: DEFAULT_REFRESH_COOKIE,
    });
    assert.deepEqual(resolveCookieNames({ access: "a" }), {
      access: "a",
      refresh: DEFAULT_REFRESH_COOKIE,
    });
  });

  it("writeTokens / readTokens / clearTokens round-trip", () => {
    const cookies = mockCookies();
    writeTokens(cookies, {
      access_token: "acc",
      refresh_token: "ref",
      expires_in: 120,
    });
    assert.equal(cookies.jar.get(DEFAULT_ACCESS_COOKIE), "acc");
    assert.equal(cookies.jar.get(DEFAULT_REFRESH_COOKIE), "ref");

    const read = readTokens(cookies);
    assert.equal(read.access, "acc");
    assert.equal(read.refresh, "ref");

    clearTokens(cookies);
    assert.equal(cookies.jar.has(DEFAULT_ACCESS_COOKIE), false);
    assert.equal(cookies.jar.has(DEFAULT_REFRESH_COOKIE), false);
  });

  it("supports custom cookie names", () => {
    const cookies = mockCookies();
    const names = { access: "x-a", refresh: "x-r" };
    writeTokens(
      cookies,
      { access_token: "1", refresh_token: "2" },
      { names },
    );
    assert.equal(cookies.jar.get("x-a"), "1");
    assert.equal(readTokens(cookies, names).refresh, "2");
    clearTokens(cookies, { names });
    assert.equal(cookies.jar.size, 0);
  });

  it("isSecureDefault respects explicit and NODE_ENV", () => {
    assert.equal(isSecureDefault(true), true);
    assert.equal(isSecureDefault(false), false);
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    assert.equal(isSecureDefault(), true);
    process.env.NODE_ENV = "development";
    assert.equal(isSecureDefault(), false);
    process.env.NODE_ENV = prev;
  });
});
