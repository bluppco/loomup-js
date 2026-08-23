/**
 * @loomup/astro — Astro integration for Loomup Realtime.
 *
 * Server helpers: `@loomup/astro/server`
 * Browser helpers: `@loomup/astro/client`
 * Middleware: `@loomup/astro/middleware`
 */

export type LoomupIntegrationOptions = {
  /**
   * Loomup server URL (e.g. http://127.0.0.1:3000).
   * Falls back to process.env.LOOMUP_URL or PUBLIC_LOOMUP_URL.
   */
  url?: string;
  /**
   * When true (default), inject PUBLIC_LOOMUP_URL for browser islands
   * via Vite env.
   */
  injectPublicEnv?: boolean;
};

/** Structural Astro integration type (avoids hard dep on astro types at build). */
export type AstroIntegrationLike = {
  name: string;
  hooks: {
    "astro:config:setup"?: (params: {
      updateConfig: (config: {
        vite?: {
          define?: Record<string, string>;
          envPrefix?: string | string[];
        };
      }) => void;
      logger?: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
      };
    }) => void | Promise<void>;
  };
};

function resolveUrl(options?: LoomupIntegrationOptions): string | undefined {
  if (options?.url) return options.url.replace(/\/$/, "");
  if (typeof process !== "undefined") {
    const v =
      process.env?.LOOMUP_URL || process.env?.PUBLIC_LOOMUP_URL;
    if (v) return v.replace(/\/$/, "");
  }
  return undefined;
}

/**
 * Astro integration: wires PUBLIC_LOOMUP_URL for `createBrowserClient()`.
 *
 * @example
 * ```ts
 * // astro.config.mjs
 * import { defineConfig } from "astro/config";
 * import loomup from "@loomup/astro";
 *
 * export default defineConfig({
 *   integrations: [loomup({ url: process.env.LOOMUP_URL })],
 * });
 * ```
 */
export default function loomup(
  options: LoomupIntegrationOptions = {},
): AstroIntegrationLike {
  const inject = options.injectPublicEnv !== false;

  return {
    name: "@loomup/astro",
    hooks: {
      "astro:config:setup"({ updateConfig, logger }) {
        const url = resolveUrl(options);
        if (!url) {
          logger?.warn(
            "@loomup/astro: no url configured (pass loomup({ url }) or set LOOMUP_URL). Browser client will need an explicit url.",
          );
          return;
        }
        if (!inject) return;

        // Vite define values must be JSON-serialized so they become string literals.
        updateConfig({
          vite: {
            define: {
              "import.meta.env.PUBLIC_LOOMUP_URL": JSON.stringify(url),
            },
          },
        });
        logger?.info(`@loomup/astro: PUBLIC_LOOMUP_URL → ${url}`);
      },
    },
  };
}

export type { LoomupIntegrationOptions as LoomupOptions };
