/**
 * Browser / Client Component client.
 *
 * Access tokens are in-memory (and optional initial hydrate). Refresh stays on
 * HttpOnly cookies managed by server handlers / middleware — use
 * createAuthRouteHandlers for login/logout/refresh/session endpoints, or pass
 * accessToken from a server-rendered provider.
 */

import {
  createClient,
  type CreateClientOptions,
  type DefaultInsertMap,
  type DefaultTableMap,
  type DefaultUpdateMap,
  type LoomupClient,
} from "@loomup/client";

export type CreateBrowserClientOptions = {
  url: string;
  /** Initial access token (e.g. from RSC → client provider). */
  accessToken?: string;
  /** Optional refresh in memory (prefer HttpOnly cookie + route handlers). */
  refreshToken?: string;
  /**
   * Lazy access token getter (e.g. from React state). Used when constructing
   * if accessToken is not set; subsequent request() uses client memory after setSession.
   */
  getAccessToken?: () => string | undefined;
  onTokens?: CreateClientOptions["onTokens"];
  WebSocketImpl?: CreateClientOptions["WebSocketImpl"];
};

/**
 * Create a browser Loomup client. Prefer hydrating `accessToken` from the
 * server after middleware/session so Client Components can call REST + realtime.
 */
export function createBrowserClient<
  TMap extends DefaultTableMap = DefaultTableMap,
  TInsertMap extends DefaultInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap extends DefaultUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
>(
  options: CreateBrowserClientOptions,
): LoomupClient<TMap, TInsertMap, TUpdateMap> {
  const token =
    options.accessToken ?? options.getAccessToken?.() ?? undefined;

  return createClient<TMap, TInsertMap, TUpdateMap>({
    url: options.url,
    token,
    refreshToken: options.refreshToken,
    onTokens: options.onTokens,
    WebSocketImpl: options.WebSocketImpl,
  });
}
