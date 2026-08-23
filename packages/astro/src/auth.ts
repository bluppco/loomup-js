/** Same-origin Astro auth endpoint for Loomup-backed applications. */

import { LoomupError, type User } from "@loomup/client";
import { readTokens, writeTokens } from "./cookies.js";
import {
  createServerClient,
  resolveServerUrl,
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

function publicSession(user: User) {
  return { data: { user } };
}

type AuthPayload = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  user?: User;
};

type SetCookieHeaders = Headers & {
  getSetCookie?: () => string[];
  getAll?: (name: string) => string[];
};

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function upstreamCookie(headers: Headers, name: string): string | undefined {
  const extended = headers as SetCookieHeaders;
  const values =
    typeof extended.getSetCookie === "function"
      ? extended.getSetCookie()
      : typeof extended.getAll === "function"
        ? extended.getAll("Set-Cookie")
        : [headers.get("Set-Cookie") ?? ""];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|,\\s*)${escaped}=([^;]*)`);
  for (const value of values) {
    const match = pattern.exec(value);
    if (match?.[1]) return match[1].replace(/^"|"$/g, "");
  }
  return undefined;
}

async function upstreamRequest<T>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  accessToken?: string,
): Promise<{ data: T; response: Response }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const upstream = await fetch(joinUrl(baseUrl, path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await upstream.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  const envelope = payload as {
    data?: T;
    error?: { code?: unknown; message?: unknown };
    message?: unknown;
  } | null;
  if (!upstream.ok) {
    const message =
      envelope?.error?.message ?? envelope?.message ?? text ?? upstream.statusText;
    const code = envelope?.error?.code;
    throw new LoomupError(
      String(message || upstream.statusText),
      typeof code === "string" ? code : undefined,
      upstream.status,
    );
  }
  if (!envelope || !("data" in envelope)) {
    throw new LoomupError("invalid response from Loomup", "invalid_response", 502);
  }
  return { data: envelope.data as T, response: upstream };
}

async function authExchange(
  baseUrl: string,
  cookies: CookieStore,
  options: LoomupAuthHandlerOptions,
  path: string,
  body: unknown,
  currentRefresh?: string,
): Promise<{ accessToken: string; user?: User }> {
  const { data, response: upstream } = await upstreamRequest<AuthPayload>(
    baseUrl,
    "POST",
    path,
    body,
  );
  const accessToken =
    typeof data.access_token === "string"
      ? data.access_token
      : upstreamCookie(upstream.headers, "loomup_access");
  const refreshToken =
    typeof data.refresh_token === "string"
      ? data.refresh_token
      : upstreamCookie(upstream.headers, "loomup_refresh") ?? currentRefresh;
  if (!accessToken || !refreshToken) {
    throw new LoomupError(
      "Loomup auth response did not include a complete session",
      "invalid_response",
      502,
    );
  }
  writeTokens(
    cookies,
    {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
    },
    options.cookies,
  );
  return { accessToken, user: data.user };
}

async function userForAccess(baseUrl: string, accessToken: string): Promise<User> {
  const { data } = await upstreamRequest<User>(
    baseUrl,
    "GET",
    "/auth/me",
    undefined,
    accessToken,
  );
  return data;
}

async function sessionFromCookies(
  baseUrl: string,
  cookies: CookieStore,
  options: LoomupAuthHandlerOptions,
): Promise<{ accessToken: string; user: User }> {
  const tokens = readTokens(cookies, options.cookies?.names);
  if (tokens.access) {
    try {
      return { accessToken: tokens.access, user: await userForAccess(baseUrl, tokens.access) };
    } catch (error) {
      if (!(error instanceof LoomupError) || error.status !== 401 || !tokens.refresh) throw error;
    }
  }
  if (!tokens.refresh) {
    throw new LoomupError("authentication required", "unauthorized", 401);
  }
  const session = await authExchange(
    baseUrl,
    cookies,
    options,
    "/auth/refresh",
    { refresh_token: tokens.refresh },
    tokens.refresh,
  );
  return {
    accessToken: session.accessToken,
    user: session.user ?? (await userForAccess(baseUrl, session.accessToken)),
  };
}

const REQUEST_HEADERS = [
  "accept",
  "content-type",
  "idempotency-key",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "range",
  "x-loomup-upsert",
] as const;

const RESPONSE_HEADERS = [
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
] as const;

function proxyPath(action: string): string {
  const path = action.slice("data".length).replace(/^\/+/, "");
  if (!path) throw new LoomupError("missing Loomup API path", "not_found", 404);
  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\"))) {
    throw new LoomupError("invalid Loomup API path", "invalid_input", 400);
  }
  if (path.startsWith("auth/") && path !== "auth/me") {
    throw new LoomupError("use the Astro auth endpoint", "forbidden", 403);
  }
  if (path.startsWith("account/")) {
    throw new LoomupError("use the Astro account endpoint", "forbidden", 403);
  }
  return `/${path}`;
}

async function proxyToLoomup(
  context: LoomupAuthEndpointContext,
  options: LoomupAuthHandlerOptions,
  baseUrl: string,
  action: string,
): Promise<Response> {
  const method = context.request.method.toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return response({ error: { code: "method_not_allowed" } }, 405);
  }
  if (method !== "GET" && method !== "HEAD") assertSameOrigin(context.request);

  let tokens = readTokens(context.cookies, options.cookies?.names);
  if (!tokens.access) {
    if (!tokens.refresh) {
      throw new LoomupError("authentication required", "unauthorized", 401);
    }
    await authExchange(
      baseUrl,
      context.cookies,
      options,
      "/auth/refresh",
      { refresh_token: tokens.refresh },
      tokens.refresh,
    );
    tokens = readTokens(context.cookies, options.cookies?.names);
  }
  if (!tokens.access) {
    throw new LoomupError("authentication required", "unauthorized", 401);
  }

  const requestHeaders = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = context.request.headers.get(name);
    if (value) requestHeaders.set(name, value);
  }
  requestHeaders.set("Authorization", `Bearer ${tokens.access}`);

  const incomingUrl = new URL(context.request.url);
  const targetUrl = `${joinUrl(baseUrl, proxyPath(action))}${incomingUrl.search}`;
  const upstream = await fetch(targetUrl, {
    method,
    headers: requestHeaders,
    body: method === "GET" || method === "HEAD" ? undefined : context.request.body,
    redirect: "manual",
  });
  const responseHeaders = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set("Cache-Control", upstream.headers.get("Cache-Control") ?? "private, no-store");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
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
    const url = resolveServerUrl(options.url);
    const client = createServerClient(context.cookies, options);

    try {
      if (action === "data" || action.startsWith("data/")) {
        return await proxyToLoomup(context, options, url, action);
      }
      switch (action) {
        case "session": {
          if (context.request.method !== "GET") {
            return response({ error: { code: "method_not_allowed" } }, 405);
          }
          const session = await sessionFromCookies(url, context.cookies, options);
          return response(publicSession(session.user));
        }
        case "refresh": {
          assertSameOrigin(context.request);
          const refreshToken = readTokens(context.cookies, options.cookies?.names).refresh;
          if (!refreshToken) throw new LoomupError("no refresh token", "no_refresh", 401);
          const session = await authExchange(
            url,
            context.cookies,
            options,
            "/auth/refresh",
            { refresh_token: refreshToken },
            refreshToken,
          );
          const user = session.user ?? (await userForAccess(url, session.accessToken));
          return response(publicSession(user));
        }
        case "login": {
          assertSameOrigin(context.request);
          const body = await jsonBody(context.request);
          const session = await authExchange(url, context.cookies, options, "/auth/login", {
            email: String(body.email ?? ""),
            password: String(body.password ?? ""),
          });
          const user = session.user ?? (await userForAccess(url, session.accessToken));
          return response(publicSession(user));
        }
        case "register": {
          assertSameOrigin(context.request);
          const body = await jsonBody(context.request);
          const session = await authExchange(url, context.cookies, options, "/auth/register", {
            email: String(body.email ?? ""),
            password: String(body.password ?? ""),
          });
          const user = session.user ?? (await userForAccess(url, session.accessToken));
          return response(publicSession(user), 201);
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
          const current = await sessionFromCookies(url, context.cookies, options);
          await upstreamRequest(
            url,
            "POST",
            "/account/api/change-password",
            { current_password: currentPassword, new_password: newPassword },
            current.accessToken,
          );
          // The core revokes every refresh session on password change. Issue a
          // fresh current session so the browser does not fail on its next 401.
          const session = await authExchange(url, context.cookies, options, "/auth/login", {
            email: current.user.email,
            password: newPassword,
          });
          return response(publicSession(session.user ?? current.user));
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
