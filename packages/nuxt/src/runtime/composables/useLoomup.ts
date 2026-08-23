/**
 * Access the shared browser Loomup client provided by the Nuxt plugin.
 */

import type { LoomupClient } from "@loomup/client";

export type LoomupPluginState = {
  client: LoomupClient;
  user: import("@loomup/client").User | null;
  accessToken: string | undefined;
  setSession: (
    tokens: import("@loomup/client").AuthTokens | null,
  ) => void;
  refreshSession: () => Promise<void>;
};

/**
 * Structural Nuxt app interface so this file typechecks without a full Nuxt
 * build graph. At runtime Nuxt injects `$loomup`.
 */
type NuxtAppLike = {
  $loomup: LoomupPluginState;
};

declare function useNuxtApp(): NuxtAppLike;

export function useLoomup(): LoomupClient {
  const app = useNuxtApp();
  if (!app.$loomup?.client) {
    throw new Error(
      "@loomup/nuxt: Loomup client not available. Add modules: ['@loomup/nuxt'] and ensure the client plugin runs.",
    );
  }
  return app.$loomup.client;
}

export function useLoomupState(): LoomupPluginState {
  const app = useNuxtApp();
  if (!app.$loomup) {
    throw new Error(
      "@loomup/nuxt: Loomup state not available. Add modules: ['@loomup/nuxt'].",
    );
  }
  return app.$loomup;
}
