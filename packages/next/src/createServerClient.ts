/**
 * App Router server client — Server Components, Server Actions, Route Handlers.
 *
 * Pass Next's `cookies` from `next/headers` (or a custom CookieMethods jar).
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
} from "./types.js";

/** Subset of next/headers cookies() return type we need. */
export type NextCookiesStore = {
  getAll: () => { name: string; value: string }[];
  set: (
    name: string,
    value: string,
    options?: CookieSerializeOptions,
  ) => void;
};

export type CreateServerClientOptions = {
  url: string;
  /**
   * Either Next's `cookies` function from `next/headers`, a resolved cookie
   * store, or a full CookieMethods adapter.
   */
  cookies:
    | CookieMethods
    | NextCookiesStore
    | (() => NextCookiesStore | Promise<NextCookiesStore>);
  cookieOptions?: SessionCookieOptions;
};

function isCookieMethods(x: unknown): x is CookieMethods {
  return (
    typeof x === "object" &&
    x !== null &&
    "getAll" in x &&
    "setAll" in x &&
    typeof (x as CookieMethods).setAll === "function"
  );
}

function toCookieMethods(store: NextCookiesStore): CookieMethods {
  return {
    getAll: () => store.getAll(),
    setAll: (records: CookieRecord[]) => {
      for (const c of records) {
        try {
          store.set(c.name, c.value, c.options);
        } catch {
          // In pure Server Components, set may throw if the response has
          // already started. Middleware / Route Handlers / Server Actions can set.
        }
      }
    },
  };
}

/**
 * Create a Loomup client bound to Next.js App Router cookies.
 * REST-only on the server (do not call subscribe).
 */
export async function createServerClient<
  TMap extends DefaultTableMap = DefaultTableMap,
  TInsertMap extends DefaultInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap extends DefaultUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
>(
  options: CreateServerClientOptions,
): Promise<LoomupClient<TMap, TInsertMap, TUpdateMap>> {
  let methods: CookieMethods;

  if (isCookieMethods(options.cookies)) {
    methods = options.cookies;
  } else if (typeof options.cookies === "function") {
    const store = await options.cookies();
    methods = toCookieMethods(store);
  } else {
    methods = toCookieMethods(options.cookies);
  }

  return createClientFromCookies<TMap, TInsertMap, TUpdateMap>({
    url: options.url,
    cookies: methods,
    cookieOptions: options.cookieOptions,
  });
}
