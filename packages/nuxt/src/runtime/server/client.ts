/**
 * Server-side Loomup client for Nuxt / Nitro (event handlers, SSR).
 *
 * Tokens live in HttpOnly cookies on the Nuxt origin. REST only — do not call
 * subscribe() during SSR.
 */

import type {
  DefaultInsertMap,
  DefaultTableMap,
  DefaultUpdateMap,
  LoomupClient,
} from "@loomup/client";
import { createClientFromCookies } from "./storage.js";
import type {
  CookieMethods,
  CookieRecord,
  CookieSerializeOptions,
  SessionCookieOptions,
} from "../../types.js";

/**
 * Minimal h3 event surface for cookie get/set.
 * Compatible with H3Event without importing h3 at type level for tests.
 */
export type H3EventLike = {
  node?: {
    req?: { headers?: { cookie?: string | string[] } };
  };
  /** Optional pre-parsed cookie map (tests / custom adapters). */
  __loomupCookies?: Map<string, string>;
};

export type CookieAdapter = {
  // Use a wide event type so h3 H3Event is assignable without structural friction.
  getCookie: (event: H3EventLike | unknown, name: string) => string | undefined;
  setCookie: (
    event: H3EventLike | unknown,
    name: string,
    value: string,
    options?: CookieSerializeOptions,
  ) => void;
};

export type CreateServerClientOptions = {
  url: string;
  cookieOptions?: SessionCookieOptions;
  /**
   * Either a full CookieMethods jar, or an h3-like event + cookie adapter.
   * When `event` is provided without `cookies`, uses getCookie/setCookie from
   * `cookieAdapter` or a built-in parse of the Cookie header + in-memory set.
   */
  cookies?: CookieMethods;
  event?: H3EventLike;
  cookieAdapter?: CookieAdapter;
};

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!header) return map;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) map.set(name, value);
  }
  return map;
}

function cookieHeaderFromEvent(event: H3EventLike): string | undefined {
  const raw = event.node?.req?.headers?.cookie;
  if (Array.isArray(raw)) return raw.join("; ");
  return raw;
}

/**
 * Build CookieMethods from an h3-like event.
 * Uses cookieAdapter when provided; otherwise parses the request Cookie header
 * and stores writes on event.__loomupCookies (and adapter if later set).
 */
export function cookieMethodsFromEvent(
  event: H3EventLike,
  adapter?: CookieAdapter,
): CookieMethods {
  if (!event.__loomupCookies) {
    event.__loomupCookies = parseCookieHeader(cookieHeaderFromEvent(event));
  }
  const jar = event.__loomupCookies;

  return {
    getAll: () => {
      if (adapter) {
        // Re-read known names is hard without listing; prefer jar sync.
        return Array.from(jar.entries()).map(([name, value]) => ({
          name,
          value,
        }));
      }
      return Array.from(jar.entries()).map(([name, value]) => ({
        name,
        value,
      }));
    },
    setAll: (records: CookieRecord[]) => {
      for (const c of records) {
        if (c.value === "" || c.options?.maxAge === 0) {
          jar.delete(c.name);
        } else {
          jar.set(c.name, c.value);
        }
        if (adapter) {
          adapter.setCookie(event, c.name, c.value, c.options);
        }
      }
    },
  };
}

/**
 * Prefer this when you already have h3's getCookie/setCookie:
 *
 * ```ts
 * import { getCookie, setCookie } from "h3";
 * const client = createServerClient({
 *   url,
 *   event,
 *   cookieAdapter: { getCookie, setCookie },
 * });
 * ```
 */
export function createServerClient<
  TMap extends DefaultTableMap = DefaultTableMap,
  TInsertMap extends DefaultInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap extends DefaultUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
>(
  options: CreateServerClientOptions,
): LoomupClient<TMap, TInsertMap, TUpdateMap> {
  let methods: CookieMethods;

  if (options.cookies) {
    methods = options.cookies;
  } else if (options.event) {
    const event = options.event;
    // Seed jar from adapter if available
    if (options.cookieAdapter && !event.__loomupCookies) {
      event.__loomupCookies = new Map();
      // Adapter cannot list all cookies; jar starts empty and gets filled
      // when we know names — seed from Cookie header first.
      event.__loomupCookies = parseCookieHeader(
        cookieHeaderFromEvent(event),
      );
    }
    methods = cookieMethodsFromEvent(event, options.cookieAdapter);
  } else {
    throw new Error(
      "@loomup/nuxt: createServerClient requires `cookies` or `event`",
    );
  }

  return createClientFromCookies<TMap, TInsertMap, TUpdateMap>({
    url: options.url,
    cookies: methods,
    cookieOptions: options.cookieOptions,
  });
}

// Object storage helpers (FormData upload / download Response)
export {
  fileAndPathFromFormData,
  uploadFromFormData,
  storageDownloadResponse,
  type UploadFormDataOptions,
} from "./objectStorage.js";

/**
 * Resolve Loomup URL from Nuxt runtime config shape.
 */
export function resolveLoomupUrl(config: {
  loomupUrl?: string;
  public?: { loomupUrl?: string };
}): string {
  const url =
    config.loomupUrl ||
    config.public?.loomupUrl ||
    (typeof process !== "undefined"
      ? process.env?.LOOMUP_URL ||
        process.env?.NUXT_LOOMUP_URL ||
        process.env?.NUXT_PUBLIC_LOOMUP_URL
      : undefined);
  if (!url) {
    throw new Error(
      "@loomup/nuxt: set loomup.url / runtimeConfig.loomupUrl / NUXT_PUBLIC_LOOMUP_URL",
    );
  }
  return url.replace(/\/$/, "");
}
