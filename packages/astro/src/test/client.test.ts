import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import {
  createAuthenticatedProject,
  createBrowserClient,
  createBrowserSessionCoordinator,
  LoomupError,
} from "../client.js";
import loomup from "../index.js";

describe("createBrowserClient", () => {
  it("uses explicit url", () => {
    const c = createBrowserClient({ url: "http://lb.test/" });
    assert.equal(c.url, "http://lb.test");
  });

  it("falls back to PUBLIC_LOOMUP_URL env", () => {
    const prev = process.env.PUBLIC_LOOMUP_URL;
    process.env.PUBLIC_LOOMUP_URL = "http://from-env.test";
    try {
      const c = createBrowserClient();
      assert.equal(c.url, "http://from-env.test");
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_LOOMUP_URL;
      else process.env.PUBLIC_LOOMUP_URL = prev;
    }
  });

  it("throws when no url available", () => {
    const prev = process.env.PUBLIC_LOOMUP_URL;
    delete process.env.PUBLIC_LOOMUP_URL;
    try {
      assert.throws(() => createBrowserClient(), /PUBLIC_LOOMUP_URL/);
    } finally {
      if (prev !== undefined) process.env.PUBLIC_LOOMUP_URL = prev;
    }
  });
});

describe("createAuthenticatedProject", () => {
  it("hydrates db.table property access from the Astro session endpoint", async () => {
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          data: {
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
      );
    }) as typeof fetch;
    const session = await createAuthenticatedProject<{
      issues: { id: string; title: string };
    }>({
      authEndpoint: "/api/loomup",
      fetch: fetchImpl,
    });
    assert.equal(session.user.id, "u1");
    assert.equal(session.db.issues.name, "issues");
    assert.equal(session.db.url, "/api/loomup/data");
    assert.deepEqual(requests, ["/api/loomup/session"]);
  });
});

describe("createBrowserSessionCoordinator", () => {
  it("serializes refresh across tabs and reloads the winning session", async () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    let tail: Promise<unknown> = Promise.resolve();
    const locks = {
      request<T>(
        _name: string,
        _options: LockOptions,
        callback: () => Promise<T>,
      ): Promise<T> {
        const result = tail.then(callback, callback);
        tail = result.then(() => undefined, () => undefined);
        return result;
      },
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks },
    });

    const token = (expiresAt: number) => {
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1_000) }))
        .toString("base64url");
      return `header.${payload}.signature`;
    };
    let generation = 0;
    let refreshes = 0;
    const options = {
      lockName: "/api/loomup",
      loadSession: async () => ({
        token: token(generation === 0 ? Date.now() - 1_000 : Date.now() + 900_000),
      }),
      refreshSession: async () => {
        refreshes += 1;
        generation += 1;
        return { token: token(Date.now() + 900_000) };
      },
      accessToken: (session: { token: string }) => session.token,
    };
    try {
      const firstTab = createBrowserSessionCoordinator(options);
      const secondTab = createBrowserSessionCoordinator(options);
      await Promise.all([firstTab.ensureFresh(), secondTab.ensureFresh()]);
      assert.equal(refreshes, 1);
      assert.equal(generation, 1);
    } finally {
      if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
      else delete (globalThis as { navigator?: Navigator }).navigator;
    }
  });

  it("uses an atomic IndexedDB lease when Web Locks are unavailable", async () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: new IDBFactory(),
    });

    const token = (expiresAt: number) => {
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1_000) }))
        .toString("base64url");
      return `header.${payload}.signature`;
    };
    let generation = 0;
    let refreshes = 0;
    const options = {
      lockName: "/api/loomup-indexed-db",
      loadSession: async () => ({
        token: token(generation === 0 ? Date.now() - 1_000 : Date.now() + 900_000),
      }),
      refreshSession: async () => {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        generation += 1;
        return { token: token(Date.now() + 900_000) };
      },
      accessToken: (session: { token: string }) => session.token,
    };
    try {
      const firstTab = createBrowserSessionCoordinator(options);
      const secondTab = createBrowserSessionCoordinator(options);
      await Promise.all([firstTab.ensureFresh(), secondTab.ensureFresh()]);
      assert.equal(refreshes, 1);
      assert.equal(generation, 1);
    } finally {
      if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
      else delete (globalThis as { navigator?: Navigator }).navigator;
      if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
      else delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    }
  });

  it("rechecks a terminal session result once before signing out", async () => {
    let calls = 0;
    const coordinator = createBrowserSessionCoordinator({
      loadSession: async () => {
        calls += 1;
        if (calls === 1) throw new LoomupError("lost rotation race", "invalid_token", 401);
        return { ok: true };
      },
    });
    assert.deepEqual(await coordinator.ensureFresh(), { ok: true });
    assert.equal(calls, 2);
  });
});

describe("loomup integration", () => {
  it("injects PUBLIC_LOOMUP_URL via vite define", () => {
    const integration = loomup({ url: "http://127.0.0.1:3000/" });
    assert.equal(integration.name, "@loomup/astro");

    let defined: Record<string, string> | undefined;
    integration.hooks["astro:config:setup"]?.({
      updateConfig(cfg) {
        defined = cfg.vite?.define;
      },
    });
    assert.deepEqual(defined, {
      "import.meta.env.PUBLIC_LOOMUP_URL": JSON.stringify(
        "http://127.0.0.1:3000",
      ),
    });
  });

  it("warns when url missing", () => {
    const prevL = process.env.LOOMUP_URL;
    const prevP = process.env.PUBLIC_LOOMUP_URL;
    delete process.env.LOOMUP_URL;
    delete process.env.PUBLIC_LOOMUP_URL;
    const warnings: string[] = [];
    try {
      const integration = loomup();
      integration.hooks["astro:config:setup"]?.({
        updateConfig() {},
        logger: {
          info() {},
          warn(msg) {
            warnings.push(msg);
          },
        },
      });
      assert.ok(warnings.some((w) => w.includes("no url configured")));
    } finally {
      if (prevL !== undefined) process.env.LOOMUP_URL = prevL;
      if (prevP !== undefined) process.env.PUBLIC_LOOMUP_URL = prevP;
    }
  });

  it("skips inject when injectPublicEnv is false", () => {
    let called = false;
    const integration = loomup({
      url: "http://x.test",
      injectPublicEnv: false,
    });
    integration.hooks["astro:config:setup"]?.({
      updateConfig() {
        called = true;
      },
    });
    assert.equal(called, false);
  });
});
