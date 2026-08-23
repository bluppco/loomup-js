/**
 * Cookie names and serialize helpers for Next-owned Loomup sessions.
 *
 * These are distinct from Loomup server cookie_mode names (`loomup_access`,
 * `loomup_refresh`). Do not mix both modes on the same browser origin without care.
 */

import type { CookieRecord, CookieSerializeOptions, SessionCookieOptions } from "./types.js";

/** Same defaults as `@loomup/astro` (distinct from server cookie_mode `loomup_access`). */
export const DEFAULT_ACCESS_COOKIE = "loomup-access";
export const DEFAULT_REFRESH_COOKIE = "loomup-refresh";

export const DEFAULT_ACCESS_MAX_AGE = 900; // 15m, matches typical JWT access TTL
export const DEFAULT_REFRESH_MAX_AGE = 60 * 60 * 24 * 30; // 30d

export type ResolvedCookieNames = {
  access: string;
  refresh: string;
};

export function resolveCookieNames(
  opts?: SessionCookieOptions,
): ResolvedCookieNames {
  return {
    access: opts?.accessCookie ?? DEFAULT_ACCESS_COOKIE,
    refresh: opts?.refreshCookie ?? DEFAULT_REFRESH_COOKIE,
  };
}

export function defaultSecure(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return (
    typeof process !== "undefined" && process.env?.NODE_ENV === "production"
  );
}

export function baseCookieOptions(
  opts?: SessionCookieOptions,
): CookieSerializeOptions {
  return {
    path: opts?.path ?? "/",
    httpOnly: true,
    sameSite: opts?.sameSite ?? "lax",
    secure: defaultSecure(opts?.secure),
  };
}

export function sessionCookiesFromTokens(
  tokens: {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
  },
  opts?: SessionCookieOptions,
): CookieRecord[] {
  const names = resolveCookieNames(opts);
  const base = baseCookieOptions(opts);
  const accessMax =
    tokens.expires_in && tokens.expires_in > 0
      ? tokens.expires_in
      : (opts?.accessMaxAge ?? DEFAULT_ACCESS_MAX_AGE);
  const refreshMax = opts?.refreshMaxAge ?? DEFAULT_REFRESH_MAX_AGE;
  return [
    {
      name: names.access,
      value: tokens.access_token,
      options: { ...base, maxAge: accessMax },
    },
    {
      name: names.refresh,
      value: tokens.refresh_token,
      options: { ...base, maxAge: refreshMax },
    },
  ];
}

export function clearSessionCookies(
  opts?: SessionCookieOptions,
): CookieRecord[] {
  const names = resolveCookieNames(opts);
  const base = baseCookieOptions(opts);
  return [
    { name: names.access, value: "", options: { ...base, maxAge: 0 } },
    { name: names.refresh, value: "", options: { ...base, maxAge: 0 } },
  ];
}

export function readTokensFromCookies(
  jar: { name: string; value: string }[],
  opts?: SessionCookieOptions,
): { access?: string; refresh?: string } {
  const names = resolveCookieNames(opts);
  let access: string | undefined;
  let refresh: string | undefined;
  for (const c of jar) {
    if (c.name === names.access && c.value) access = c.value;
    if (c.name === names.refresh && c.value) refresh = c.value;
  }
  return { access, refresh };
}

/**
 * Serialize a single cookie to a Set-Cookie header value (no encoding beyond
 * treating value as opaque; tokens are URL-safe JWTs / random strings).
 */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieSerializeOptions = {},
): string {
  const parts = [`${name}=${value}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) {
    const s =
      options.sameSite === "none"
        ? "None"
        : options.sameSite === "strict"
          ? "Strict"
          : "Lax";
    parts.push(`SameSite=${s}`);
  }
  return parts.join("; ");
}

/** Best-effort JWT exp (seconds). Returns null if not a JWT or unreadable. */
export function jwtExpiresAt(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1];
    const json =
      typeof atob === "function"
        ? atob(payload.replace(/-/g, "+").replace(/_/g, "/"))
        : Buffer.from(payload, "base64url").toString("utf8");
    const data = JSON.parse(json) as { exp?: number };
    return typeof data.exp === "number" ? data.exp : null;
  } catch {
    return null;
  }
}

/** True if access JWT is missing or expires within `skewSeconds`. */
export function accessNeedsRefresh(
  access: string | undefined,
  skewSeconds = 60,
): boolean {
  if (!access) return true;
  const exp = jwtExpiresAt(access);
  if (exp === null) return false; // opaque token — leave to 401 path
  const now = Math.floor(Date.now() / 1000);
  return exp <= now + skewSeconds;
}
