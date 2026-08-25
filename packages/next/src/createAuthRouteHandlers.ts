/**
 * App Router Route Handler factory for cookie-based auth.
 *
 * Wire into app/api/auth/[...loomup]/route.ts or individual route files.
 */

import {
  createClient,
  type AuthTokens,
  type OAuthProvider,
  type User,
} from "@loomup/client";
import {
  clearSessionCookies,
  readTokensFromCookies,
  serializeCookie,
  sessionCookiesFromTokens,
} from "./cookies.js";
import type { CookieRecord, SessionCookieOptions } from "./types.js";

export type AuthRouteHandlersOptions = {
  url: string;
  cookieOptions?: SessionCookieOptions;
  /** When true, session JSON includes access_token for client hydrate (default true). */
  exposeAccessToken?: boolean;
  /** Exact application callback URL allowlisted in `$auth.redirect_urls`. */
  oauthCallbackUrl?: string;
  /** Optional trusted backend key, useful when app integrity is enforced. */
  serviceKey?: string;
};

const OAUTH_VERIFIER_COOKIE = "loomup-oauth-verifier";
const OAUTH_RETURN_COOKIE = "loomup-oauth-return";

function cookieHeaderToJar(
  header: string | null,
): { name: string; value: string }[] {
  if (!header) return [];
  const out: { name: string; value: string }[] = [];
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out.push({ name, value });
  }
  return out;
}

function withSetCookies(
  body: unknown,
  records: CookieRecord[],
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  for (const c of records) {
    headers.append(
      "Set-Cookie",
      serializeCookie(c.name, c.value, c.options ?? {}),
    );
  }
  return new Response(JSON.stringify(body), {
    ...init,
    status: init.status ?? 200,
    headers,
  });
}

function jsonError(message: string, status: number, code?: string): Response {
  return new Response(
    JSON.stringify({ error: { message, code: code ?? "error" } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function oauthCookie(name: string, value: string, options: AuthRouteHandlersOptions, maxAge = 600): CookieRecord {
  return {
    name,
    value,
    options: {
      httpOnly: true,
      sameSite: "lax",
      secure: options.cookieOptions?.secure ?? process.env.NODE_ENV === "production",
      path: "/",
      maxAge,
    },
  };
}

function redirectResponse(location: string, cookies: CookieRecord[]): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) {
    headers.append("Set-Cookie", serializeCookie(cookie.name, cookie.value, cookie.options ?? {}));
  }
  return new Response(null, { status: 302, headers });
}

function localErrorRedirect(returnTo: string, error: string): string {
  const destination = new URL(returnTo, "http://loomup.local");
  destination.searchParams.set("error", error);
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

async function readJson(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Returns handlers for login, register, logout, refresh, and session.
 * Each accepts a standard Fetch API Request and returns a Response with
 * Set-Cookie headers for Next-owned session cookies.
 */
export function createAuthRouteHandlers(options: AuthRouteHandlersOptions) {
  const exposeAccess = options.exposeAccessToken !== false;
  const base = options.url.replace(/\/$/, "");

  async function oauthStart(request: Request): Promise<Response> {
    if (!options.oauthCallbackUrl) {
      return jsonError("oauthCallbackUrl is required", 500, "oauth_misconfigured");
    }
    const body = await readJson(request);
    const provider = body?.provider;
    if (!(["google", "apple", "github"] as unknown[]).includes(provider)) {
      return jsonError("supported OAuth provider required", 400, "bad_request");
    }
    const requestedReturn = typeof body?.returnTo === "string" ? body.returnTo : "/";
    const returnTo = requestedReturn.startsWith("/") && !requestedReturn.startsWith("//")
      ? requestedReturn
      : "/";
    try {
      const client = createClient({ url: base, serviceKey: options.serviceKey });
      const authorization = await client.auth.authorizeOAuth({
        provider: provider as OAuthProvider,
        redirectTo: options.oauthCallbackUrl,
      });
      return redirectResponse(authorization.authorization_url, [
        oauthCookie(OAUTH_VERIFIER_COOKIE, authorization.code_verifier, options),
        oauthCookie(OAUTH_RETURN_COOKIE, encodeURIComponent(returnTo), options),
      ]);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "OAuth start failed", 400, "oauth_start_failed");
    }
  }

  async function oauthCallback(request: Request): Promise<Response> {
    const callback = new URL(request.url);
    const code = callback.searchParams.get("code");
    const providerError = callback.searchParams.get("error");
    const jar = cookieHeaderToJar(request.headers.get("cookie"));
    const verifier = jar.find((cookie) => cookie.name === OAUTH_VERIFIER_COOKIE)?.value;
    const returnCookie = jar.find((cookie) => cookie.name === OAUTH_RETURN_COOKIE)?.value;
    const returnTo = (() => {
      try {
        const value = decodeURIComponent(returnCookie ?? "/");
        return value.startsWith("/") && !value.startsWith("//") ? value : "/";
      } catch {
        return "/";
      }
    })();
    if (providerError && verifier) {
      return redirectResponse(localErrorRedirect(returnTo, providerError), [
        oauthCookie(OAUTH_VERIFIER_COOKIE, "", options, 0),
        oauthCookie(OAUTH_RETURN_COOKIE, "", options, 0),
      ]);
    }
    if (!code || !verifier) {
      return jsonError("OAuth callback is incomplete", 400, "oauth_flow_expired");
    }
    try {
      const client = createClient({ url: base, serviceKey: options.serviceKey });
      const tokens = await client.auth.exchangeOAuthCode({ code, codeVerifier: verifier });
      return redirectResponse(returnTo, [
        ...sessionCookiesFromTokens(tokens, options.cookieOptions),
        oauthCookie(OAUTH_VERIFIER_COOKIE, "", options, 0),
        oauthCookie(OAUTH_RETURN_COOKIE, "", options, 0),
      ]);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "OAuth callback failed", 401, "oauth_exchange_failed");
    }
  }

  async function login(request: Request): Promise<Response> {
    const body = await readJson(request);
    const email = typeof body?.email === "string" ? body.email : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!email || !password) {
      return jsonError("email and password required", 400, "bad_request");
    }
    const client = createClient({ url: base });
    try {
      const tokens = await client.auth.signIn({ email, password });
      return withSetCookies(
        { data: publicSession(tokens, exposeAccess) },
        sessionCookiesFromTokens(tokens, options.cookieOptions),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "login failed";
      return jsonError(msg, 401, "invalid_credentials");
    }
  }

  async function register(request: Request): Promise<Response> {
    const body = await readJson(request);
    const email = typeof body?.email === "string" ? body.email : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!email || !password) {
      return jsonError("email and password required", 400, "bad_request");
    }
    const client = createClient({ url: base });
    try {
      const tokens = await client.auth.signUp({ email, password });
      if (!("access_token" in tokens)) {
        return Response.json({ data: tokens }, { status: 202 });
      }
      return withSetCookies(
        { data: publicSession(tokens, exposeAccess) },
        sessionCookiesFromTokens(tokens, options.cookieOptions),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "register failed";
      return jsonError(msg, 400, "register_failed");
    }
  }

  async function logout(request: Request): Promise<Response> {
    const jar = cookieHeaderToJar(request.headers.get("cookie"));
    const { refresh } = readTokensFromCookies(jar, options.cookieOptions);
    if (refresh) {
      const client = createClient({
        url: base,
        refreshToken: refresh,
      });
      try {
        await client.auth.signOut();
      } catch {
        /* still clear cookies */
      }
    }
    return withSetCookies(
      { data: { ok: true } },
      clearSessionCookies(options.cookieOptions),
    );
  }

  async function refresh(request: Request): Promise<Response> {
    const jar = cookieHeaderToJar(request.headers.get("cookie"));
    const { refresh: refreshTok } = readTokensFromCookies(
      jar,
      options.cookieOptions,
    );
    if (!refreshTok) {
      return withSetCookies(
        { error: { message: "no session", code: "no_session" } },
        clearSessionCookies(options.cookieOptions),
        { status: 401 },
      );
    }
    const client = createClient({ url: base, refreshToken: refreshTok });
    try {
      const tokens = await client.auth.refresh();
      return withSetCookies(
        { data: publicSession(tokens, exposeAccess) },
        sessionCookiesFromTokens(tokens, options.cookieOptions),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "refresh failed";
      return withSetCookies(
        { error: { message: msg, code: "refresh_failed" } },
        clearSessionCookies(options.cookieOptions),
        { status: 401 },
      );
    }
  }

  async function session(request: Request): Promise<Response> {
    const jar = cookieHeaderToJar(request.headers.get("cookie"));
    const { access, refresh: refreshTok } = readTokensFromCookies(
      jar,
      options.cookieOptions,
    );
    if (!access && !refreshTok) {
      return new Response(JSON.stringify({ data: { user: null, session: null } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const client = createClient({
      url: base,
      token: access,
      refreshToken: refreshTok,
      onTokens: () => {
        /* session GET may refresh; cookies applied below if needed */
      },
    });
    // If only refresh, rotate first.
    let tokens: AuthTokens | null = null;
    if (!access && refreshTok) {
      try {
        tokens = await client.auth.refresh();
      } catch {
        return withSetCookies(
          { data: { user: null, session: null } },
          clearSessionCookies(options.cookieOptions),
        );
      }
    }
    try {
      const user = await client.auth.me();
      const accessOut = tokens?.access_token ?? access ?? client.accessToken;
      const payload = {
        user,
        access_token: exposeAccess ? accessOut : undefined,
      };
      if (tokens) {
        return withSetCookies(
          { data: payload },
          sessionCookiesFromTokens(tokens, options.cookieOptions),
        );
      }
      return new Response(JSON.stringify({ data: payload }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      return withSetCookies(
        { data: { user: null, session: null } },
        clearSessionCookies(options.cookieOptions),
      );
    }
  }

  return { login, register, logout, refresh, session, oauthStart, oauthCallback };
}

function publicSession(
  tokens: AuthTokens,
  exposeAccess: boolean,
): {
  user?: User;
  access_token?: string;
  expires_in: number;
  token_type: string;
} {
  return {
    user: tokens.user,
    access_token: exposeAccess ? tokens.access_token : undefined,
    expires_in: tokens.expires_in,
    token_type: tokens.token_type,
  };
}
