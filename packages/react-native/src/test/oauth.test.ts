import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoomupError } from "@loomup/client";
import { createNativeClient } from "../createNativeClient.js";
import { signInWithOAuth } from "../oauth.js";

describe("signInWithOAuth", () => {
  it("keeps the verifier inside the helper and applies exchanged tokens", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/auth/oauth/authorize")) {
        return Response.json({ data: { authorization_url: "https://accounts.test/authorize", code_verifier: "native-verifier", expires_in: 600 } });
      }
      assert.deepEqual(JSON.parse(String(init?.body)), { code: "native-code", code_verifier: "native-verifier" });
      return Response.json({ data: { access_token: "native-access", refresh_token: "native-refresh", token_type: "Bearer", expires_in: 900, user: { id: "u1", email: "a@b.com", role: "user", disabled: false, created_at: 1 } } });
    }) as typeof fetch;
    try {
      const client = createNativeClient({ url: "https://api.test" });
      const tokens = await signInWithOAuth(client, {
        provider: "google",
        redirectTo: "com.example.app:/auth/callback",
        openAuthSession: async (authorizationUrl, redirectTo) => {
          assert.equal(authorizationUrl, "https://accounts.test/authorize");
          assert.equal(redirectTo, "com.example.app:/auth/callback");
          return "com.example.app:/auth/callback?code=native-code";
        },
      });
      assert.equal(tokens.access_token, "native-access");
      assert.equal(client.accessToken, "native-access");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects callbacks for another redirect target", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      data: {
        authorization_url: "https://accounts.test/authorize",
        code_verifier: "native-verifier",
        expires_in: 600,
      },
    })) as typeof fetch;
    try {
      const client = createNativeClient({ url: "https://api.test" });
      await assert.rejects(
        signInWithOAuth(client, {
          provider: "google",
          redirectTo: "com.example.app:/auth/callback",
          openAuthSession: async () => "com.attacker.app:/auth/callback?code=stolen",
        }),
        (error: unknown) => error instanceof LoomupError
          && error.code === "oauth_callback_mismatch",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
