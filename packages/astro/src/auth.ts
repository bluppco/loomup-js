/** Same-origin Astro auth endpoint for Loomup-backed applications. */

import { LoomupError, type User } from "@loomup/client";
import {
  createServerClient,
  type CookieStore,
  type CreateServerClientOptions,
} from "./server.js";

export type LoomupAuthEndpointContext = {
  request: Request;
  cookies: CookieStore;
  params?: Record<string, string | undefined>;
};

export type LoomupAuthHandlerOptions = CreateServerClientOptions & {
  /** Catch-all Astro parameter name. Default: `loomup`. */
  param?: string;
};

function response(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new LoomupError("request body must be a JSON object", "invalid_input", 400);
  }
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new LoomupError("cross-origin auth mutation rejected", "forbidden", 403);
  }
}

function publicSession(user: User, accessToken: string | undefined) {
  return { data: { user, access_token: accessToken } };
}

/**
 * Create one Astro catch-all endpoint for login, logout, session hydration,
 * refresh, registration, and password reset.
 *
 * @example
 * ```ts
 * // src/pages/api/loomup/[...loomup].ts
 * import { createLoomupAuthHandler } from "@loomup/astro/auth";
 * export const prerender = false;
 * export const ALL = createLoomupAuthHandler({ url: import.meta.env.LOOMUP_URL });
 * ```
 */
export function createLoomupAuthHandler(options: LoomupAuthHandlerOptions = {}) {
  const param = options.param ?? "loomup";
  return async (context: LoomupAuthEndpointContext): Promise<Response> => {
    const action = context.params?.[param]?.replace(/^\/+|\/+$/g, "") ?? "";
    const client = createServerClient(context.cookies, options);

    try {
      switch (action) {
        case "session": {
          if (context.request.method !== "GET") {
            return response({ error: { code: "method_not_allowed" } }, 405);
          }
          const user = await client.auth.me();
          return response(publicSession(user, client.accessToken));
        }
        case "refresh": {
          assertSameOrigin(context.request);
          const tokens = await client.auth.refresh();
          const user = tokens.user ?? (await client.auth.me());
          return response(publicSession(user, tokens.access_token));
        }
        case "login": {
          assertSameOrigin(context.request);
          const body = await jsonBody(context.request);
          const tokens = await client.auth.signIn({
            email: String(body.email ?? ""),
            password: String(body.password ?? ""),
          });
          const user = tokens.user ?? (await client.auth.me());
          return response(publicSession(user, tokens.access_token));
        }
        case "register": {
          assertSameOrigin(context.request);
          const body = await jsonBody(context.request);
          const tokens = await client.auth.signUp({
            email: String(body.email ?? ""),
            password: String(body.password ?? ""),
          });
          const user = tokens.user ?? (await client.auth.me());
          return response(publicSession(user, tokens.access_token), 201);
        }
        case "logout": {
          assertSameOrigin(context.request);
          await client.auth.signOut();
          return response({ data: { ok: true } });
        }
        case "change-password": {
          assertSameOrigin(context.request);
          const body = await jsonBody(context.request);
          const currentPassword = String(body.currentPassword ?? "");
          const newPassword = String(body.newPassword ?? "");
          const user = await client.auth.me();
          await client.request("POST", "/account/api/change-password", {
            current_password: currentPassword,
            new_password: newPassword,
          });
          // The core revokes every refresh session on password change. Issue a
          // fresh current session so the browser does not fail on its next 401.
          const tokens = await client.auth.signIn({ email: user.email, password: newPassword });
          return response(publicSession(tokens.user ?? user, tokens.access_token));
        }
        case "password-reset/request": {
          assertSameOrigin(context.request);
          const body = await jsonBody(context.request);
          await client.request("POST", "/auth/password-reset/request", {
            email: String(body.email ?? ""),
          });
          // Never forward a self-hosted reset token to the browser. Hosted
          // Loomup delivers it out of band.
          return response({
            data: { ok: true, message: "if the account exists, a reset email was sent" },
          });
        }
        case "password-reset/confirm": {
          assertSameOrigin(context.request);
          const body = await jsonBody(context.request);
          await client.request("POST", "/auth/password-reset/confirm", {
            token: String(body.token ?? ""),
            password: String(body.password ?? ""),
          });
          return response({ data: { ok: true } });
        }
        default:
          return response({ error: { code: "not_found", message: "unknown auth action" } }, 404);
      }
    } catch (error) {
      if (error instanceof LoomupError) {
        return response(
          { error: { code: error.code ?? "auth_error", message: error.message } },
          error.status ?? 400,
        );
      }
      return response(
        { error: { code: "internal", message: error instanceof Error ? error.message : String(error) } },
        500,
      );
    }
  };
}
