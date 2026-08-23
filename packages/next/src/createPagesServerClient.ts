/**
 * Pages Router server client — getServerSideProps, getServerSideProps API,
 * and pages/api routes.
 */

import type {
  DefaultInsertMap,
  DefaultTableMap,
  DefaultUpdateMap,
  LoomupClient,
} from "@loomup/client";
import { serializeCookie } from "./cookies.js";
import { createClientFromCookies } from "./storage.js";
import type { CookieMethods, CookieRecord, SessionCookieOptions } from "./types.js";

/** Minimal Pages context shapes (avoid hard dependency on next types at runtime). */
export type PagesRequest = {
  cookies?: Partial<Record<string, string>>;
  headers?: { cookie?: string | string[] };
};

export type PagesResponse = {
  getHeader?: (name: string) => number | string | string[] | undefined;
  setHeader: (name: string, value: string | string[]) => unknown;
};

export type PagesContext = {
  req: PagesRequest;
  res: PagesResponse;
};

export type CreatePagesServerClientOptions = {
  url: string;
  context: PagesContext;
  cookieOptions?: SessionCookieOptions;
};

function parseCookieHeader(header: string | undefined): { name: string; value: string }[] {
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

function cookiesFromRequest(req: PagesRequest): { name: string; value: string }[] {
  if (req.cookies && typeof req.cookies === "object") {
    return Object.entries(req.cookies)
      .filter((e): e is [string, string] => typeof e[1] === "string")
      .map(([name, value]) => ({ name, value }));
  }
  const raw = req.headers?.cookie;
  const header = Array.isArray(raw) ? raw.join(";") : raw;
  return parseCookieHeader(header);
}

function appendSetCookie(res: PagesResponse, serialized: string) {
  const existing = res.getHeader?.("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", serialized);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing.map(String), serialized]);
    return;
  }
  res.setHeader("Set-Cookie", [String(existing), serialized]);
}

export function pagesCookieMethods(
  context: PagesContext,
): CookieMethods {
  return {
    getAll: () => cookiesFromRequest(context.req),
    setAll: (records: CookieRecord[]) => {
      for (const c of records) {
        appendSetCookie(
          context.res,
          serializeCookie(c.name, c.value, c.options ?? {}),
        );
      }
    },
  };
}

/**
 * Create a Loomup client for Pages Router getServerSideProps / API routes.
 * Token rotations write Set-Cookie on the response.
 */
export function createPagesServerClient<
  TMap extends DefaultTableMap = DefaultTableMap,
  TInsertMap extends DefaultInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap extends DefaultUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
>(
  options: CreatePagesServerClientOptions,
): LoomupClient<TMap, TInsertMap, TUpdateMap> {
  return createClientFromCookies<TMap, TInsertMap, TUpdateMap>({
    url: options.url,
    cookies: pagesCookieMethods(options.context),
    cookieOptions: options.cookieOptions,
  });
}
