/**
 * Optional Astro middleware helper: refresh session cookies and attach user.
 */

import type { User } from "@loomup/client";
import {
  createServerClient,
  type CreateServerClientOptions,
  type CookieStore,
} from "./server.js";

/** Minimal middleware context (Astro APIMiddlewareContext subset). */
export type LoomupMiddlewareContext = {
  cookies: CookieStore;
  locals: Record<string, unknown>;
};

export type LoomupMiddlewareOptions = CreateServerClientOptions & {
  /**
   * When true (default), call `auth.me()` after a successful token setup and
   * set `locals.user` / `locals.loomup`. Failures clear cookies.
   */
  loadUser?: boolean;
  /** Locals key for the user object (default "user"). */
  userKey?: string;
  /** Locals key for the Loomup client (default "loomup"). */
  clientKey?: string;
};

export type MiddlewareNext = () => Promise<Response>;

/**
 * Returns an Astro-compatible middleware function.
 *
 * @example
 * ```ts
 * // src/middleware.ts
 * import { defineMiddleware } from "astro:middleware";
 * import { createLoomupMiddleware } from "@loomup/astro/middleware";
 *
 * const loomupMw = createLoomupMiddleware({
 *   url: import.meta.env.LOOMUP_URL,
 * });
 *
 * export const onRequest = defineMiddleware((context, next) =>
 *   loomupMw(context, next),
 * );
 * ```
 */
export function createLoomupMiddleware(
  options: LoomupMiddlewareOptions = {},
) {
  const loadUser = options.loadUser !== false;
  const userKey = options.userKey ?? "user";
  const clientKey = options.clientKey ?? "loomup";

  return async (
    context: LoomupMiddlewareContext,
    next: MiddlewareNext,
  ): Promise<Response> => {
    const client = createServerClient(context.cookies, options);
    context.locals[clientKey] = client;

    const hasAccess = Boolean(client.accessToken);
    const hasRefresh = Boolean(
      // refresh is private; re-read from cookies via a no-op path:
      // createServerClient already loaded tokens — try refresh if no access.
      options.refreshToken ||
        context.cookies.get(
          options.cookies?.names?.refresh ?? "loomup-refresh",
        )?.value,
    );

    if (!hasAccess && hasRefresh) {
      try {
        await client.auth.refresh();
      } catch {
        await client.auth.signOut().catch(() => {});
        context.locals[userKey] = undefined;
        return next();
      }
    }

    if (loadUser && client.accessToken) {
      try {
        const user: User = await client.auth.me();
        context.locals[userKey] = user;
      } catch {
        // Stale access token — try refresh once, then clear.
        try {
          if (hasRefresh) {
            await client.auth.refresh();
            context.locals[userKey] = await client.auth.me();
          } else {
            await client.auth.signOut().catch(() => {});
            context.locals[userKey] = undefined;
          }
        } catch {
          await client.auth.signOut().catch(() => {});
          context.locals[userKey] = undefined;
        }
      }
    }

    return next();
  };
}
