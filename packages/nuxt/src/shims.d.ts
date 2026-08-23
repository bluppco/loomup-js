/** Ambient shims for Nuxt globals used in runtime plugin/composables. */

declare function defineNuxtPlugin<T = Record<string, unknown>>(
  plugin: (nuxtApp: {
    provide: (name: string, value: unknown) => void;
  }) => void | Promise<void> | { provide?: T },
): unknown;

declare function useNuxtApp(): {
  $loomup: import("./runtime/composables/useLoomup.js").LoomupPluginState;
};

declare function useRuntimeConfig(): {
  loomupUrl?: string;
  loomupCookies?: import("./types.js").SessionCookieOptions;
  loomupExposeAccessToken?: boolean;
  loomupSkewSeconds?: number;
  public: {
    loomupUrl?: string;
    loomupAuthBasePath?: string;
  };
};

declare module "nitropack/runtime" {
  export function useRuntimeConfig(event?: unknown): Record<string, unknown>;
}
