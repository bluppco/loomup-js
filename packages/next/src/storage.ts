/**
 * Wire a CookieMethods jar to createClient onTokens / initial tokens.
 */

import {
  createClient,
  type AuthTokens,
  type CreateClientOptions,
  type DefaultInsertMap,
  type DefaultTableMap,
  type DefaultUpdateMap,
  type LoomupClient,
} from "@loomup/client";
import {
  clearSessionCookies,
  readTokensFromCookies,
  sessionCookiesFromTokens,
} from "./cookies.js";
import type { CookieMethods, SessionCookieOptions } from "./types.js";

export type CreateClientFromCookiesOptions = {
  url: string;
  cookies: CookieMethods;
  cookieOptions?: SessionCookieOptions;
  /** Extra createClient options (e.g. WebSocketImpl). */
  clientOptions?: Omit<
    CreateClientOptions,
    "url" | "token" | "refreshToken" | "onTokens"
  >;
};

/**
 * Build a LoomupClient that reads initial tokens from cookies and writes
 * rotations / logout back via CookieMethods.setAll.
 */
export function createClientFromCookies<
  TMap extends DefaultTableMap = DefaultTableMap,
  TInsertMap extends DefaultInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap extends DefaultUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
>(
  options: CreateClientFromCookiesOptions,
): LoomupClient<TMap, TInsertMap, TUpdateMap> {
  const { access, refresh } = readTokensFromCookies(
    options.cookies.getAll(),
    options.cookieOptions,
  );

  const onTokens = (tokens: AuthTokens | null) => {
    if (tokens === null) {
      options.cookies.setAll(clearSessionCookies(options.cookieOptions));
      return;
    }
    options.cookies.setAll(
      sessionCookiesFromTokens(
        {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: tokens.expires_in,
        },
        options.cookieOptions,
      ),
    );
  };

  return createClient<TMap, TInsertMap, TUpdateMap>({
    url: options.url,
    token: access,
    refreshToken: refresh,
    onTokens,
    ...options.clientOptions,
  });
}
