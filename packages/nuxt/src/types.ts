/**
 * Shared types for @loomup/nuxt cookie session adapters.
 */

export type CookieSerializeOptions = {
  path?: string;
  maxAge?: number;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "lax" | "strict" | "none";
  expires?: Date;
};

export type CookieRecord = {
  name: string;
  value: string;
  options?: CookieSerializeOptions;
};

/**
 * Framework-agnostic cookie jar (Supabase SSR-style getAll/setAll).
 * Used by createServerClient so unit tests do not need h3/Nuxt.
 */
export type CookieMethods = {
  getAll: () => { name: string; value: string }[];
  setAll: (cookies: CookieRecord[]) => void;
};

export type SessionCookieOptions = {
  /** Override access cookie name (default loomup-access). */
  accessCookie?: string;
  /** Override refresh cookie name (default loomup-refresh). */
  refreshCookie?: string;
  /** Access cookie Max-Age seconds (default 900). */
  accessMaxAge?: number;
  /** Refresh cookie Max-Age seconds (default 60 * 60 * 24 * 30). */
  refreshMaxAge?: number;
  /** Force Secure flag; default true when NODE_ENV=production. */
  secure?: boolean;
  /** Cookie path (default /). */
  path?: string;
  sameSite?: "lax" | "strict" | "none";
};

export type ModuleOptions = {
  /**
   * Loomup server URL (e.g. http://127.0.0.1:3000).
   * Also set via runtimeConfig.loomupUrl / NUXT_PUBLIC_LOOMUP_URL.
   */
  url?: string;
  /** Cookie naming and security overrides. */
  cookies?: SessionCookieOptions;
  /**
   * Register Nitro routes for login/register/logout/refresh/session.
   * Default true. Base path: authBasePath.
   */
  authRoutes?: boolean;
  /** Auth route prefix (default "/api/auth"). */
  authBasePath?: string;
  /**
   * Register Nitro middleware that refreshes near-expired access tokens.
   * Default true.
   */
  sessionMiddleware?: boolean;
  /** Refresh when access expires within this many seconds (default 60). */
  skewSeconds?: number;
  /**
   * When true (default), session/login JSON may include access_token so the
   * client can hydrate Bearer for REST + realtime (refresh stays HttpOnly).
   */
  exposeAccessToken?: boolean;
  /** Exact application callback URL allowlisted in `$auth.redirect_urls`. */
  oauthCallbackUrl?: string;
  /** Optional trusted server-only key for app-integrity-enforced projects. */
  serviceKey?: string;
};
