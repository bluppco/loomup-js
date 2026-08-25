/**
 * Auth handler factory for Nitro / h3 routes (cookie-based session).
 *
 * Same surface as `@loomup/next` createAuthRouteHandlers, adapted for events.
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
  sessionCookiesFromTokens,
} from "../../cookies.js";
import type {
  CookieMethods,
  CookieRecord,
  SessionCookieOptions,
} from "../../types.js";
import {
  cookieMethodsFromEvent,
  type CookieAdapter,
  type H3EventLike,
} from "./client.js";

export type AuthHandlersOptions = {
  url: string;
  cookieOptions?: SessionCookieOptions;
  /** When true, session JSON includes access_token for client hydrate (default true). */
  exposeAccessToken?: boolean;
  cookieAdapter?: CookieAdapter;
  oauthCallbackUrl?: string;
  serviceKey?: string;
};

export type AuthHandlerResult = {
  status: number;
  body: unknown;
  cookies: CookieRecord[];
  location?: string;
};

const OAUTH_VERIFIER_COOKIE = "loomup-oauth-verifier";
const OAUTH_RETURN_COOKIE = "loomup-oauth-return";

function oauthCookie(name: string, value: string, options: AuthHandlersOptions, maxAge = 600): CookieRecord {
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

function localErrorRedirect(returnTo: string, error: string): string {
  const destination = new URL(returnTo, "http://loomup.local");
  destination.searchParams.set("error", error);
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

function methodsFor(
  event: H3EventLike | undefined,
  cookies: CookieMethods | undefined,
  adapter?: CookieAdapter,
): CookieMethods {
  if (cookies) return cookies;
  if (event) return cookieMethodsFromEvent(event, adapter);
  throw new Error("@loomup/nuxt: auth handlers require event or cookies");
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

export type AuthBody = {
  email?: string;
  password?: string;
};

/**
 * Returns handlers for login, register, logout, refresh, and session.
 * Each returns status/body/cookies so Nitro can setCookie + send JSON, or tests
 * can assert without h3.
 */
export function createAuthHandlers(options: AuthHandlersOptions) {
  const exposeAccess = options.exposeAccessToken !== false;
  const base = options.url.replace(/\/$/, "");

  async function oauthStart(
    body: { provider?: string; returnTo?: string },
    ctx: { event?: H3EventLike; cookies?: CookieMethods } = {},
  ): Promise<AuthHandlerResult> {
    if (!options.oauthCallbackUrl) {
      return { status: 500, body: { error: { code: "oauth_misconfigured", message: "oauthCallbackUrl is required" } }, cookies: [] };
    }
    if (!(["google", "apple", "github"] as unknown[]).includes(body.provider)) {
      return { status: 400, body: { error: { code: "bad_request", message: "supported OAuth provider required" } }, cookies: [] };
    }
    const returnTo = body.returnTo?.startsWith("/") && !body.returnTo.startsWith("//") ? body.returnTo : "/";
    try {
      const client = createClient({ url: base, serviceKey: options.serviceKey });
      const authorization = await client.auth.authorizeOAuth({ provider: body.provider as OAuthProvider, redirectTo: options.oauthCallbackUrl });
      const cookies = [
        oauthCookie(OAUTH_VERIFIER_COOKIE, authorization.code_verifier, options),
        oauthCookie(OAUTH_RETURN_COOKIE, encodeURIComponent(returnTo), options),
      ];
      methodsFor(ctx.event, ctx.cookies, options.cookieAdapter).setAll(cookies);
      return { status: 302, body: null, cookies, location: authorization.authorization_url };
    } catch (error) {
      return { status: 400, body: { error: { code: "oauth_start_failed", message: error instanceof Error ? error.message : "OAuth start failed" } }, cookies: [] };
    }
  }

  async function oauthCallback(
    code: string | undefined,
    providerError: string | undefined,
    ctx: { event?: H3EventLike; cookies?: CookieMethods } = {},
  ): Promise<AuthHandlerResult> {
    const methods = methodsFor(ctx.event, ctx.cookies, options.cookieAdapter);
    const jar = methods.getAll();
    const verifier = jar.find((cookie) => cookie.name === OAUTH_VERIFIER_COOKIE)?.value;
    const encodedReturn = jar.find((cookie) => cookie.name === OAUTH_RETURN_COOKIE)?.value;
    let returnTo = "/";
    try {
      const candidate = decodeURIComponent(encodedReturn ?? "/");
      if (candidate.startsWith("/") && !candidate.startsWith("//")) returnTo = candidate;
    } catch { /* default */ }
    if (providerError && verifier) {
      const cookies = [
        oauthCookie(OAUTH_VERIFIER_COOKIE, "", options, 0),
        oauthCookie(OAUTH_RETURN_COOKIE, "", options, 0),
      ];
      methods.setAll(cookies);
      return { status: 302, body: null, cookies, location: localErrorRedirect(returnTo, providerError) };
    }
    if (!code || !verifier) {
      return { status: 400, body: { error: { code: "oauth_flow_expired", message: "OAuth callback is incomplete" } }, cookies: [] };
    }
    try {
      const client = createClient({ url: base, serviceKey: options.serviceKey });
      const tokens = await client.auth.exchangeOAuthCode({ code, codeVerifier: verifier });
      const cookies = [
        ...sessionCookiesFromTokens(tokens, options.cookieOptions),
        oauthCookie(OAUTH_VERIFIER_COOKIE, "", options, 0),
        oauthCookie(OAUTH_RETURN_COOKIE, "", options, 0),
      ];
      methods.setAll(cookies);
      return { status: 302, body: null, cookies, location: returnTo };
    } catch (error) {
      return { status: 401, body: { error: { code: "oauth_exchange_failed", message: error instanceof Error ? error.message : "OAuth callback failed" } }, cookies: [] };
    }
  }

  async function login(
    body: AuthBody,
    ctx: { event?: H3EventLike; cookies?: CookieMethods } = {},
  ): Promise<AuthHandlerResult> {
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      return {
        status: 400,
        body: { error: { message: "email and password required", code: "bad_request" } },
        cookies: [],
      };
    }
    const client = createClient({ url: base });
    try {
      const tokens = await client.auth.signIn({ email, password });
      const cookieRecords = sessionCookiesFromTokens(
        tokens,
        options.cookieOptions,
      );
      const methods = methodsFor(ctx.event, ctx.cookies, options.cookieAdapter);
      methods.setAll(cookieRecords);
      return {
        status: 200,
        body: { data: publicSession(tokens, exposeAccess) },
        cookies: cookieRecords,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "login failed";
      return {
        status: 401,
        body: { error: { message: msg, code: "invalid_credentials" } },
        cookies: [],
      };
    }
  }

  async function register(
    body: AuthBody,
    ctx: { event?: H3EventLike; cookies?: CookieMethods } = {},
  ): Promise<AuthHandlerResult> {
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      return {
        status: 400,
        body: { error: { message: "email and password required", code: "bad_request" } },
        cookies: [],
      };
    }
    const client = createClient({ url: base });
    try {
      const tokens = await client.auth.signUp({ email, password });
      const cookieRecords = sessionCookiesFromTokens(
        tokens,
        options.cookieOptions,
      );
      const methods = methodsFor(ctx.event, ctx.cookies, options.cookieAdapter);
      methods.setAll(cookieRecords);
      return {
        status: 200,
        body: { data: publicSession(tokens, exposeAccess) },
        cookies: cookieRecords,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "register failed";
      return {
        status: 400,
        body: { error: { message: msg, code: "register_failed" } },
        cookies: [],
      };
    }
  }

  async function logout(
    ctx: { event?: H3EventLike; cookies?: CookieMethods } = {},
  ): Promise<AuthHandlerResult> {
    const methods = methodsFor(ctx.event, ctx.cookies, options.cookieAdapter);
    const { refresh } = readTokensFromCookies(
      methods.getAll(),
      options.cookieOptions,
    );
    if (refresh) {
      const client = createClient({ url: base, refreshToken: refresh });
      try {
        await client.auth.signOut();
      } catch {
        /* still clear cookies */
      }
    }
    const cookieRecords = clearSessionCookies(options.cookieOptions);
    methods.setAll(cookieRecords);
    return {
      status: 200,
      body: { data: { ok: true } },
      cookies: cookieRecords,
    };
  }

  async function refresh(
    ctx: { event?: H3EventLike; cookies?: CookieMethods } = {},
  ): Promise<AuthHandlerResult> {
    const methods = methodsFor(ctx.event, ctx.cookies, options.cookieAdapter);
    const { refresh: refreshTok } = readTokensFromCookies(
      methods.getAll(),
      options.cookieOptions,
    );
    if (!refreshTok) {
      const cookieRecords = clearSessionCookies(options.cookieOptions);
      methods.setAll(cookieRecords);
      return {
        status: 401,
        body: { error: { message: "no session", code: "no_session" } },
        cookies: cookieRecords,
      };
    }
    const client = createClient({ url: base, refreshToken: refreshTok });
    try {
      const tokens = await client.auth.refresh();
      const cookieRecords = sessionCookiesFromTokens(
        tokens,
        options.cookieOptions,
      );
      methods.setAll(cookieRecords);
      return {
        status: 200,
        body: { data: publicSession(tokens, exposeAccess) },
        cookies: cookieRecords,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "refresh failed";
      const cookieRecords = clearSessionCookies(options.cookieOptions);
      methods.setAll(cookieRecords);
      return {
        status: 401,
        body: { error: { message: msg, code: "refresh_failed" } },
        cookies: cookieRecords,
      };
    }
  }

  async function session(
    ctx: { event?: H3EventLike; cookies?: CookieMethods } = {},
  ): Promise<AuthHandlerResult> {
    const methods = methodsFor(ctx.event, ctx.cookies, options.cookieAdapter);
    const { access, refresh: refreshTok } = readTokensFromCookies(
      methods.getAll(),
      options.cookieOptions,
    );
    if (!access && !refreshTok) {
      return {
        status: 200,
        body: { data: { user: null, session: null } },
        cookies: [],
      };
    }
    const client = createClient({
      url: base,
      token: access,
      refreshToken: refreshTok,
    });
    let tokens: AuthTokens | null = null;
    if (!access && refreshTok) {
      try {
        tokens = await client.auth.refresh();
        methods.setAll(
          sessionCookiesFromTokens(tokens, options.cookieOptions),
        );
      } catch {
        const cookieRecords = clearSessionCookies(options.cookieOptions);
        methods.setAll(cookieRecords);
        return {
          status: 200,
          body: { data: { user: null, session: null } },
          cookies: cookieRecords,
        };
      }
    }
    try {
      const user = await client.auth.me();
      const accessOut = tokens?.access_token ?? access ?? client.accessToken;
      const payload = {
        user,
        access_token: exposeAccess ? accessOut : undefined,
      };
      return {
        status: 200,
        body: { data: payload },
        cookies: tokens
          ? sessionCookiesFromTokens(tokens, options.cookieOptions)
          : [],
      };
    } catch {
      const cookieRecords = clearSessionCookies(options.cookieOptions);
      methods.setAll(cookieRecords);
      return {
        status: 200,
        body: { data: { user: null, session: null } },
        cookies: cookieRecords,
      };
    }
  }

  return { login, register, logout, refresh, session, oauthStart, oauthCallback };
}
