/**
 * Cookie helpers for Loomup auth tokens in Astro SSR.
 */

export const DEFAULT_ACCESS_COOKIE = "loomup-access";
export const DEFAULT_REFRESH_COOKIE = "loomup-refresh";

/** Minimal cookie API compatible with AstroCookies (and easy to mock in tests). */
export type CookieStore = {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options?: CookieWriteOptions): void;
  delete(name: string, options?: { path?: string }): void;
};

export type CookieWriteOptions = {
  path?: string;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none" | boolean;
  expires?: Date;
};

export type CookieNames = {
  access: string;
  refresh: string;
};

export type CookieOptions = {
  /** Cookie name overrides. */
  names?: Partial<CookieNames>;
  /**
   * Force Secure flag. Default: true when NODE_ENV === "production",
   * or when `secure: true` is passed.
   */
  secure?: boolean;
  /** Cookie path (default "/"). */
  path?: string;
  /**
   * Max-Age for the access token cookie when expires_in is missing.
   * Default 3600 seconds.
   */
  accessMaxAge?: number;
  /**
   * Max-Age for the refresh token cookie.
   * Default 60 * 60 * 24 * 30 (30 days).
   */
  refreshMaxAge?: number;
};

export function resolveCookieNames(
  names?: Partial<CookieNames>,
): CookieNames {
  return {
    access: names?.access ?? DEFAULT_ACCESS_COOKIE,
    refresh: names?.refresh ?? DEFAULT_REFRESH_COOKIE,
  };
}

export function isSecureDefault(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return (
    typeof process !== "undefined" &&
    process.env?.NODE_ENV === "production"
  );
}

export function readTokens(
  cookies: CookieStore,
  names?: Partial<CookieNames>,
): { access?: string; refresh?: string } {
  const n = resolveCookieNames(names);
  return {
    access: cookies.get(n.access)?.value,
    refresh: cookies.get(n.refresh)?.value,
  };
}

export function writeTokens(
  cookies: CookieStore,
  tokens: {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
  },
  options?: CookieOptions,
): void {
  const n = resolveCookieNames(options?.names);
  const path = options?.path ?? "/";
  const secure = isSecureDefault(options?.secure);
  const accessMaxAge =
    tokens.expires_in ?? options?.accessMaxAge ?? 3600;
  const refreshMaxAge = options?.refreshMaxAge ?? 60 * 60 * 24 * 30;

  const base: CookieWriteOptions = {
    path,
    httpOnly: true,
    secure,
    sameSite: "lax",
  };

  cookies.set(n.access, tokens.access_token, {
    ...base,
    maxAge: accessMaxAge,
  });
  cookies.set(n.refresh, tokens.refresh_token, {
    ...base,
    maxAge: refreshMaxAge,
  });
}

export function clearTokens(
  cookies: CookieStore,
  options?: CookieOptions,
): void {
  const n = resolveCookieNames(options?.names);
  const path = options?.path ?? "/";
  cookies.delete(n.access, { path });
  cookies.delete(n.refresh, { path });
}

/**
 * Adapt AstroCookies (or any compatible object) to CookieStore.
 * Accepts a structural type so tests and non-Astro callers work.
 */
export function asCookieStore(cookies: CookieStore): CookieStore {
  return cookies;
}
