/**
 * Server-side Loomup client for Astro (SSR frontmatter, endpoints, middleware).
 * Persists access/refresh tokens in httpOnly cookies.
 */

import {
  LoomupClient,
  projectFromClient,
  type AuthTokens,
  type AuthSignUpResult,
  type CreateClientOptions,
  type DefaultTableMap,
  type LoomupProject,
  type OAuthAuthorizeInput,
  type OAuthExchangeInput,
} from "@loomup/client";

import {
  asCookieStore,
  clearTokens,
  readTokens,
  writeTokens,
  type CookieOptions,
  type CookieStore,
} from "./cookies.js";

export type {
  CookieNames,
  CookieOptions,
  CookieStore,
  CookieWriteOptions,
} from "./cookies.js";
export {
  DEFAULT_ACCESS_COOKIE,
  DEFAULT_REFRESH_COOKIE,
  clearTokens,
  readTokens,
  resolveCookieNames,
  writeTokens,
} from "./cookies.js";

export type {
  AuthTokens,
  ChangeEvent,
  ControlEvent,
  CreateClientOptions,
  ListMeta,
  User,
  StorageObject,
  StorageBucketInfo,
  StorageUploadOptions,
  StorageListOptions,
  StorageListResult,
  StorageUploadBody,
} from "@loomup/client";
export {
  LoomupError,
  createClient,
  StorageBucket,
  encodeObjectPath,
  normalizeStorageUpload,
} from "@loomup/client";

export {
  fileAndPathFromFormData,
  uploadFromFormData,
  storageDownloadResponse,
  type UploadFormDataOptions,
} from "./objectStorage.js";

export type CreateServerClientOptions = {
  /**
   * Loomup base URL. Defaults to LOOMUP_URL or PUBLIC_LOOMUP_URL env.
   */
  url?: string;
  /** Override initial tokens (otherwise read from cookies). */
  token?: string;
  refreshToken?: string;
  /** Cookie naming and security options. */
  cookies?: CookieOptions;
  /**
   * Extra createClient options (e.g. WebSocketImpl if you ever use
   * realtime on the server — not recommended for request-scoped SSR).
   */
  client?: Omit<CreateClientOptions, "url" | "token" | "refreshToken">;
};

export function resolveServerUrl(explicit?: string): string {
  if (explicit) return explicit;
  if (typeof process !== "undefined") {
    const fromEnv =
      process.env?.LOOMUP_URL || process.env?.PUBLIC_LOOMUP_URL;
    if (fromEnv) return fromEnv;
  }
  throw new Error(
    "@loomup/astro: createServerClient requires `url` or LOOMUP_URL / PUBLIC_LOOMUP_URL",
  );
}

/**
 * Cookie-backed Loomup client for Astro SSR.
 * Extends the core client so `.from()`, `.request()`, etc. stay identical.
 * Auth methods and automatic refresh write tokens back to cookies.
 */
export class ServerLoomupClient<
  TMap = DefaultTableMap,
  TInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
> extends LoomupClient<TMap, TInsertMap, TUpdateMap> {
  private readonly cookieStore: CookieStore;
  private readonly cookieOptions?: CookieOptions;
  /** Last known refresh token (core field is private; we mirror for cookie writes). */
  private mirroredRefresh?: string;

  constructor(
    cookieStore: CookieStore,
    options: CreateClientOptions & { cookieOptions?: CookieOptions },
  ) {
    super(options);
    this.cookieStore = cookieStore;
    this.cookieOptions = options.cookieOptions;
    this.mirroredRefresh = options.refreshToken;
  }

  private persistFromTokens(data: AuthTokens) {
    this.mirroredRefresh = data.refresh_token;
    writeTokens(this.cookieStore, data, this.cookieOptions);
  }

  private clearCookieTokens() {
    this.mirroredRefresh = undefined;
    clearTokens(this.cookieStore, this.cookieOptions);
  }

  override async signUp(creds: {
    email: string;
    password: string;
  }): Promise<AuthSignUpResult> {
    const data = await super.signUp(creds);
    if ("access_token" in data) this.persistFromTokens(data);
    return data;
  }

  override async signIn(creds: {
    email: string;
    password: string;
  }): Promise<AuthTokens> {
    const data = await super.signIn(creds);
    this.persistFromTokens(data);
    return data;
  }

  override async refresh(): Promise<AuthTokens> {
    const data = await super.refresh();
    this.persistFromTokens(data);
    return data;
  }

  override async exchangeOAuthCode(input: OAuthExchangeInput): Promise<AuthTokens> {
    const data = await super.exchangeOAuthCode(input);
    this.persistFromTokens(data);
    return data;
  }

  override async signOut(): Promise<void> {
    await super.signOut();
    this.clearCookieTokens();
  }

  override setToken(token: string | undefined) {
    super.setToken(token);
    if (token && this.mirroredRefresh) {
      writeTokens(
        this.cookieStore,
        {
          access_token: token,
          refresh_token: this.mirroredRefresh,
        },
        this.cookieOptions,
      );
    } else if (!token) {
      // Clearing access only — still clear both for safety on full logout paths.
      clearTokens(this.cookieStore, this.cookieOptions);
    }
  }

  override setRefreshToken(token: string | undefined) {
    super.setRefreshToken(token);
    this.mirroredRefresh = token;
  }

  /**
   * Same surface as LoomupClient.auth, but methods go through overrides
   * so cookies stay in sync.
   */
  override get auth() {
    return {
      signUp: (creds: { email: string; password: string }) =>
        this.signUp(creds),
      register: (creds: { email: string; password: string }) =>
        this.signUp(creds),
      signIn: (creds: { email: string; password: string }) =>
        this.signIn(creds),
      login: (creds: { email: string; password: string }) =>
        this.signIn(creds),
      oauthProviders: () => this.oauthProviders(),
      authorizeOAuth: (input: OAuthAuthorizeInput) => this.authorizeOAuth(input),
      exchangeOAuthCode: (input: OAuthExchangeInput) => this.exchangeOAuthCode(input),
      resendVerification: (email: string) => this.resendEmailVerification(email),
      confirmVerification: (token: string) => this.confirmEmailVerification(token),
      requestPasswordReset: (email: string) => this.requestPasswordReset(email),
      confirmPasswordReset: (input: { token: string; password: string }) =>
        this.confirmPasswordReset(input),
      acceptInvitation: (input: { token: string; password: string }) =>
        this.acceptInvitation(input),
      signOut: () => this.signOut(),
      logout: () => this.signOut(),
      me: () => this.me(),
      refresh: () => this.refresh(),
    };
  }
}

/**
 * Create a server Loomup client bound to Astro cookies.
 *
 * @example
 * ```ts
 * ---
 * import { createServerClient, uploadFromFormData } from "@loomup/astro/server";
 * const lb = createServerClient(Astro.cookies, { url: import.meta.env.LOOMUP_URL });
 * const { data } = await lb.from("todos").select({ limit: 20 });
 * // Object storage: await lb.storage.from("avatars").upload(...)
 * // or: await uploadFromFormData(lb, "avatars", await Astro.request.formData())
 * ---
 * ```
 */
export function createServerClient<
  TMap = DefaultTableMap,
  TInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
>(
  cookies: CookieStore,
  options: CreateServerClientOptions = {},
): ServerLoomupClient<TMap, TInsertMap, TUpdateMap> {
  const store = asCookieStore(cookies);
  const fromCookies = readTokens(store, options.cookies?.names);
  const url = resolveServerUrl(options.url);
  const token = options.token ?? fromCookies.access;
  const refreshToken = options.refreshToken ?? fromCookies.refresh;

  return new ServerLoomupClient<TMap, TInsertMap, TUpdateMap>(store, {
    url,
    token,
    refreshToken,
    cookieOptions: options.cookies,
    ...options.client,
  });
}

/**
 * Cookie-backed SSR client with generated property access (`db.issues`).
 * This is the server-side counterpart to `createAuthenticatedProject`.
 */
export function createServerProject<
  TMap = DefaultTableMap,
  TInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
>(
  cookies: CookieStore,
  options: CreateServerClientOptions = {},
): LoomupProject<TMap, TInsertMap, TUpdateMap> {
  return projectFromClient(
    createServerClient<TMap, TInsertMap, TUpdateMap>(cookies, options),
  );
}
