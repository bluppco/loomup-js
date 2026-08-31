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

export type BrowserSessionCoordinatorOptions<TSession> = {
  /** Load the current same-origin session. This may rotate an expired session. */
  loadSession: () => Promise<TSession>;
  /** Explicitly rotate a still-valid session that is close to expiry. */
  refreshSession?: () => Promise<TSession>;
  /** Return the access JWT when the session exposes it. */
  accessToken?: (session: TSession) => string | undefined;
  /** Refresh this long before the JWT expiry. Default: 60 seconds. */
  expirySkewMs?: number;
  /** Same-origin lock shared by every tab using this session. */
  lockName?: string;
};

export type BrowserSessionCoordinator<TSession> = {
  getSession(): Promise<TSession>;
  ensureFresh(): Promise<TSession>;
  invalidate(): void;
};

type SessionLease = { owner: string; expiresAt: number };

let coordinatorSequence = 0;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function jwtExpiry(token: string | undefined): number | undefined {
  if (!token) return undefined;
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return undefined;
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decode = (globalThis as { atob?: (value: string) => string }).atob;
    if (!decode) return undefined;
    const payload = JSON.parse(decode(padded)) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1_000 : undefined;
  } catch {
    return undefined;
  }
}

function browserLockManager(): LockManager | undefined {
  try {
    return (globalThis as { navigator?: Navigator }).navigator?.locks;
  } catch {
    return undefined;
  }
}

function browserStorage(): Storage | undefined {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage;
  } catch {
    return undefined;
  }
}

function leaseOwner(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  coordinatorSequence += 1;
  return `${Date.now()}-${coordinatorSequence}`;
}

function readLease(storage: Storage, key: string): SessionLease | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SessionLease>;
    if (typeof value.owner !== "string" || typeof value.expiresAt !== "number") return null;
    return { owner: value.owner, expiresAt: value.expiresAt };
  } catch {
    return null;
  }
}

async function withLease<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const storage = browserStorage();
  if (!storage) return operation();

  const key = `@loomup/astro:auth-lock:${name}`;
  const owner = leaseOwner();
  const deadline = Date.now() + 30_000;
  const channel = typeof BroadcastChannel === "function"
    ? new BroadcastChannel(`@loomup/astro:auth:${name}`)
    : undefined;
  try {
    while (Date.now() < deadline) {
      const current = readLease(storage, key);
      if (!current || current.expiresAt <= Date.now()) {
        try {
          storage.setItem(key, JSON.stringify({ owner, expiresAt: Date.now() + 15_000 }));
        } catch {
          return operation();
        }
        // localStorage has no compare-and-swap. A short settle and owner check
        // ensures only the last contender enters the critical section.
        await delay(20);
        if (readLease(storage, key)?.owner === owner) {
          const heartbeat = setInterval(() => {
            if (readLease(storage, key)?.owner === owner) {
              storage.setItem(key, JSON.stringify({ owner, expiresAt: Date.now() + 15_000 }));
            }
          }, 5_000);
          try {
            return await operation();
          } finally {
            clearInterval(heartbeat);
            if (readLease(storage, key)?.owner === owner) storage.removeItem(key);
            channel?.postMessage("released");
          }
        }
      }
      await delay(50);
    }
    throw new LoomupError("timed out waiting for session refresh", "auth_lock_timeout", 503);
  } finally {
    channel?.close();
  }
}

async function withBrowserSessionLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const locks = browserLockManager();
  if (locks) {
    return locks.request(`@loomup/astro:auth:${name}`, { mode: "exclusive" }, operation);
  }
  return withLease(name, operation);
}

function isTerminalSessionError(error: unknown): boolean {
  return error instanceof LoomupError && error.status === 401;
}

/**
 * Coordinate cookie-session refreshes within one tab and across same-origin
 * tabs. The operation always reloads the session after acquiring the lock, so
 * a waiter adopts cookies rotated by the winner instead of replaying a
 * single-use refresh token.
 */
export function createBrowserSessionCoordinator<TSession>(
  options: BrowserSessionCoordinatorOptions<TSession>,
): BrowserSessionCoordinator<TSession> {
  const lockName = options.lockName ?? "default";
  const expirySkewMs = Math.max(0, options.expirySkewMs ?? 60_000);
  let cached: TSession | undefined;
  let inFlight: Promise<TSession> | null = null;

  const execute = (checkExpiry: boolean): Promise<TSession> => {
    if (inFlight) return inFlight;
    const attempt = async () => withBrowserSessionLock(lockName, async () => {
      const loaded = await options.loadSession();
      if (!checkExpiry || !options.refreshSession || !options.accessToken) return loaded;
      const expiresAt = jwtExpiry(options.accessToken(loaded));
      return expiresAt !== undefined && expiresAt - Date.now() <= expirySkewMs
        ? options.refreshSession()
        : loaded;
    });
    inFlight = (async () => {
      try {
        cached = await attempt();
      } catch (error) {
        if (!isTerminalSessionError(error)) throw error;
        // A tab that could not participate in the primary lock may have lost a
        // rotation race. Reacquire and observe the cookie jar once before the
        // caller treats the session as terminal.
        await delay(100);
        cached = await attempt();
      }
      return cached;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    getSession() {
      return cached === undefined ? execute(false) : Promise.resolve(cached);
    },
    ensureFresh() {
      return execute(true);
    },
    invalidate() {
      cached = undefined;
    },
  };
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
  const coordinator = createBrowserSessionCoordinator({
    lockName: endpoint,
    loadSession: () => authRequest(fetchImpl, endpoint, "session", { method: "GET" }),
  });
  const session = await coordinator.getSession();
  if (!session.user) {
    throw new LoomupError("authenticated session required", "unauthorized", 401);
  }
  const db = createProject<TMap, TInsertMap, TUpdateMap>({
    url: options.dataEndpoint ?? `${endpoint.replace(/\/$/, "")}/data`,
    accessTokenProvider: async () => {
      await coordinator.ensureFresh();
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
      coordinator.invalidate();
      db.setToken(undefined);
    },
  };
}
