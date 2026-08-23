/**
 * Shared types for @loomup/next cookie session adapters.
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
 * Framework-agnostic cookie jar used by server / middleware / pages adapters.
 * Matches the Supabase SSR-style getAll/setAll pattern.
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

export type LoomupNextOptions = {
  url: string;
  cookieOptions?: SessionCookieOptions;
};
