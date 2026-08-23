/**
 * Client plugin: shared Loomup client + session hydrate from /api/auth/session.
 */

import { createClient, type AuthTokens, type User } from "@loomup/client";
import type { LoomupPluginState } from "./composables/useLoomup.js";

// Nuxt auto-imports these when the plugin is loaded via addPlugin; declare for tsc.
declare function defineNuxtPlugin<T>(
  plugin: (nuxtApp: unknown) => void | Promise<void> | { provide?: T },
): unknown;

declare function useRuntimeConfig(): {
  public: {
    loomupUrl?: string;
    loomupAuthBasePath?: string;
  };
};

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig();
  const url = (
    config.public?.loomupUrl ||
    "http://127.0.0.1:3000"
  ).replace(/\/$/, "");
  const authBase = config.public?.loomupAuthBasePath || "/api/auth";

  let user: User | null = null;
  let accessToken: string | undefined;

  const client = createClient({
    url,
    onTokens: (tokens) => {
      if (tokens === null) {
        accessToken = undefined;
        user = null;
        return;
      }
      accessToken = tokens.access_token;
      if (tokens.user) user = tokens.user;
    },
  });

  function setSession(tokens: AuthTokens | null) {
    if (tokens === null) {
      accessToken = undefined;
      user = null;
      client.setToken(undefined);
      return;
    }
    accessToken = tokens.access_token;
    if (tokens.user) user = tokens.user;
    // Prefer setSession when refresh is present; otherwise access only.
    if (tokens.refresh_token) {
      client.setSession({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        user: tokens.user,
      });
    } else {
      client.setToken(tokens.access_token);
    }
  }

  async function refreshSession() {
    try {
      const res = await fetch(`${authBase}/session`, {
        credentials: "same-origin",
      });
      if (!res.ok) {
        setSession(null);
        return;
      }
      const json = (await res.json()) as {
        data?: {
          user?: User | null;
          access_token?: string;
          session?: null;
        };
      };
      const data = json.data;
      if (!data?.user && !data?.access_token) {
        setSession(null);
        return;
      }
      user = data.user ?? null;
      if (data.access_token) {
        accessToken = data.access_token;
        client.setToken(data.access_token);
      }
    } catch {
      /* offline / not ready */
    }
  }

  const state: LoomupPluginState = {
    get client() {
      return client;
    },
    get user() {
      return user;
    },
    get accessToken() {
      return accessToken;
    },
    setSession,
    refreshSession,
  };

  void refreshSession();

  return {
    provide: {
      loomup: state,
    },
  };
});
