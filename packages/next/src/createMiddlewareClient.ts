/**
 * Next.js middleware session refresh.
 *
 * Call `updateSession(request, { url })` from middleware.ts so access tokens
 * are rotated before Server Components run.
 */

import type { AuthTokens } from "@loomup/client";
import {
  accessNeedsRefresh,
  clearSessionCookies,
  readTokensFromCookies,
  serializeCookie,
  sessionCookiesFromTokens,
} from "./cookies.js";
import type { CookieRecord, SessionCookieOptions } from "./types.js";

/** Minimal NextRequest / NextResponse surface (no hard next import at runtime). */
export type MiddlewareRequest = {
  cookies: {
    getAll: () => { name: string; value: string }[];
  };
  nextUrl?: { clone: () => { pathname: string; search: string } };
  url: string;
};

export type MiddlewareResponse = {
  cookies: {
    set: (
      name: string,
      value: string,
      options?: {
        path?: string;
        maxAge?: number;
        domain?: string;
        secure?: boolean;
        httpOnly?: boolean;
        sameSite?: "lax" | "strict" | "none";
        expires?: Date;
      },
    ) => void;
  };
};

export type UpdateSessionOptions = {
  url: string;
  cookieOptions?: SessionCookieOptions;
  /** Refresh when access expires within this many seconds (default 60). */
  skewSeconds?: number;
  /**
   * Optional factory for the "continue" response. Defaults to a plain Response
   * that middleware callers should replace with NextResponse.next({ request }).
   * Prefer passing `createResponse` that returns NextResponse.next().
   */
  createResponse?: () => MiddlewareResponse & { headers?: Headers };
  /** Inject fetch for tests. */
  fetchImpl?: typeof fetch;
};

function applyCookiesToResponse(
  res: MiddlewareResponse,
  records: CookieRecord[],
) {
  for (const c of records) {
    res.cookies.set(c.name, c.value, {
      path: c.options?.path,
      maxAge: c.options?.maxAge,
      domain: c.options?.domain,
      secure: c.options?.secure,
      httpOnly: c.options?.httpOnly,
      sameSite: c.options?.sameSite,
      expires: c.options?.expires,
    });
  }
}

/**
 * Refresh Loomup session cookies when the access token is missing or near expiry.
 * Returns the response object (with updated cookies when rotation happened).
 *
 * Typical usage:
 * ```ts
 * import { NextResponse, type NextRequest } from "next/server";
 * import { updateSession } from "@loomup/next";
 *
 * export async function middleware(request: NextRequest) {
 *   return updateSession(request, {
 *     url: process.env.LOOMUP_URL!,
 *     createResponse: () => NextResponse.next({ request }),
 *   });
 * }
 * ```
 */
export async function updateSession(
  request: MiddlewareRequest,
  options: UpdateSessionOptions,
): Promise<MiddlewareResponse> {
  const fetchFn = options.fetchImpl ?? fetch;
  const jar = request.cookies.getAll();
  const { access, refresh } = readTokensFromCookies(
    jar,
    options.cookieOptions,
  );

  type Res = MiddlewareResponse & {
    headers?: Headers;
    // NextResponse is a Response subclass; keep a generic return for callers.
    [key: string]: unknown;
  };

  const res: Res =
    (options.createResponse?.() as Res | undefined) ??
    ({
      cookies: {
        set: () => {
          /* no-op fallback when no NextResponse provided */
        },
      },
    } as Res);

  if (!refresh) {
    if (access) {
      // Access without refresh — leave as-is (or clear if preferred).
      return res;
    }
    return res;
  }

  if (!accessNeedsRefresh(access, options.skewSeconds ?? 60)) {
    return res;
  }

  try {
    const refreshUrl = `${options.url.replace(/\/$/, "")}/auth/refresh`;
    const r = await fetchFn(refreshUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!r.ok) {
      applyCookiesToResponse(res, clearSessionCookies(options.cookieOptions));
      return res;
    }
    const json = (await r.json()) as { data?: AuthTokens };
    const data = json.data;
    if (!data?.access_token || !data?.refresh_token) {
      applyCookiesToResponse(res, clearSessionCookies(options.cookieOptions));
      return res;
    }
    applyCookiesToResponse(
      res,
      sessionCookiesFromTokens(
        {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_in: data.expires_in,
        },
        options.cookieOptions,
      ),
    );
  } catch {
    // Network blip — leave cookies; request may 401 and retry.
  }

  return res;
}

/** @deprecated Use updateSession; kept as alias for naming symmetry. */
export const createMiddlewareClient = updateSession;

/** Expose serialize for advanced middleware that mutates headers directly. */
export { serializeCookie };
