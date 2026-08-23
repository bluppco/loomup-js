import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createServerClient,
  cookieMethodsFromEvent,
  resolveLoomupUrl,
  type H3EventLike,
} from "../runtime/server/client.js";
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

describe("createServerClient", () => {
  it("reads tokens from CookieMethods", () => {
    const cookies = mockCookies({
      [DEFAULT_ACCESS_COOKIE]: "from-cookie",
      [DEFAULT_REFRESH_COOKIE]: "refresh-cookie",
    });
    const client = createServerClient({
      url: "http://lb.test",
      cookies,
    });
    assert.equal(client.accessToken, "from-cookie");
    assert.equal(client.url, "http://lb.test");
  });

  it("reads tokens from event Cookie header", () => {
    const event: H3EventLike = {
      node: {
        req: {
          headers: {
            cookie: `${DEFAULT_ACCESS_COOKIE}=ev-access; ${DEFAULT_REFRESH_COOKIE}=ev-refresh`,
          },
        },
      },
    };
    const client = createServerClient({
      url: "http://lb.test",
      event,
    });
    assert.equal(client.accessToken, "ev-access");
  });

  it("cookieMethodsFromEvent setAll updates jar", () => {
    const event: H3EventLike = {
      node: { req: { headers: { cookie: "" } } },
    };
    const methods = cookieMethodsFromEvent(event);
    methods.setAll([
      {
        name: DEFAULT_ACCESS_COOKIE,
        value: "a1",
        options: { maxAge: 60, path: "/", httpOnly: true },
      },
    ]);
    assert.equal(
      methods.getAll().find((c) => c.name === DEFAULT_ACCESS_COOKIE)?.value,
      "a1",
    );
  });

  it("resolveLoomupUrl prefers explicit then env", () => {
    assert.equal(
      resolveLoomupUrl({ loomupUrl: "http://a.test/" }),
      "http://a.test",
    );
    assert.equal(
      resolveLoomupUrl({ public: { loomupUrl: "http://b.test" } }),
      "http://b.test",
    );
  });

  it("requires cookies or event", () => {
    assert.throws(
      () => createServerClient({ url: "http://lb.test" }),
      /requires `cookies` or `event`/,
    );
  });
});
