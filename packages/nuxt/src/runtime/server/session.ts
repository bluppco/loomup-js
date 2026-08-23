/**
 * Proactive access-token refresh for Nitro middleware.
 *
 * Port of `@loomup/next` updateSession for h3-style cookie adapters.
 */

import type { AuthTokens } from "@loomup/client";
import {
  accessNeedsRefresh,
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

export type UpdateSessionOptions = {
  url: string;
  cookieOptions?: SessionCookieOptions;
  /** Refresh when access expires within this many seconds (default 60). */
  skewSeconds?: number;
  /** Inject fetch for tests. */
  fetchImpl?: typeof fetch;
  cookies?: CookieMethods;
  event?: H3EventLike;
  cookieAdapter?: CookieAdapter;
};

function applyCookies(methods: CookieMethods, records: CookieRecord[]) {
  methods.setAll(records);
}

/**
 * Refresh Loomup session cookies when the access token is missing or near expiry.
 * Mutates cookies via CookieMethods / event adapter; returns whether rotation ran.
 */
export async function updateSession(
  options: UpdateSessionOptions,
): Promise<{ refreshed: boolean; cleared: boolean }> {
  const fetchFn = options.fetchImpl ?? fetch;
  let methods: CookieMethods;

  if (options.cookies) {
    methods = options.cookies;
  } else if (options.event) {
    methods = cookieMethodsFromEvent(options.event, options.cookieAdapter);
  } else {
    throw new Error(
      "@loomup/nuxt: updateSession requires `cookies` or `event`",
    );
  }

  const { access, refresh } = readTokensFromCookies(
    methods.getAll(),
    options.cookieOptions,
  );

  if (!refresh) {
    return { refreshed: false, cleared: false };
  }

  if (!accessNeedsRefresh(access, options.skewSeconds ?? 60)) {
    return { refreshed: false, cleared: false };
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
      applyCookies(methods, clearSessionCookies(options.cookieOptions));
      return { refreshed: false, cleared: true };
    }
    const json = (await r.json()) as { data?: AuthTokens };
    const data = json.data;
    if (!data?.access_token || !data?.refresh_token) {
      applyCookies(methods, clearSessionCookies(options.cookieOptions));
      return { refreshed: false, cleared: true };
    }
    applyCookies(
      methods,
      sessionCookiesFromTokens(
        {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_in: data.expires_in,
        },
        options.cookieOptions,
      ),
    );
    return { refreshed: true, cleared: false };
  } catch {
    // Network blip — leave cookies; request may 401 and retry.
    return { refreshed: false, cleared: false };
  }
}
