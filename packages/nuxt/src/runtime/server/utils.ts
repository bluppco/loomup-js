/**
 * Nitro runtime helpers: resolve URL + h3 cookie adapter.
 */

import { getCookie, setCookie, type H3Event } from "h3";
import type { SessionCookieOptions, CookieSerializeOptions } from "../../types.js";
import {
  createServerClient,
  resolveLoomupUrl,
  type CookieAdapter,
} from "./client.js";
import { createAuthHandlers } from "./authHandlers.js";
import { updateSession } from "./session.js";

/** Minimal runtime config shape we read from Nitro. */
export type LoomupRuntimeConfig = {
  loomupUrl?: string;
  loomupCookies?: SessionCookieOptions;
  loomupExposeAccessToken?: boolean;
  loomupSkewSeconds?: number;
  public?: { loomupUrl?: string };
};

/**
 * Read runtime config seeded by the Nitro plugin, or environment fallbacks.
 */
export function runtimeConfigFromEvent(event: H3Event): LoomupRuntimeConfig {
  const ctx = event.context as {
    nitro?: { runtimeConfig?: LoomupRuntimeConfig };
  };
  if (ctx.nitro?.runtimeConfig) {
    return ctx.nitro.runtimeConfig;
  }

  return {
    loomupUrl:
      process.env.NUXT_LOOMUP_URL ||
      process.env.LOOMUP_URL ||
      process.env.NUXT_PUBLIC_LOOMUP_URL,
    public: {
      loomupUrl:
        process.env.NUXT_PUBLIC_LOOMUP_URL ||
        process.env.LOOMUP_URL ||
        process.env.NUXT_LOOMUP_URL,
    },
  };
}

function cookieAdapter(): CookieAdapter {
  return {
    getCookie: (event, name) => getCookie(event as H3Event, name),
    setCookie: (event, name, value, options?: CookieSerializeOptions) => {
      setCookie(event as H3Event, name, value, options);
    },
  };
}

export function getLoomupServerContext(event: H3Event) {
  const config = runtimeConfigFromEvent(event);
  const url = resolveLoomupUrl({
    loomupUrl: config.loomupUrl,
    public: config.public,
  });
  return {
    url,
    cookieOptions: config.loomupCookies,
    exposeAccessToken: config.loomupExposeAccessToken !== false,
    cookieAdapter: cookieAdapter(),
    skewSeconds: config.loomupSkewSeconds ?? 60,
  };
}

export function serverClient(event: H3Event) {
  const ctx = getLoomupServerContext(event);
  return createServerClient({
    url: ctx.url,
    event,
    cookieAdapter: ctx.cookieAdapter,
    cookieOptions: ctx.cookieOptions,
  });
}

export function authHandlers(event: H3Event) {
  const ctx = getLoomupServerContext(event);
  return createAuthHandlers({
    url: ctx.url,
    cookieOptions: ctx.cookieOptions,
    exposeAccessToken: ctx.exposeAccessToken,
    cookieAdapter: ctx.cookieAdapter,
  });
}

export async function runSessionUpdate(event: H3Event) {
  const ctx = getLoomupServerContext(event);
  return updateSession({
    url: ctx.url,
    event,
    cookieAdapter: ctx.cookieAdapter,
    cookieOptions: ctx.cookieOptions,
    skewSeconds: ctx.skewSeconds,
  });
}

export {
  createServerClient,
  resolveLoomupUrl,
  createAuthHandlers,
  updateSession,
};
