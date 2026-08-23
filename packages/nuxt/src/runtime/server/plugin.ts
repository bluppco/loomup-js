/**
 * Nitro plugin: attach runtime config onto event.context for handlers.
 */

import type { H3Event } from "h3";
import type { LoomupRuntimeConfig } from "./utils.js";

declare function defineNitroPlugin(
  plugin: (nitro: {
    hooks: {
      hook: (
        name: "request",
        handler: (event: H3Event) => void | Promise<void>,
      ) => void;
    };
  }) => void,
): unknown;

declare function useRuntimeConfig(event?: H3Event): LoomupRuntimeConfig;

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook("request", (event) => {
    try {
      const config = useRuntimeConfig(event);
      const ctx = event.context as {
        nitro?: { runtimeConfig?: LoomupRuntimeConfig };
      };
      ctx.nitro = ctx.nitro || {};
      ctx.nitro.runtimeConfig = config as LoomupRuntimeConfig;
    } catch {
      /* config not ready */
    }
  });
});
