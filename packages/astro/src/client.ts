/**
 * Browser Loomup client for Astro client islands (`client:load`, etc.).
 */

import {
  createClient,
  createProject,
  LoomupError,
  type CreateClientOptions,
  type DefaultInsertMap,
  type DefaultTableMap,
  type DefaultUpdateMap,
  type LoomupClient,
  type LoomupProject,
  type User,
} from "@loomup/client";

export type {
  AuthTokens,
  ChangeEvent,
  ControlEvent,
  CreateClientOptions,
  ListMeta,
  User,
} from "@loomup/client";
export {
  LoomupError,
  createClient,
  makeSubKey,
  parseSubKey,
} from "@loomup/client";

export type CreateBrowserClientOptions = {
  /**
   * Loomup base URL. Defaults to `import.meta.env.PUBLIC_LOOMUP_URL`
   * (injected by the Astro integration) or `PUBLIC_LOOMUP_URL` process env.
   */
  url?: string;
  token?: string;
  refreshToken?: string;
  WebSocketImpl?: CreateClientOptions["WebSocketImpl"];
};

function envPublicUrl(): string | undefined {
  try {
    // Astro / Vite client and server modules.
    const meta = import.meta as ImportMeta & {
      env?: Record<string, string | undefined>;
    };
    if (meta.env?.PUBLIC_LOOMUP_URL) return meta.env.PUBLIC_LOOMUP_URL;
  } catch {
    /* ignore */
  }
  if (typeof process !== "undefined" && process.env?.PUBLIC_LOOMUP_URL) {
    return process.env.PUBLIC_LOOMUP_URL;
  }
  return undefined;
}

function resolveBrowserUrl(explicit?: string): string {
  if (explicit) return explicit;
  const fromEnv = envPublicUrl();
  if (fromEnv) return fromEnv;
  throw new Error(
    "@loomup/astro: createBrowserClient requires `url` or PUBLIC_LOOMUP_URL (set via the loomup() integration)",
  );
}

/**
 * Create a browser Loomup client for islands.
 *
 * Realtime (`subscribe` / `subscribeReady`) is supported in the browser.
 * Prefer `createServerClient` for SSR data loads; do not open WebSockets
 * during the server render of a request.
 *
 * @example
 * ```ts
 * import { createBrowserClient } from "@loomup/astro/client";
 * const lb = createBrowserClient();
 * lb.from("todos").subscribe((ev) => console.log(ev));
 * ```
 */
export function createBrowserClient<
  TMap extends DefaultTableMap = DefaultTableMap,
  TInsertMap extends DefaultInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap extends DefaultUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
>(
  options: CreateBrowserClientOptions = {},
): LoomupClient<TMap, TInsertMap, TUpdateMap> {
  return createClient<TMap, TInsertMap, TUpdateMap>({
    url: resolveBrowserUrl(options.url),
    token: options.token,
    refreshToken: options.refreshToken,
    WebSocketImpl: options.WebSocketImpl,
  });
}

export type CreateAuthenticatedProjectOptions = {
  /** Same-origin catch-all endpoint. Default: `/api/loomup`. */
  authEndpoint?: string;
  /** Same-origin data gateway. Default: `<authEndpoint>/data`. */
  dataEndpoint?: string;
  fetch?: typeof fetch;
};

export type AuthenticatedProject<
  TMap,
  TInsertMap,
  TUpdateMap,
> = {
  db: LoomupProject<TMap, TInsertMap, TUpdateMap>;
  user: User;
  signOut(): Promise<void>;
};

async function authRequest(
  fetchImpl: typeof fetch,
  endpoint: string,
  action: string,
  init?: RequestInit,
): Promise<{ user?: User; ok?: boolean }> {
  const response = await fetchImpl(`${endpoint.replace(/\/$/, "")}/${action}`, {
    credentials: "same-origin",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: { user?: User; ok?: boolean };
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    throw new LoomupError(
      payload.error?.message ?? response.statusText,
      payload.error?.code,
      response.status,
    );
  }
  return payload.data ?? {};
}

/**
 * Hydrate the typed `db.issues` project client through Astro's same-origin
 * data gateway. Loomup's URL and both session tokens remain server-only.
 */
export async function createAuthenticatedProject<
  TMap = DefaultTableMap,
  TInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
>(
  options: CreateAuthenticatedProjectOptions = {},
): Promise<AuthenticatedProject<TMap, TInsertMap, TUpdateMap>> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const endpoint = options.authEndpoint ?? "/api/loomup";
  const session = await authRequest(fetchImpl, endpoint, "session", { method: "GET" });
  if (!session.user) {
    throw new LoomupError("authenticated session required", "unauthorized", 401);
  }
  const db = createProject<TMap, TInsertMap, TUpdateMap>({
    url: options.dataEndpoint ?? `${endpoint.replace(/\/$/, "")}/data`,
    accessTokenProvider: async () => {
      await authRequest(fetchImpl, endpoint, "refresh", { method: "POST" });
      // The core client requires a truthy retry signal. This marker is sent
      // only to the same-origin gateway, which replaces Authorization with
      // the server-held access token.
      return "server-session";
    },
  });
  return {
    db,
    user: session.user,
    async signOut() {
      await authRequest(fetchImpl, endpoint, "logout", { method: "POST" });
      db.setToken(undefined);
    },
  };
}
