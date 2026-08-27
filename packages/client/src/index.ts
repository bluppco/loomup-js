/**
 * @loomup/client — TypeScript SDK for Loomup Realtime.
 */

export type CreateClientOptions = {
  url: string;
  token?: string;
  /** Non-secret project identifier. It never grants authorization. */
  publishableKey?: string;
  /** Trusted server/worker credential. Never embed this in a public client. */
  serviceKey?: string;
  /** Optional refresh token for automatic 401 retry. */
  refreshToken?: string;
  /**
   * WebSocket constructor override (Node without global WebSocket, or tests).
   * Defaults to globalThis.WebSocket when available.
   */
  WebSocketImpl?: typeof WebSocket;
  /**
   * Called whenever access/refresh tokens change (sign-in, refresh, setSession)
   * or are cleared (sign-out). Pass `null` on logout. Used by framework adapters
   * (e.g. Next.js cookie session) to persist the session.
   */
  onTokens?: (tokens: AuthTokens | null) => void;
  /**
   * Optional framework-owned session refresher. Called once after a 401 when
   * the refresh credential is intentionally kept outside this client (for
   * example in an Astro httpOnly cookie). Return a new access token to retry.
   */
  accessTokenProvider?: () => Promise<string | undefined>;
  /**
   * Text-frame realtime liveness watchdog. Defaults to a 25s probe interval
   * and 12s matching-pong timeout. Set false only for staged rollouts to a
   * server version that does not yet support application heartbeat pongs.
   */
  realtimeHeartbeat?: RealtimeHeartbeatOptions | false;
};

export type RealtimeHeartbeatOptions = {
  intervalMs?: number;
  timeoutMs?: number;
  /** Age after which a browser resume event retires the socket immediately. */
  staleAfterMs?: number;
};

export type RealtimeStatus =
  | "connecting"
  | "live"
  | "stale"
  | "reconnecting";

/** Minimal session shape for setSession (user/expires optional). */
export type SessionTokens = {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in?: number;
  user?: User;
};

export type AuthTokens = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user?: User;
};

export type AuthVerificationPending = {
  verification_required: true;
  expires_in: number;
  user: User;
};

export type AuthSignUpResult = AuthTokens | AuthVerificationPending;

export type AuthActionResult = {
  ok: boolean;
  message?: string;
  expires_in?: number;
  /** Present only for local/self-hosted password reset without email delivery. */
  token?: string;
};

export type OAuthProvider = "google" | "apple" | "github";

export type OAuthProviderInfo = {
  provider: OAuthProvider;
  configured: boolean;
  callback_url: string;
};

export type OAuthAuthorization = {
  authorization_url: string;
  code_verifier: string;
  expires_in: number;
};

export type OAuthAuthorizeInput = {
  provider: OAuthProvider;
  redirectTo: string;
};

export type OAuthExchangeInput = {
  code: string;
  codeVerifier: string;
};

export type User = {
  id: string;
  email: string;
  role: string;
  disabled: boolean;
  email_verified?: boolean;
  password_reset_required?: boolean;
  created_at: number;
};

export type ImportedIdentity = {
  /** Stable application user id to preserve across the migration. */
  id: string;
  email: string;
};

export type InviteUserInput = {
  email: string;
  role?: string;
};

export type SignedStorageUrl = {
  url: string;
  expires_at: number;
};

export type PushProvider = "expo" | "fcm" | "apns" | "webpush";
export type PushPlatform = "ios" | "android" | "web" | string;

export type RegisterDeviceInput = {
  token: string;
  provider: PushProvider | string;
  platform?: PushPlatform;
  device_id?: string;
  app_version?: string;
  locale?: string;
};

export type PushDevice = {
  id: string;
  user_id: string;
  token: string;
  provider: string;
  platform?: string | null;
  device_id?: string | null;
  app_version?: string | null;
  locale?: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at?: number | null;
  disabled: boolean;
  disabled_reason?: string | null;
};

export type WebPushConfig = { public_key: string };

export type ListMeta = {
  limit: number;
  offset: number;
  total: number;
  /** Present when rule-filtered list hit the server scan cap; total is a lower bound. */
  truncated?: boolean;
  /** Signed opaque cursor for the next page. Omitted on the final page. */
  next_cursor?: string;
};

/** Object metadata returned by `/storage/v1` APIs. */
export type StorageObject = {
  id: string;
  bucket: string;
  path: string;
  name: string;
  owner_id?: string | null;
  content_type?: string | null;
  size: number;
  etag?: string | null;
  created_at: number;
  updated_at: number;
};

export type StorageBucketInfo = {
  name: string;
  public: boolean;
};

export type StorageUploadOptions = {
  /** MIME type (e.g. `image/png`). */
  contentType?: string;
  /** Overwrite if the object already exists (requires update rule). */
  upsert?: boolean;
};

export type StorageListOptions = {
  prefix?: string;
  limit?: number;
  offset?: number;
};

export type StorageListResult = {
  data: StorageObject[];
  meta: ListMeta;
};

/** Body types accepted by `storage.from(bucket).upload`. */
export type StorageUploadBody =
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | Uint8Array
  | string;

/**
 * Normalize common server/browser inputs to a body + content type for upload.
 * Accepts File/Blob (browser + undici), Buffer/Uint8Array (Node), ArrayBuffer, string.
 */
export function normalizeStorageUpload(
  body: StorageUploadBody,
  options?: StorageUploadOptions,
): { body: BodyInit; contentType?: string } {
  let contentType = options?.contentType;
  if (typeof body === "string") {
    return {
      body,
      contentType: contentType ?? "text/plain; charset=utf-8",
    };
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return {
      body,
      contentType: contentType ?? (body.type || undefined) ?? "application/octet-stream",
    };
  }
  if (body instanceof ArrayBuffer) {
    return {
      body,
      contentType: contentType ?? "application/octet-stream",
    };
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    const copy = view.buffer.slice(
      view.byteOffset,
      view.byteOffset + view.byteLength,
    ) as ArrayBuffer;
    return {
      body: copy,
      contentType: contentType ?? "application/octet-stream",
    };
  }
  return {
    body: body as BodyInit,
    contentType: contentType ?? "application/octet-stream",
  };
}

export type ChangeEvent = {
  type: "change";
  channel?: string;
  table: string;
  op: "INSERT" | "UPDATE" | "DELETE" | string;
  id: string;
  data?: Record<string, unknown>;
  ts: number;
};

/** Non-change control frames from the realtime WebSocket (auth/subscribe). */
export type ControlEvent = {
  type: string;
  requestId?: string;
  channel?: string;
  table?: string;
  message?: string;
  code?: string;
  id?: string;
  serverTs?: number;
};

export type SubscribeHandler = (event: ChangeEvent) => void;
export type ControlHandler = (event: ControlEvent) => void;

/** Optional generated TableMap for typed `from()`. */
export type DefaultTableMap = Record<string, Record<string, unknown>>;
/** Optional generated TableInsertMap (from `loomup gen typescript`). */
export type DefaultInsertMap = Record<string, Record<string, unknown>>;
/** Optional generated TableUpdateMap (from `loomup gen typescript`). */
export type DefaultUpdateMap = Record<string, Record<string, unknown>>;

/** Single-column id or an exact object of composite primary-key values. */
export type RecordKey =
  | string
  | number
  | Record<string, string | number | boolean>;

function recordKeyPath(table: string, key: RecordKey): string {
  const base = `/api/${encodeURIComponent(table)}`;
  if (typeof key !== "object" || key === null || Array.isArray(key)) {
    return `${base}/${encodeURIComponent(String(key))}`;
  }
  const entries = Object.entries(key);
  if (!entries.length) {
    throw new LoomupError("composite record key cannot be empty", "bad_request");
  }
  const params = new URLSearchParams();
  for (const [field, value] of entries.sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    params.set(field, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }
  return `${base}/_loomup/key?${params}`;
}

export type ResourceFindOptions = {
  where?: Record<string, string | number | boolean>;
  filter?: Record<
    string,
    Partial<{
      eq: string | number | boolean;
      ne: string | number | boolean;
      lt: string | number;
      lte: string | number;
      gt: string | number;
      gte: string | number;
      in: readonly (string | number | boolean)[];
      isNull: boolean;
      contains: string;
      startsWith: string;
    }>
  >;
  select?: readonly string[];
  sort?: string;
  limit?: number;
  offset?: number;
  /** Continue a prior page. Do not combine with other list options. */
  cursor?: string;
};

export type OperationMeta = {
  operation: string;
  database: string;
  duration_ms: number;
  contract: string;
  rows?: number;
  replayed?: boolean;
};

export type OperationResponse<T> = { data: T; meta: OperationMeta };

export type CommandOptions = { idempotencyKey?: string };

export type BatchItemResult<T> = {
  index: number;
  status: "ok" | "error" | string;
  data?: T;
  error?: string;
};

export type JobLease<T = unknown> = {
  id: string;
  job: string;
  payload: T;
  attempt: number;
  max_attempts: number;
  lease_expires_at: number;
};

export type ResourceLiveOptions = ResourceFindOptions & {
  /** Refetch is correct for filtered/sorted lists; merge is efficient for unfiltered lists. */
  strategy?: "refetch" | "merge";
  /** Primary-key field used by merge strategy. Default `id`. */
  primaryKey?: string;
};

export type LiveResourceSnapshot<TRow> = {
  data: readonly TRow[];
  meta: ListMeta;
};

export type ResourceHistoryOptions = {
  /** Return events before this exclusive journal sequence (cursor pagination). */
  beforeSequence?: number;
  /** Page size, from 1 through 500. */
  limit?: number;
};

export type ResourceHistoryEntry<TRow = Record<string, unknown>> = {
  sequence: number;
  event_id: string;
  legacy_cdc_id?: number | null;
  transaction_id?: string | null;
  resource: string;
  record_id: string;
  operation: "INSERT" | "UPDATE" | "DELETE" | string;
  /** States hidden by the current read rule are redacted to null. */
  before?: TRow | null;
  /** States hidden by the current read rule are redacted to null. */
  after?: TRow | null;
  actor_id?: string | null;
  actor_role?: string | null;
  origin: string;
  schema_version: number;
  committed_at: number;
  causation_id?: string | null;
  idempotency_key?: string | null;
};

export type ResourceHistoryResult<TRow> = {
  data: ResourceHistoryEntry<TRow>[];
  meta: {
    limit: number;
    next_before_sequence?: number | null;
  };
};

export type ResourceStateAtOptions = {
  /** Inclusive durable journal sequence. */
  sequence?: number;
  /** Inclusive Unix timestamp in seconds, or a JavaScript Date. */
  timestamp?: number | Date;
};

export type ResourceStateAt<TRow> = {
  record: TRow;
  sequence: number;
  event_id: string;
  committed_at: number;
  schema_version: number;
};

export type ResourcePermissions = {
  read: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
  subscribe: boolean;
  history: boolean;
};

export type SyncRecord<TRow = Record<string, unknown>> = {
  data: TRow;
  version: number;
};

export type SyncBootstrapResponse = {
  protocol_version: 1;
  schema_version: string;
  cursor: number;
  resources: Record<string, { records: SyncRecord[] }>;
};

export type SyncEvent = {
  sequence: number;
  event_id: string;
  resource: string;
  record_id: string;
  operation: "INSERT" | "UPDATE" | "DELETE" | string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  actor_id?: string | null;
  origin: string;
  committed_at: number;
  schema_version: number;
};

export type SyncPullResponse = {
  protocol_version: 1;
  schema_version: string;
  cursor: number;
  has_more: boolean;
  events: SyncEvent[];
};

export type SyncMutationInput = {
  id: string;
  resource: string;
  operation: "create" | "update" | "delete";
  record_id?: string;
  data?: Record<string, unknown>;
  base_sequence?: number;
};

export type SyncMutationResult = {
  mutation_id: string;
  status: "acknowledged" | "conflict" | "rejected" | "retry" | string;
  record?: Record<string, unknown>;
  sequence?: number;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type SyncMutationResponse = {
  protocol_version: 1;
  results: SyncMutationResult[];
};

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function tokenSubject(token?: string): string | undefined {
  if (!token) return undefined;
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decode = (globalThis as { atob?: (value: string) => string }).atob;
    if (!decode) return undefined;
    const parsed = JSON.parse(decode(padded)) as { sub?: unknown };
    return typeof parsed.sub === "string" && parsed.sub ? parsed.sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Subscription keys are `table` or `table#rowId`. Split only on the first `#`
 * so row IDs that themselves contain `#` round-trip correctly.
 */
export function parseSubKey(key: string): { table: string; rowId?: string } {
  const idx = key.indexOf("#");
  if (idx === -1) return { table: key };
  return { table: key.slice(0, idx), rowId: key.slice(idx + 1) };
}

export function makeSubKey(table: string, rowId?: string): string {
  return rowId !== undefined && rowId !== "" ? `${table}#${rowId}` : table;
}

export class LoomupError extends Error {
  code?: string;
  status?: number;
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "LoomupError";
    this.code = code;
    this.status = status;
  }
}

export function createClient<
  TMap = DefaultTableMap,
  TInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
>(
  options: CreateClientOptions,
): LoomupClient<TMap, TInsertMap, TUpdateMap> {
  return new LoomupClient<TMap, TInsertMap, TUpdateMap>(options);
}

type WsCtor = {
  new (url: string, protocols?: string | string[]): WebSocket;
};

function resolveWebSocket(impl?: typeof WebSocket): WsCtor {
  if (impl) return impl as unknown as WsCtor;
  const g = globalThis as { WebSocket?: typeof WebSocket };
  if (typeof g.WebSocket === "function") {
    return g.WebSocket as unknown as WsCtor;
  }
  throw new LoomupError(
    "WebSocket is not available in this environment. Pass WebSocketImpl in createClient options (e.g. from 'ws' in Node).",
    "no_websocket",
  );
}

export class LoomupClient<
  TMap = DefaultTableMap,
  TInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
> {
  readonly url: string;
  private token?: string;
  private refreshToken?: string;
  private readonly publishableKey?: string;
  private readonly serviceKey?: string;
  private ws?: WebSocket;
  /** Monotonic socket identity; retired-socket events are ignored. */
  private wsGeneration = 0;
  private subs = new Map<string, Set<SubscribeHandler>>();
  private controlHandlers = new Set<ControlHandler>();
  /** Pending subscribe acks keyed by requestId (subscribeReady waits on these). */
  private pendingSubscribeAcks = new Map<
    string,
    {
      key: string;
      resolve: () => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private pendingSubscribeByKey = new Map<string, { requestId: string; promise: Promise<void> }>();
  private queuedSubscribeRequestIds = new Map<string, string>();
  private subscribeRequestKeys = new Map<string, string>();
  private acknowledgedSubscriptions = new Set<string>();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private intentionalClose = false;
  private refreshing: Promise<AuthTokens> | null = null;
  /** Lazily resolved only when realtime is used (REST-only needs no WebSocket). */
  private readonly wsImplOption?: typeof WebSocket;
  private wsCtor?: WsCtor;
  /** True after the first successful WS open; subsequent opens are reconnects. */
  private hasOpenedOnce = false;
  /** Consecutive reconnect failures (reset only after a stable open window). */
  private reconnectAttempt = 0;
  /** Timer that clears reconnectAttempt after a stable connection period. */
  private stableOpenTimer?: ReturnType<typeof setTimeout>;
  private heartbeatIntervalTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimeoutTimer?: ReturnType<typeof setTimeout>;
  private pendingHeartbeatRequestId?: string;
  private heartbeatSequence = 0;
  private lastHeartbeatAt = 0;
  private readonly heartbeatEnabled: boolean;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly heartbeatStaleAfterMs: number;
  private realtimeStatusValue: RealtimeStatus = "connecting";
  private realtimeStatusHandlers = new Set<(status: RealtimeStatus) => void>();
  private browserLifecycleAttached = false;
  private readonly runtimeResumeHandler = () => this.handleRuntimeResume();
  private readonly visibilityResumeHandler = () => {
    const doc = (globalThis as { document?: Document }).document;
    if (!doc || doc.visibilityState === "visible") this.handleRuntimeResume();
  };
  /** Optional primary-key field names per table for resync id extraction. */
  private tablePrimaryKeys = new Map<string, string>();
  /** Optional token persistence hook (framework adapters). */
  private readonly onTokens?: (tokens: AuthTokens | null) => void;
  private readonly accessTokenProvider?: () => Promise<string | undefined>;
  private externalRefresh: Promise<string | undefined> | null = null;
  private authScopeValue: string;
  private authScopeHandlers = new Set<(scope: string) => void>();
  /** Ms a socket must stay open before backoff counter resets. */
  private static readonly STABLE_OPEN_MS = 5_000;

  constructor(options: CreateClientOptions) {
    this.url = options.url.replace(/\/$/, "");
    this.token = options.token;
    this.refreshToken = options.refreshToken;
    this.publishableKey = options.publishableKey;
    this.serviceKey = options.serviceKey;
    this.wsImplOption = options.WebSocketImpl;
    this.onTokens = options.onTokens;
    this.accessTokenProvider = options.accessTokenProvider;
    this.authScopeValue = tokenSubject(options.token) ?? "anonymous";
    const heartbeat = options.realtimeHeartbeat;
    this.heartbeatEnabled = heartbeat !== false;
    const heartbeatOptions = heartbeat === false ? undefined : heartbeat;
    this.heartbeatIntervalMs = Math.max(1, heartbeatOptions?.intervalMs ?? 25_000);
    this.heartbeatTimeoutMs = Math.max(1, heartbeatOptions?.timeoutMs ?? 12_000);
    this.heartbeatStaleAfterMs = Math.max(
      1,
      heartbeatOptions?.staleAfterMs
        ?? this.heartbeatIntervalMs + this.heartbeatTimeoutMs,
    );
  }

  private getWsCtor(): WsCtor {
    if (!this.wsCtor) {
      this.wsCtor = resolveWebSocket(this.wsImplOption);
    }
    return this.wsCtor;
  }

  /**
   * Observe auth/subscribe control failures (and successes). Change events are
   * delivered via table `subscribe` handlers only.
   */
  onControl(handler: ControlHandler): () => void {
    this.controlHandlers.add(handler);
    return () => {
      this.controlHandlers.delete(handler);
    };
  }

  /** Current optional realtime liveness status. */
  get realtimeStatus(): RealtimeStatus {
    return this.realtimeStatusValue;
  }

  /** Observe realtime liveness without making status handling mandatory. */
  onRealtimeStatus(handler: (status: RealtimeStatus) => void): () => void {
    this.realtimeStatusHandlers.add(handler);
    return () => this.realtimeStatusHandlers.delete(handler);
  }

  setToken(token: string | undefined) {
    const prev = this.token;
    this.token = token;
    this.setAuthScope(tokenSubject(token) ?? "anonymous");
    // Clearing the token must drop the authenticated socket; reauth alone would
    // leave the server session intact when no auth frame is sent.
    if (!token && prev) {
      this.forceReconnectUnauthed();
      return;
    }
    // Public setToken must re-auth + resubscribe like internal applyTokens.
    this.reauthAndResubscribe();
  }

  setRefreshToken(token: string | undefined) {
    this.refreshToken = token;
  }

  /**
   * Set access + refresh tokens together and re-auth open realtime sockets.
   * Invokes `onTokens` when configured (unlike bare setToken/setRefreshToken).
   */
  setSession(session: SessionTokens) {
    this.applyTokens({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      token_type: session.token_type ?? "Bearer",
      expires_in: session.expires_in ?? 0,
      user: session.user,
    });
  }

  get accessToken() {
    return this.token;
  }

  get refreshTokenValue() {
    return this.refreshToken;
  }

  /** Stable cache scope derived from the authenticated JWT subject. */
  get authScope() {
    return this.authScopeValue;
  }

  /** Observe identity changes. Token refreshes for the same user do not fire. */
  onAuthScopeChange(handler: (scope: string) => void): () => void {
    this.authScopeHandlers.add(handler);
    return () => this.authScopeHandlers.delete(handler);
  }

  get auth() {
    return {
      /** Register a new user (alias: register). */
      signUp: (creds: { email: string; password: string }) => this.signUp(creds),
      register: (creds: { email: string; password: string }) => this.signUp(creds),
      /** Login (alias: login). */
      signIn: (creds: { email: string; password: string }) => this.signIn(creds),
      login: (creds: { email: string; password: string }) => this.signIn(creds),
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

  /** Built-in user resource. `auth` remains the 0.1 compatibility facade. */
  get users() {
    return new UsersResource(this);
  }

  /** Built-in file resources grouped by their declared bucket. */
  get files() {
    return {
      from: (bucket: string) => new FileResource(this, bucket),
    };
  }

  /** Mobile push device registration (Expo / FCM / APNs tokens). */
  get push() {
    return {
      registerDevice: (body: RegisterDeviceInput) => this.registerPushDevice(body),
      unregisterDevice: (idOrToken: string | { id?: string; token?: string }) =>
        this.unregisterPushDevice(idOrToken),
      listDevices: () => this.listPushDevices(),
      webConfig: () => this.webPushConfig(),
    };
  }

  /**
   * Object storage (`/storage/v1`). Requires server `[storage].enabled = true`
   * and configured buckets. Does **not** use JSON `request()` for uploads/downloads.
   */
  get storage() {
    return {
      /** List buckets declared in server config. */
      listBuckets: () => this.listStorageBuckets(),
      /** Bucket-scoped operations (upload / download / list / remove). */
      from: (bucket: string) => new StorageBucket(this, bucket),
    };
  }

  /** Durable external-worker job primitives. Requires a scoped service key. */
  get jobs() {
    return {
      enqueue: <T>(name: string, payload: T, runAt?: number) =>
        this.request<{ data: { id: string } }>(
          "POST",
          `/api/jobs/${encodeURIComponent(name)}/enqueue`,
          { payload, run_at: runAt },
        ).then((response) => response.data),
      claim: <T = unknown>(workerId: string, leaseSeconds = 60) =>
        this.request<{ data: JobLease<T> | null }>("POST", "/api/jobs/claim", {
          worker_id: workerId,
          lease_seconds: leaseSeconds,
        }).then((response) => response.data),
      heartbeat: (id: string, workerId: string, leaseSeconds = 60) =>
        this.request("POST", `/api/jobs/${encodeURIComponent(id)}/heartbeat`, {
          worker_id: workerId,
          lease_seconds: leaseSeconds,
        }),
      complete: <T>(id: string, workerId: string, result: T) =>
        this.request("POST", `/api/jobs/${encodeURIComponent(id)}/complete`, {
          worker_id: workerId,
          result,
        }),
      fail: (id: string, workerId: string, error: string) =>
        this.request("POST", `/api/jobs/${encodeURIComponent(id)}/fail`, {
          worker_id: workerId,
          error,
        }),
    };
  }

  async listStorageBuckets(): Promise<StorageBucketInfo[]> {
    const res = await this.request<{ data: StorageBucketInfo[] }>(
      "GET",
      "/storage/v1/buckets",
    );
    return res.data;
  }

  /**
   * Low-level storage HTTP with optional binary body and custom headers.
   * Handles 401 refresh retry like {@link request}.
   */
  async requestStorage(
    method: string,
    path: string,
    opts?: {
      body?: BodyInit | null;
      headers?: Record<string, string>;
      skipRetry?: boolean;
      /** When true, return raw Response (download). Default parses JSON envelope. */
      raw?: boolean;
    },
  ): Promise<Response | unknown> {
    const headers: Record<string, string> = {
      Accept: opts?.raw ? "*/*" : "application/json",
      ...(opts?.headers ?? {}),
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    } else if (this.serviceKey) {
      headers.Authorization = `Bearer ${this.serviceKey}`;
    }
    if (this.publishableKey) {
      headers["X-Loomup-Key"] = this.publishableKey;
    }
    const res = await fetch(joinUrl(this.url, path), {
      method,
      headers,
      body: opts?.body ?? undefined,
    });
    if (
      res.status === 401 &&
      !opts?.skipRetry &&
      this.refreshToken &&
      !path.startsWith("/auth/")
    ) {
      try {
        await this.refresh();
        return this.requestStorage(method, path, { ...opts, skipRetry: true });
      } catch {
        /* fall through */
      }
    }
    if (
      res.status === 401 &&
      !opts?.skipRetry &&
      this.accessTokenProvider &&
      !path.startsWith("/auth/")
    ) {
      try {
        if (!this.externalRefresh) {
          this.externalRefresh = this.accessTokenProvider().finally(() => {
            this.externalRefresh = null;
          });
        }
        const nextToken = await this.externalRefresh;
        if (nextToken) {
          this.setToken(nextToken);
          return this.requestStorage(method, path, { ...opts, skipRetry: true });
        }
      } catch {
        /* fall through */
      }
    }
    if (!res.ok) {
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const msg =
        json?.error?.message || json?.message || text || res.statusText;
      throw new LoomupError(String(msg), json?.error?.code, res.status);
    }
    if (opts?.raw) {
      return res;
    }
    if (res.status === 204 || res.status === 304) {
      return null;
    }
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  async registerPushDevice(body: RegisterDeviceInput): Promise<PushDevice> {
    const res = await this.request<{ data: PushDevice }>("POST", "/push/devices", body);
    return res.data;
  }

  async listPushDevices(): Promise<PushDevice[]> {
    const res = await this.request<{ data: PushDevice[] }>("GET", "/push/devices");
    return res.data;
  }

  async webPushConfig(): Promise<WebPushConfig> {
    const res = await this.request<{ data: WebPushConfig }>("GET", "/push/web-config");
    return res.data;
  }

  async unregisterPushDevice(
    idOrToken: string | { id?: string; token?: string },
  ): Promise<void> {
    if (typeof idOrToken === "string") {
      // Prefer path delete when it looks like a device id (uuid-ish); otherwise query token.
      if (idOrToken.includes("-") && idOrToken.length >= 32 && !idOrToken.includes("[")) {
        await this.request("DELETE", `/push/devices/${encodeURIComponent(idOrToken)}`);
        return;
      }
      await this.request(
        "DELETE",
        `/push/devices?token=${encodeURIComponent(idOrToken)}`,
      );
      return;
    }
    if (idOrToken.id) {
      await this.request("DELETE", `/push/devices/${encodeURIComponent(idOrToken.id)}`);
      return;
    }
    if (idOrToken.token) {
      await this.request(
        "DELETE",
        `/push/devices?token=${encodeURIComponent(idOrToken.token)}`,
      );
      return;
    }
    throw new LoomupError("id or token required to unregister device", "bad_request");
  }

  /**
   * Typed table accessor. Pass generated maps as client generics:
   * `createClient<TableMap, TableInsertMap, TableUpdateMap>({ url }).from("todos")`.
   */
  from<K extends keyof TMap & string>(
    table: K,
  ): TableQuery<
    TMap[K],
    K extends keyof TInsertMap
      ? NonNullable<TInsertMap[K]>
      : Partial<TMap[K]> & Record<string, unknown>,
    K extends keyof TUpdateMap
      ? NonNullable<TUpdateMap[K]>
      : Partial<TMap[K]> & Record<string, unknown>
  > {
    return new TableQuery(this as unknown as LoomupClient, table);
  }

  /**
   * Domain-resource accessor. This is the preferred API for new applications;
   * it delegates to the stable 0.1 table transport during the transition.
   */
  resource<K extends keyof TMap & string>(
    name: K,
  ): Resource<
    TMap[K],
    K extends keyof TInsertMap
      ? NonNullable<TInsertMap[K]>
      : Partial<TMap[K]> & Record<string, unknown>,
    K extends keyof TUpdateMap
      ? NonNullable<TUpdateMap[K]>
      : Partial<TMap[K]> & Record<string, unknown>
  > {
    return new Resource(name, this.from(name));
  }

  /** Execute a manifest-declared, read-only named query. */
  query<TOutput = unknown, TInput = Record<string, unknown>>(
    name: string,
    input: TInput,
  ): Promise<OperationResponse<TOutput>> {
    return this.request(
      "POST",
      `/api/queries/${encodeURIComponent(name)}`,
      input,
    );
  }

  /** Execute a manifest-declared transactional command. */
  command<TOutput = unknown, TInput = Record<string, unknown>>(
    name: string,
    input: TInput,
    options?: CommandOptions,
  ): Promise<OperationResponse<TOutput>> {
    return this.request(
      "POST",
      `/api/commands/${encodeURIComponent(name)}`,
      input,
      {
        headers: options?.idempotencyKey
          ? { "Idempotency-Key": options.idempotencyKey }
          : undefined,
      },
    );
  }

  /** Execute a bounded batch for a command that opts into batch behavior. */
  commandBatch<TOutput = unknown, TInput = Record<string, unknown>>(
    name: string,
    items: readonly TInput[],
    options?: CommandOptions,
  ): Promise<OperationResponse<BatchItemResult<TOutput>[]>> {
    return this.request(
      "POST",
      `/api/commands/${encodeURIComponent(name)}/batch`,
      { items },
      {
        headers: options?.idempotencyKey
          ? { "Idempotency-Key": options.idempotencyKey }
          : undefined,
      },
    );
  }

  /** Search a manifest-declared FTS index. */
  search<TOutput = Record<string, unknown>>(
    name: string,
    input: { query: string; limit?: number; offset?: number },
  ): Promise<OperationResponse<TOutput[]>> {
    return this.request(
      "POST",
      `/api/search/${encodeURIComponent(name)}`,
      input,
    );
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { skipRetry?: boolean; headers?: Record<string, string> },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(opts?.headers ?? {}),
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    } else if (this.serviceKey) {
      headers.Authorization = `Bearer ${this.serviceKey}`;
    }
    if (this.publishableKey) {
      headers["X-Loomup-Key"] = this.publishableKey;
    }
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(joinUrl(this.url, path), {
      method,
      headers,
      body: payload,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (
      res.status === 401 &&
      !opts?.skipRetry &&
      this.refreshToken &&
      path !== "/auth/refresh" &&
      path !== "/auth/login" &&
      path !== "/auth/register"
    ) {
      try {
        await this.refresh();
        return this.request<T>(method, path, body, { ...opts, skipRetry: true });
      } catch {
        /* fall through with original error */
      }
    }
    if (
      res.status === 401 &&
      !opts?.skipRetry &&
      this.accessTokenProvider &&
      !path.startsWith("/auth/")
    ) {
      try {
        if (!this.externalRefresh) {
          this.externalRefresh = this.accessTokenProvider().finally(() => {
            this.externalRefresh = null;
          });
        }
        const nextToken = await this.externalRefresh;
        if (nextToken) {
          this.setToken(nextToken);
          return this.request<T>(method, path, body, { ...opts, skipRetry: true });
        }
      } catch {
        /* fall through with original error */
      }
    }
    if (!res.ok) {
      const msg =
        json?.error?.message || json?.message || text || res.statusText;
      throw new LoomupError(String(msg), json?.error?.code, res.status);
    }
    return json as T;
  }

  /** Authorization-scoped sync snapshot. Cursor is safe to pull after. */
  async syncBootstrap(
    resources: readonly string[],
    clientId: string,
  ): Promise<SyncBootstrapResponse> {
    if (resources.length === 0) {
      throw new LoomupError("sync requires at least one resource", "bad_request");
    }
    const params = new URLSearchParams({
      protocol_version: "1",
      resources: resources.join(","),
      client_id: clientId,
    });
    const response = await this.request<{ data: SyncBootstrapResponse }>(
      "GET",
      `/sync/v1/bootstrap?${params}`,
    );
    return response.data;
  }

  /** Pull the next ordered journal page after a durable cursor. */
  async syncPull(
    cursor: number,
    resources: readonly string[],
    clientId: string,
    limit = 500,
  ): Promise<SyncPullResponse> {
    const params = new URLSearchParams({
      protocol_version: "1",
      cursor: String(cursor),
      limit: String(limit),
      resources: resources.join(","),
      client_id: clientId,
    });
    const response = await this.request<{ data: SyncPullResponse }>(
      "GET",
      `/sync/v1/pull?${params}`,
    );
    return response.data;
  }

  /** Upload one or more stable, idempotent offline mutations. */
  async syncMutations(
    mutations: readonly SyncMutationInput[],
  ): Promise<SyncMutationResponse> {
    const response = await this.request<{ data: SyncMutationResponse }>(
      "POST",
      "/sync/v1/mutations",
      { protocol_version: 1, mutations },
    );
    return response.data;
  }

  async signUp(creds: { email: string; password: string }): Promise<AuthSignUpResult> {
    const res = await this.request<{ data: AuthSignUpResult }>("POST", "/auth/register", creds, {
      skipRetry: true,
    });
    if ("access_token" in res.data) this.applyTokens(res.data);
    return res.data;
  }

  async signIn(creds: { email: string; password: string }): Promise<AuthTokens> {
    const res = await this.request<{ data: AuthTokens }>("POST", "/auth/login", creds, {
      skipRetry: true,
    });
    this.applyTokens(res.data);
    return res.data;
  }

  async oauthProviders(): Promise<OAuthProviderInfo[]> {
    const response = await this.request<{ data: OAuthProviderInfo[] }>(
      "GET",
      "/auth/oauth/providers",
    );
    return response.data;
  }

  async authorizeOAuth(input: OAuthAuthorizeInput): Promise<OAuthAuthorization> {
    const response = await this.request<{ data: OAuthAuthorization }>(
      "POST",
      "/auth/oauth/authorize",
      { provider: input.provider, redirect_to: input.redirectTo },
      { skipRetry: true },
    );
    return response.data;
  }

  async exchangeOAuthCode(input: OAuthExchangeInput): Promise<AuthTokens> {
    const response = await this.request<{ data: AuthTokens }>(
      "POST",
      "/auth/oauth/exchange",
      { code: input.code, code_verifier: input.codeVerifier },
      { skipRetry: true },
    );
    this.applyTokens(response.data);
    return response.data;
  }

  async resendEmailVerification(email: string): Promise<AuthActionResult> {
    const response = await this.request<{ data: AuthActionResult }>(
      "POST",
      "/auth/email-verification/resend",
      { email },
      { skipRetry: true },
    );
    return response.data;
  }

  async confirmEmailVerification(token: string): Promise<AuthTokens> {
    const response = await this.request<{ data: AuthTokens }>(
      "POST",
      "/auth/email-verification/confirm",
      { token },
      { skipRetry: true },
    );
    this.applyTokens(response.data);
    return response.data;
  }

  async requestPasswordReset(email: string): Promise<AuthActionResult> {
    const response = await this.request<{ data: AuthActionResult }>(
      "POST",
      "/auth/password-reset/request",
      { email },
      { skipRetry: true },
    );
    return response.data;
  }

  async confirmPasswordReset(input: {
    token: string;
    password: string;
  }): Promise<AuthActionResult> {
    const response = await this.request<{ data: AuthActionResult }>(
      "POST",
      "/auth/password-reset/confirm",
      input,
      { skipRetry: true },
    );
    return response.data;
  }

  async acceptInvitation(input: { token: string; password: string }): Promise<AuthTokens> {
    const response = await this.request<{ data: AuthTokens }>(
      "POST",
      "/auth/invitations/accept",
      input,
      { skipRetry: true },
    );
    this.applyTokens(response.data);
    return response.data;
  }

  async me(): Promise<User> {
    const res = await this.request<{ data: User }>("GET", "/auth/me");
    return res.data;
  }

  async refresh(): Promise<AuthTokens> {
    if (!this.refreshToken) {
      throw new LoomupError("no refresh token", "no_refresh");
    }
    // Coalesce concurrent refresh attempts.
    if (this.refreshing) {
      return this.refreshing;
    }
    this.refreshing = (async () => {
      const res = await this.request<{ data: AuthTokens }>(
        "POST",
        "/auth/refresh",
        { refresh_token: this.refreshToken },
        { skipRetry: true },
      );
      this.applyTokens(res.data);
      return res.data;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  async signOut(): Promise<void> {
    if (this.refreshToken) {
      try {
        await this.request(
          "POST",
          "/auth/logout",
          { refresh_token: this.refreshToken },
          { skipRetry: true },
        );
      } catch {
        /* ignore */
      }
    }
    this.token = undefined;
    this.refreshToken = undefined;
    this.setAuthScope("anonymous");
    this.closeRealtime();
    try {
      this.onTokens?.(null);
    } catch {
      /* ignore storage errors */
    }
  }

  private applyTokens(data: AuthTokens) {
    this.token = data.access_token;
    this.refreshToken = data.refresh_token;
    this.setAuthScope(data.user?.id ?? tokenSubject(data.access_token) ?? "anonymous");
    // Server subscriptions retain the token from subscribe time — re-auth and
    // resubscribe so broadcasts keep flowing after JWT rotation.
    this.reauthAndResubscribe();
    try {
      this.onTokens?.(data);
    } catch {
      /* ignore storage errors */
    }
  }

  private setAuthScope(scope: string) {
    if (scope === this.authScopeValue) return;
    this.authScopeValue = scope;
    for (const handler of this.authScopeHandlers) {
      try {
        handler(scope);
      } catch {
        /* cache observers cannot break authentication */
      }
    }
  }

  private setRealtimeStatus(status: RealtimeStatus) {
    if (status === this.realtimeStatusValue) return;
    this.realtimeStatusValue = status;
    for (const handler of this.realtimeStatusHandlers) {
      try {
        handler(status);
      } catch {
        /* status observers cannot break realtime recovery */
      }
    }
  }

  private isCurrentSocket(ws: WebSocket, generation: number): boolean {
    return this.ws === ws && this.wsGeneration === generation;
  }

  private clearHeartbeatState(resetLastHeartbeat = true) {
    if (this.heartbeatIntervalTimer) clearTimeout(this.heartbeatIntervalTimer);
    if (this.heartbeatTimeoutTimer) clearTimeout(this.heartbeatTimeoutTimer);
    this.heartbeatIntervalTimer = undefined;
    this.heartbeatTimeoutTimer = undefined;
    this.pendingHeartbeatRequestId = undefined;
    if (resetLastHeartbeat) this.lastHeartbeatAt = 0;
  }

  private scheduleHeartbeat(ws: WebSocket, generation: number) {
    if (
      !this.heartbeatEnabled
      || !this.isCurrentSocket(ws, generation)
      || ws.readyState !== 1
      || this.subs.size === 0
    ) {
      this.clearHeartbeatState(false);
      return;
    }
    if (this.heartbeatIntervalTimer) clearTimeout(this.heartbeatIntervalTimer);
    this.heartbeatIntervalTimer = setTimeout(() => {
      this.heartbeatIntervalTimer = undefined;
      this.sendHeartbeatProbe(ws, generation);
    }, this.heartbeatIntervalMs);
  }

  private activateHeartbeatForCurrentSocket() {
    if (!this.heartbeatEnabled || this.subs.size === 0) return;
    this.attachBrowserLifecycle();
    const ws = this.ws;
    const generation = this.wsGeneration;
    if (!ws || ws.readyState !== 1 || !this.isCurrentSocket(ws, generation)) return;
    if (this.lastHeartbeatAt === 0) this.lastHeartbeatAt = Date.now();
    this.scheduleHeartbeat(ws, generation);
  }

  private sendHeartbeatProbe(ws: WebSocket, generation: number) {
    if (
      !this.heartbeatEnabled
      || !this.isCurrentSocket(ws, generation)
      || ws.readyState !== 1
      || this.subs.size === 0
    ) {
      this.clearHeartbeatState(false);
      return;
    }
    if (this.heartbeatIntervalTimer) clearTimeout(this.heartbeatIntervalTimer);
    if (this.heartbeatTimeoutTimer) clearTimeout(this.heartbeatTimeoutTimer);
    this.heartbeatIntervalTimer = undefined;
    this.heartbeatTimeoutTimer = undefined;
    this.heartbeatSequence += 1;
    const requestId = `hb_${generation}_${this.heartbeatSequence}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.pendingHeartbeatRequestId = requestId;
    try {
      ws.send(JSON.stringify({ type: "ping", requestId, sentAt: Date.now() }));
    } catch {
      this.handleHeartbeatTimeout(ws, generation);
      return;
    }
    this.heartbeatTimeoutTimer = setTimeout(() => {
      this.heartbeatTimeoutTimer = undefined;
      if (
        this.isCurrentSocket(ws, generation)
        && this.pendingHeartbeatRequestId === requestId
      ) {
        this.handleHeartbeatTimeout(ws, generation);
      }
    }, this.heartbeatTimeoutMs);
  }

  private handleHeartbeatPong(
    data: ControlEvent,
    ws: WebSocket,
    generation: number,
  ): boolean {
    if (
      data.type !== "pong"
      || !data.requestId
      || !this.isCurrentSocket(ws, generation)
      || data.requestId !== this.pendingHeartbeatRequestId
    ) {
      return false;
    }
    if (this.heartbeatTimeoutTimer) clearTimeout(this.heartbeatTimeoutTimer);
    this.heartbeatTimeoutTimer = undefined;
    this.pendingHeartbeatRequestId = undefined;
    this.lastHeartbeatAt = Date.now();
    this.setRealtimeStatus("live");
    this.scheduleHeartbeat(ws, generation);
    return true;
  }

  private prepareSubscriptionsForReplacement() {
    this.acknowledgedSubscriptions.clear();
    for (const [key, pending] of this.pendingSubscribeByKey) {
      this.queuedSubscribeRequestIds.set(key, pending.requestId);
    }
  }

  private retireSocket(ws: WebSocket, generation: number, reconnect: boolean) {
    if (!this.isCurrentSocket(ws, generation)) return;
    this.clearHeartbeatState();
    this.prepareSubscriptionsForReplacement();
    this.ws = undefined;
    // Invalidate handlers before initiating close: a stuck close handshake or
    // late close/message event cannot block or disturb the replacement socket.
    this.wsGeneration += 1;
    if (this.stableOpenTimer) clearTimeout(this.stableOpenTimer);
    this.stableOpenTimer = undefined;
    try {
      ws.close();
    } catch {
      /* replacement does not depend on close handshake completion */
    }
    if (reconnect && this.subs.size > 0 && !this.intentionalClose) {
      this.scheduleReconnect();
    }
  }

  private handleHeartbeatTimeout(ws: WebSocket, generation: number) {
    if (!this.isCurrentSocket(ws, generation)) return;
    this.setRealtimeStatus("stale");
    this.retireSocket(ws, generation, true);
  }

  private attachBrowserLifecycle() {
    if (this.browserLifecycleAttached || !this.heartbeatEnabled) return;
    const runtime = globalThis as unknown as {
      addEventListener?: (type: string, listener: () => void) => void;
    };
    if (typeof runtime.addEventListener === "function") {
      runtime.addEventListener("pageshow", this.runtimeResumeHandler);
      runtime.addEventListener("online", this.runtimeResumeHandler);
      this.browserLifecycleAttached = true;
    }
    const doc = (globalThis as { document?: Document }).document;
    if (doc && typeof doc.addEventListener === "function") {
      doc.addEventListener("visibilitychange", this.visibilityResumeHandler);
      this.browserLifecycleAttached = true;
    }
  }

  private detachBrowserLifecycle() {
    if (!this.browserLifecycleAttached) return;
    const runtime = globalThis as unknown as {
      removeEventListener?: (type: string, listener: () => void) => void;
    };
    runtime.removeEventListener?.("pageshow", this.runtimeResumeHandler);
    runtime.removeEventListener?.("online", this.runtimeResumeHandler);
    const doc = (globalThis as { document?: Document }).document;
    doc?.removeEventListener?.("visibilitychange", this.visibilityResumeHandler);
    this.browserLifecycleAttached = false;
  }

  private handleRuntimeResume() {
    if (!this.heartbeatEnabled || this.subs.size === 0) return;
    const ws = this.ws;
    const generation = this.wsGeneration;
    if (ws && ws.readyState === 1 && this.isCurrentSocket(ws, generation)) {
      if (
        this.lastHeartbeatAt === 0
        || Date.now() - this.lastHeartbeatAt >= this.heartbeatStaleAfterMs
      ) {
        this.setRealtimeStatus("stale");
        this.retireSocket(ws, generation, true);
      } else {
        this.sendHeartbeatProbe(ws, generation);
      }
      return;
    }
    this.setRealtimeStatus("stale");
    if (ws && this.isCurrentSocket(ws, generation)) {
      this.retireSocket(ws, generation, true);
    } else {
      this.scheduleReconnect();
    }
  }

  /**
   * Re-send connection auth + subscribe for every active key using the current
   * access token. No-op when the socket is not open or there are no subs.
   */
  private reauthAndResubscribe() {
    const OPEN = 1;
    if (!this.ws || this.ws.readyState !== OPEN || this.subs.size === 0) {
      return;
    }
    if (this.token) {
      this.send({ type: "auth", token: this.token });
    }
    for (const key of this.subs.keys()) {
      this.acknowledgedSubscriptions.delete(key);
      const pending = this.pendingSubscribeByKey.get(key);
      if (pending) this.queuedSubscribeRequestIds.set(key, pending.requestId);
      const { table, rowId } = parseSubKey(key);
      this.sendSubscribe(table, rowId);
    }
  }

  /**
   * Close the current socket and reopen without an access token so the server
   * no longer treats the connection as authenticated. Resubscribes active keys.
   */
  private forceReconnectUnauthed() {
    if (this.stableOpenTimer) {
      clearTimeout(this.stableOpenTimer);
      this.stableOpenTimer = undefined;
    }
    const hadSubs = this.subs.size > 0;
    if (this.ws) {
      const ws = this.ws;
      const generation = this.wsGeneration;
      this.intentionalClose = true;
      this.retireSocket(ws, generation, false);
      this.intentionalClose = false;
    }
    if (hadSubs) {
      this.ensureWs();
    }
  }

  /** Register a local handler; returns the map key and whether this is the first. */
  private registerSubscribeHandler(
    table: string,
    handler: SubscribeHandler,
    rowId?: string,
  ): { key: string; isFirst: boolean } {
    const key = makeSubKey(table, rowId);
    const isFirst = !this.subs.has(key);
    if (isFirst) {
      this.subs.set(key, new Set());
    }
    this.subs.get(key)!.add(handler);
    this.attachBrowserLifecycle();
    this.activateHeartbeatForCurrentSocket();
    return { key, isFirst };
  }

  private makeUnsub(
    table: string,
    handler: SubscribeHandler,
    rowId?: string,
  ): () => void {
    const key = makeSubKey(table, rowId);
    return () => {
      this.subs.get(key)?.delete(handler);
      if (this.subs.get(key)?.size === 0) {
        this.subs.delete(key);
        this.acknowledgedSubscriptions.delete(key);
        this.queuedSubscribeRequestIds.delete(key);
        // Row-scoped unsub must include id so other row subs on the table remain.
        const msg: Record<string, unknown> = {
          type: "unsubscribe",
          table,
          channel: table,
        };
        if (rowId) msg.id = rowId;
        this.send(msg);
        if (this.subs.size === 0) {
          this.clearHeartbeatState();
          this.detachBrowserLifecycle();
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          if (this.stableOpenTimer) clearTimeout(this.stableOpenTimer);
          this.reconnectTimer = undefined;
          this.stableOpenTimer = undefined;
        }
      }
    };
  }

  /** Low-level subscribe used by TableQuery.subscribe */
  subscribeTable(
    table: string,
    handler: SubscribeHandler,
    rowId?: string,
  ): () => void {
    const { isFirst } = this.registerSubscribeHandler(table, handler, rowId);
    this.ensureWs();
    // Only the first handler for a key sends a subscribe frame.
    if (isFirst && this.ws?.readyState === 1) {
      this.sendSubscribe(table, rowId);
    }
    return this.makeUnsub(table, handler, rowId);
  }

  /**
   * Subscribe and wait until the server acknowledges the subscription
   * (`type: "subscribed"`), not merely until the WebSocket is OPEN.
   * Prefer this over bare `subscribe()` when the next statement mutates data.
   * Sends exactly one subscribe frame (no duplicate logical subscription).
   */
  async subscribeTableReady(
    table: string,
    handler: SubscribeHandler,
    rowId?: string,
    timeoutMs = 5000,
  ): Promise<() => void> {
    const { key } = this.registerSubscribeHandler(table, handler, rowId);
    const unsub = this.makeUnsub(table, handler, rowId);
    try {
      if (this.acknowledgedSubscriptions.has(key)) return unsub;
      let pending = this.pendingSubscribeByKey.get(key);
      if (!pending) {
        const requestId = `sub_${table}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const promise = this.waitForSubscribeAck(requestId, key, timeoutMs);
        pending = { requestId, promise };
        this.pendingSubscribeByKey.set(key, pending);
        this.queuedSubscribeRequestIds.set(key, requestId);
      }
      this.ensureWs();
      if (this.ws?.readyState === 1 && this.queuedSubscribeRequestIds.has(key)) {
        this.sendSubscribe(table, rowId);
      }
      await pending.promise;
      return unsub;
    } catch (err) {
      // Do not leave a half-attached subscription if ack never arrives / errors.
      unsub();
      throw err;
    }
  }

  /**
   * Wait for a `subscribed` control frame with matching requestId, or reject
   * on subscribe error / timeout.
   */
  private waitForSubscribeAck(
    requestId: string,
    key: string,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSubscribeAcks.delete(requestId);
        if (this.pendingSubscribeByKey.get(key)?.requestId === requestId) {
          this.pendingSubscribeByKey.delete(key);
        }
        this.queuedSubscribeRequestIds.delete(key);
        reject(new Error("subscribe acknowledgement timeout"));
      }, timeoutMs);
      this.pendingSubscribeAcks.set(requestId, {
        key,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });
    });
  }

  private resolveSubscribeAck(data: ControlEvent) {
    const rid = data.requestId;
    if (!rid) return;
    const requestKey = this.subscribeRequestKeys.get(rid);
    this.subscribeRequestKeys.delete(rid);
    if (data.type === "subscribed" && requestKey) {
      this.acknowledgedSubscriptions.add(requestKey);
    }
    const pending = this.pendingSubscribeAcks.get(rid);
    if (!pending) return;
    this.pendingSubscribeAcks.delete(rid);
    if (this.pendingSubscribeByKey.get(pending.key)?.requestId === rid) {
      this.pendingSubscribeByKey.delete(pending.key);
    }
    if (data.type === "subscribed") {
      this.acknowledgedSubscriptions.add(pending.key);
      pending.resolve();
    } else if (data.type === "error") {
      pending.reject(
        new Error(data.message || data.code || "subscribe failed"),
      );
    }
  }

  private wsUrl(): string {
    const u = new URL(this.url);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    const basePath = u.pathname.replace(/\/$/, "");
    u.pathname = `${basePath}/realtime`;
    u.search = "";
    return u.toString();
  }

  private ensureWs() {
    const OPEN = 1;
    const CONNECTING = 0;
    if (
      this.ws &&
      (this.ws.readyState === OPEN || this.ws.readyState === CONNECTING)
    ) {
      return;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.intentionalClose = false;
    this.setRealtimeStatus(this.hasOpenedOnce ? "reconnecting" : "connecting");
    const Ws = this.getWsCtor();
    const ws = new Ws(this.wsUrl());
    const generation = ++this.wsGeneration;
    let opened = false;
    this.ws = ws;
    ws.onopen = () => {
      if (!this.isCurrentSocket(ws, generation) || opened) return;
      opened = true;
      // Reset backoff only after a stable open window so open/close flapping
      // still reaches exponential delays.
      if (this.stableOpenTimer) clearTimeout(this.stableOpenTimer);
      this.stableOpenTimer = undefined;
      if (this.subs.size > 0) {
        this.stableOpenTimer = setTimeout(() => {
          this.reconnectAttempt = 0;
          this.stableOpenTimer = undefined;
        }, LoomupClient.STABLE_OPEN_MS);
      }
      // Connection-level auth when we have a token.
      if (this.token) {
        this.send({ type: "auth", token: this.token });
      }
      for (const key of this.subs.keys()) {
        const { table, rowId } = parseSubKey(key);
        this.sendSubscribe(table, rowId);
      }
      this.lastHeartbeatAt = Date.now();
      this.setRealtimeStatus("live");
      this.activateHeartbeatForCurrentSocket();
      // After a reconnect (not the first open), re-fetch current state so events
      // that occurred while disconnected are not silently dropped (server marks
      // CDC processed without client delivery during the outage).
      const isReconnect = this.hasOpenedOnce;
      this.hasOpenedOnce = true;
      if (isReconnect && this.subs.size > 0) {
        void this.resyncSubscriptions();
      }
    };
    ws.onmessage = (ev) => {
      if (!this.isCurrentSocket(ws, generation)) return;
      try {
        const data = JSON.parse(String(ev.data)) as ChangeEvent | ControlEvent;
        if (data.type === "pong") {
          this.handleHeartbeatPong(data as ControlEvent, ws, generation);
          return;
        }
        if (data.type === "change") {
          const change = data as ChangeEvent;
          const exact = this.subs.get(makeSubKey(change.table, change.id));
          const all = this.subs.get(change.table);
          exact?.forEach((h) => h(change));
          all?.forEach((h) => h(change));
          return;
        }
        // Resolve subscribeReady waiters before fan-out to control handlers.
        if (data.type === "subscribed" || data.type === "error") {
          this.resolveSubscribeAck(data as ControlEvent);
        }
        // Surface auth/subscribe control responses.
        this.controlHandlers.forEach((h) => h(data as ControlEvent));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (!this.isCurrentSocket(ws, generation)) return;
      this.clearHeartbeatState();
      this.ws = undefined;
      this.wsGeneration += 1;
      this.prepareSubscriptionsForReplacement();
      // Connection did not stay open long enough — keep backoff counter.
      if (this.stableOpenTimer) {
        clearTimeout(this.stableOpenTimer);
        this.stableOpenTimer = undefined;
      }
      if (!this.intentionalClose && this.subs.size > 0) {
        this.scheduleReconnect();
      }
    };
  }

  /**
   * Exponential backoff with full jitter for reconnect delays.
   * Base 1s, doubles each attempt, caps at 30s; delay = random(0, min(cap, base*2^n)).
   */
  private scheduleReconnect() {
    if (this.intentionalClose || this.subs.size === 0 || this.reconnectTimer) return;
    this.setRealtimeStatus("reconnecting");
    const baseMs = 1000;
    const capMs = 30_000;
    const exp = Math.min(capMs, baseMs * Math.pow(2, this.reconnectAttempt));
    this.reconnectAttempt += 1;
    // Full jitter (AWS-style): uniform in [0, exp]
    const delay = Math.floor(Math.random() * exp);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.intentionalClose && this.subs.size > 0) this.ensureWs();
    }, Math.max(50, delay));
  }

  /**
   * Reconnect behavior: on unexpected close the SDK reconnects with exponential
   * backoff + full jitter (not a fixed 1s), re-sends subscribe for every active
   * table/row key (first-`#` safe), then REST-resyncs subscribed rows so
   * outage-window changes are delivered as `op: "RESYNC"` change events.
   * Resync refetches current authorized state (does not replay deletes or
   * intermediate updates). Call closeRealtime() to stop reconnect loops.
   */
  get reconnectEnabled() {
    return !this.intentionalClose;
  }

  /** Hint the primary-key column for a table (used by reconnect resync). */
  setTablePrimaryKey(table: string, pk: string) {
    this.tablePrimaryKeys.set(table, pk);
  }

  /**
   * Catch-up after reconnect: re-fetch current rows for active subscriptions
   * and emit RESYNC change events to local handlers.
   */
  private async resyncSubscriptions() {
    const keys = [...this.subs.keys()];
    for (const key of keys) {
      const handlers = this.subs.get(key);
      if (!handlers || handlers.size === 0) continue;
      const { table, rowId } = parseSubKey(key);
      try {
        if (rowId !== undefined) {
          const res = await this.request<{ data: Record<string, unknown> }>(
            "GET",
            `/api/${encodeURIComponent(table)}/${encodeURIComponent(rowId)}`,
          );
          // Server event timestamps are Unix seconds.
          const ts = Math.floor(Date.now() / 1000);
          const ev: ChangeEvent = {
            type: "change",
            table,
            op: "RESYNC",
            id: rowId,
            data: res.data,
            ts,
          };
          handlers.forEach((h) => h(ev));
        } else {
          // Paginate catch-up so reconnect is not capped at a single page of 100.
          let offset = 0;
          const pageSize = 100;
          let total = Infinity;
          while (offset < total) {
            const res = await this.request<{
              data: Record<string, unknown>[];
              meta: ListMeta;
            }>(
              "GET",
              `/api/${encodeURIComponent(table)}?limit=${pageSize}&offset=${offset}`,
            );
            const rows = res.data || [];
            total = res.meta?.total ?? rows.length;
            const ts = Math.floor(Date.now() / 1000);
            // Prefer explicit setTablePrimaryKey(table, pk). Default PK column is
            // only the conventional name "id" — never guess via Object.values[0]
            // (unsafe for custom primary keys / column order).
            const pk = this.tablePrimaryKeys.get(table) ?? "id";
            for (const row of rows) {
              const rec = row as Record<string, unknown>;
              if (!Object.prototype.hasOwnProperty.call(rec, pk)) {
                // Skip rather than invent an id from the first column value.
                continue;
              }
              const raw = rec[pk];
              if (raw === undefined || raw === null) continue;
              const id = String(raw);
              const ev: ChangeEvent = {
                type: "change",
                table,
                op: "RESYNC",
                id,
                data: row,
                ts,
              };
              handlers.forEach((h) => h(ev));
            }
            if (rows.length === 0) break;
            offset += rows.length;
            if (rows.length < pageSize) break;
          }
        }
      } catch {
        /* best-effort catch-up; ignore per-key failures */
      }
    }
  }

  /** Send a subscribe frame; returns the requestId used for ack correlation. */
  private sendSubscribe(table: string, rowId?: string): string {
    const key = makeSubKey(table, rowId);
    const requestId = this.queuedSubscribeRequestIds.get(key)
      ?? `sub_${table}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.queuedSubscribeRequestIds.delete(key);
    this.subscribeRequestKeys.set(requestId, key);
    this.send({
      type: "subscribe",
      table,
      channel: table,
      requestId,
      id: rowId,
      token: this.token,
    });
    return requestId;
  }

  /**
   * Wait until the WebSocket is OPEN (or fail after timeoutMs).
   * Use before immediate update/delete sequences after subscribe().
   */
  async whenConnected(timeoutMs = 5000): Promise<void> {
    this.ensureWs();
    const OPEN = 1;
    if (
      this.ws
      && this.ws.readyState === OPEN
      && this.realtimeStatusValue === "live"
    ) return;
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (
          this.ws
          && this.ws.readyState === OPEN
          && this.realtimeStatusValue === "live"
        ) {
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error("websocket connect timeout"));
          return;
        }
        setTimeout(tick, 25);
      };
      tick();
    });
  }

  private send(msg: unknown) {
    // Use numeric OPEN (1) — do not reference global WebSocket, which is absent
    // on Node without a polyfill (REST-only + injected WebSocketImpl path).
    const OPEN = 1;
    if (this.ws && this.ws.readyState === OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  closeRealtime() {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.stableOpenTimer) clearTimeout(this.stableOpenTimer);
    this.reconnectTimer = undefined;
    this.stableOpenTimer = undefined;
    this.clearHeartbeatState();
    this.detachBrowserLifecycle();
    if (this.ws) {
      this.retireSocket(this.ws, this.wsGeneration, false);
    } else {
      this.wsGeneration += 1;
    }
    this.subs.clear();
    this.acknowledgedSubscriptions.clear();
    this.queuedSubscribeRequestIds.clear();
    this.subscribeRequestKeys.clear();
    this.hasOpenedOnce = false;
    this.reconnectAttempt = 0;
    this.setRealtimeStatus("connecting");
    // Fail any in-flight subscribeReady waiters immediately (don't leave them
    // hanging until timeout after intentional close).
    for (const [id, pending] of this.pendingSubscribeAcks) {
      clearTimeout(pending.timer);
      pending.reject(new Error("realtime closed before subscribe acknowledgement"));
      this.pendingSubscribeAcks.delete(id);
    }
    this.pendingSubscribeByKey.clear();
  }
}

export class TableQuery<
  TRow = Record<string, unknown>,
  TInsert = Partial<TRow> & Record<string, unknown>,
  TUpdate = Partial<TRow> & Record<string, unknown>,
> {
  constructor(
    private client: LoomupClient,
    private table: string,
  ) {}

  async select(opts?: ResourceFindOptions): Promise<{ data: TRow[]; meta: ListMeta }> {
    const params = new URLSearchParams();
    if (opts?.cursor) params.set("cursor", opts.cursor);
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.offset != null) params.set("offset", String(opts.offset));
    if (opts?.sort) params.set("sort", opts.sort);
    if (opts?.select?.length) params.set("select", opts.select.join(","));
    if (opts?.where) {
      for (const [k, v] of Object.entries(opts.where)) {
        // SQLite stores booleans as 0/1; send numeric form so filters match without
        // relying solely on server-side true/false coercion.
        if (typeof v === "boolean") {
          params.set(`where[${k}]`, v ? "1" : "0");
        } else {
          params.set(`where[${k}]`, String(v));
        }
      }
    }
    if (opts?.filter) {
      const names: Record<string, string> = {
        eq: "eq",
        ne: "ne",
        lt: "lt",
        lte: "lte",
        gt: "gt",
        gte: "gte",
        in: "in",
        isNull: "is_null",
        contains: "contains",
        startsWith: "starts_with",
      };
      for (const [field, operations] of Object.entries(opts.filter)) {
        for (const [operator, value] of Object.entries(operations)) {
          if (value === undefined) continue;
          const encoded = Array.isArray(value) ? value.join(",") : String(value);
          params.set(`filter[${field}][${names[operator] ?? operator}]`, encoded);
        }
      }
    }
    const q = params.toString();
    const path = `/api/${encodeURIComponent(this.table)}${q ? `?${q}` : ""}`;
    const res = await this.client.request<{
      data: TRow[];
      meta: ListMeta;
    }>("GET", path);
    return { data: res.data, meta: res.meta };
  }

  async get(id: RecordKey): Promise<TRow> {
    const res = await this.client.request<{ data: TRow }>(
      "GET",
      recordKeyPath(this.table, id),
    );
    return res.data;
  }

  /** Insert uses the generated insert shape when the client is typed with TableInsertMap. */
  async insert(row: TInsert): Promise<TRow> {
    const res = await this.client.request<{ data: TRow }>(
      "POST",
      `/api/${encodeURIComponent(this.table)}`,
      row,
    );
    return res.data;
  }

  /** Update uses the generated update/patch shape when typed with TableUpdateMap. */
  async update(id: RecordKey, patch: TUpdate): Promise<TRow> {
    const res = await this.client.request<{ data: TRow }>(
      "PATCH",
      recordKeyPath(this.table, id),
      patch,
    );
    return res.data;
  }

  async delete(id: RecordKey): Promise<TRow> {
    const res = await this.client.request<{ data: TRow }>(
      "DELETE",
      recordKeyPath(this.table, id),
    );
    return res.data;
  }

  async history(
    id: string | number,
    options?: ResourceHistoryOptions,
  ): Promise<ResourceHistoryResult<TRow>> {
    const params = new URLSearchParams();
    if (options?.beforeSequence != null) {
      params.set("before_sequence", String(options.beforeSequence));
    }
    if (options?.limit != null) params.set("limit", String(options.limit));
    const query = params.toString();
    return this.client.request<ResourceHistoryResult<TRow>>(
      "GET",
      `/api/${encodeURIComponent(this.table)}/${encodeURIComponent(String(id))}/history${query ? `?${query}` : ""}`,
    );
  }

  async at(
    id: string | number,
    options: ResourceStateAtOptions,
  ): Promise<ResourceStateAt<TRow>> {
    const params = new URLSearchParams();
    if (options.sequence != null) params.set("sequence", String(options.sequence));
    if (options.timestamp != null) {
      const timestamp =
        options.timestamp instanceof Date
          ? Math.floor(options.timestamp.getTime() / 1000)
          : options.timestamp;
      params.set("timestamp", String(timestamp));
    }
    if (!params.size) {
      throw new LoomupError(
        "resource.at requires sequence or timestamp",
        "bad_request",
      );
    }
    const res = await this.client.request<{ data: ResourceStateAt<TRow> }>(
      "GET",
      `/api/${encodeURIComponent(this.table)}/${encodeURIComponent(String(id))}/at?${params}`,
    );
    return res.data;
  }

  async permissions(id: string | number): Promise<ResourcePermissions> {
    const res = await this.client.request<{ data: ResourcePermissions }>(
      "GET",
      `/api/${encodeURIComponent(this.table)}/${encodeURIComponent(String(id))}/permissions`,
    );
    return res.data;
  }

  subscribe(handler: SubscribeHandler, rowId?: string): () => void {
    return this.client.subscribeTable(this.table, handler, rowId);
  }

  /** Awaitable subscribe — resolves when the WebSocket is open. */
  async subscribeReady(
    handler: SubscribeHandler,
    rowId?: string,
    timeoutMs = 5000,
  ): Promise<() => void> {
    return this.client.subscribeTableReady(
      this.table,
      handler,
      rowId,
      timeoutMs,
    );
  }
}

/**
 * One domain-resource API over the compatibility CRUD/realtime transport.
 */
export class Resource<
  TRow = Record<string, unknown>,
  TCreate = Partial<TRow> & Record<string, unknown>,
  TUpdate = Partial<TRow> & Record<string, unknown>,
> {
  constructor(
    readonly name: string,
    private readonly query: TableQuery<TRow, TCreate, TUpdate>,
  ) {}

  find(options?: ResourceFindOptions): Promise<{ data: TRow[]; meta: ListMeta }> {
    return this.query.select(options);
  }

  /** List rows directly. Use `find` when pagination metadata is also needed. */
  async list(options?: ResourceFindOptions): Promise<TRow[]> {
    return (await this.query.select(options)).data;
  }

  get(id: RecordKey): Promise<TRow> {
    return this.query.get(id);
  }

  create(data: TCreate): Promise<TRow> {
    return this.query.insert(data);
  }

  update(id: RecordKey, data: TUpdate): Promise<TRow> {
    return this.query.update(id, data);
  }

  remove(id: RecordKey): Promise<TRow> {
    return this.query.delete(id);
  }

  /** Delete a row. `remove` remains as a backwards-compatible alias. */
  delete(id: RecordKey): Promise<TRow> {
    return this.query.delete(id);
  }

  history(
    id: string | number,
    options?: ResourceHistoryOptions,
  ): Promise<ResourceHistoryResult<TRow>> {
    return this.query.history(id, options);
  }

  at(
    id: string | number,
    options: ResourceStateAtOptions,
  ): Promise<ResourceStateAt<TRow>> {
    return this.query.at(id, options);
  }

  permissions(id: string | number): Promise<ResourcePermissions> {
    return this.query.permissions(id);
  }

  subscribe(handler: SubscribeHandler, rowId?: string): () => void {
    return this.query.subscribe(handler, rowId);
  }

  subscribeReady(
    handler: SubscribeHandler,
    rowId?: string,
    timeoutMs = 5000,
  ): Promise<() => void> {
    return this.query.subscribeReady(handler, rowId, timeoutMs);
  }

  /**
   * Open a race-free initial read + realtime collection. The subscription is
   * acknowledged before the snapshot is read; events received during the read
   * are buffered and reconciled before the collection is returned.
   */
  live(options?: ResourceLiveOptions): Promise<LiveResourceCollection<TRow>> {
    return LiveResourceCollection.open(this, options);
  }
}

function mergeResourceChange<TRow>(
  rows: readonly TRow[],
  event: ChangeEvent,
  primaryKey: string,
): TRow[] {
  const id = String(event.id);
  const index = rows.findIndex((row) => {
    if (typeof row !== "object" || row === null) return false;
    const value = (row as Record<string, unknown>)[primaryKey];
    return value != null && String(value) === id;
  });
  if (event.op === "DELETE") {
    return index < 0 ? [...rows] : rows.filter((_, rowIndex) => rowIndex !== index);
  }
  if (event.data == null) return [...rows];
  const next = event.data as TRow;
  if (index < 0) return [...rows, next];
  const copy = [...rows];
  copy[index] = next;
  return copy;
}

/** Mutable live collection returned by `resource.live()`. */
export class LiveResourceCollection<TRow = Record<string, unknown>> {
  private rows: TRow[] = [];
  private listMeta: ListMeta = { limit: 100, offset: 0, total: 0 };
  private listeners = new Set<(snapshot: LiveResourceSnapshot<TRow>) => void>();
  private unsubscribe?: () => void;
  private closed = false;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;

  private constructor(
    private readonly resource: Resource<TRow, any, any>,
    private readonly options: ResourceLiveOptions,
  ) {}

  static async open<TRow>(
    resource: Resource<TRow, any, any>,
    options: ResourceLiveOptions = {},
  ): Promise<LiveResourceCollection<TRow>> {
    const collection = new LiveResourceCollection(resource, options);
    const buffered: ChangeEvent[] = [];
    let initializing = true;
    const onEvent = (event: ChangeEvent) => {
      if (initializing) {
        buffered.push(event);
      } else {
        collection.applyEvent(event);
      }
    };
    try {
      collection.unsubscribe = await resource.subscribeReady(onEvent);
      const snapshot = await resource.find(options);
      collection.rows = snapshot.data;
      collection.listMeta = snapshot.meta;
      initializing = false;
      if (buffered.length > 0) {
        if ((options.strategy ?? "refetch") === "merge") {
          for (const event of buffered) collection.applyEvent(event, false);
          collection.notify();
        } else {
          await collection.refresh();
        }
      }
      return collection;
    } catch (error) {
      collection.unsubscribe?.();
      collection.closed = true;
      throw error;
    }
  }

  get data(): readonly TRow[] {
    return this.rows;
  }

  get meta(): ListMeta {
    return this.listMeta;
  }

  snapshot(): LiveResourceSnapshot<TRow> {
    return { data: this.rows, meta: this.listMeta };
  }

  onChange(listener: (snapshot: LiveResourceSnapshot<TRow>) => void): () => void {
    if (this.closed) throw new LoomupError("live resource is closed", "closed");
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<void> {
    if (this.closed) return;
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        const snapshot = await this.resource.find(this.options);
        if (this.closed) return;
        this.rows = snapshot.data;
        this.listMeta = snapshot.meta;
        this.notify();
      } while (this.refreshAgain && !this.closed);
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.listeners.clear();
  }

  private applyEvent(event: ChangeEvent, notify = true): void {
    if (this.closed) return;
    if ((this.options.strategy ?? "refetch") === "refetch") {
      void this.refresh();
      return;
    }
    this.rows = mergeResourceChange(
      this.rows,
      event,
      this.options.primaryKey ?? "id",
    );
    this.listMeta = { ...this.listMeta, total: this.rows.length };
    if (notify) this.notify();
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

type ProjectResources<
  TMap,
  TInsertMap,
  TUpdateMap,
> = {
  [K in keyof TMap & string]: Resource<
    TMap[K],
    K extends keyof TInsertMap
      ? NonNullable<TInsertMap[K]>
      : Partial<TMap[K]> & Record<string, unknown>,
    K extends keyof TUpdateMap
      ? NonNullable<TUpdateMap[K]>
      : Partial<TMap[K]> & Record<string, unknown>
  >;
};

export type LoomupProject<
  TMap = DefaultTableMap,
  TInsertMap = DefaultInsertMap,
  TUpdateMap = DefaultUpdateMap,
> = LoomupClient<TMap, TInsertMap, TUpdateMap> &
  ProjectResources<TMap, TInsertMap, TUpdateMap>;

/**
 * Add generated property access (`client.todos`) to an existing client.
 * Framework adapters use this to preserve their cookie/session behavior while
 * exposing the same project DX as {@link createProject}.
 */
export function projectFromClient<
  TMap = DefaultTableMap,
  TInsertMap = DefaultInsertMap,
  TUpdateMap = DefaultUpdateMap,
>(
  client: LoomupClient<TMap, TInsertMap, TUpdateMap>,
): LoomupProject<TMap, TInsertMap, TUpdateMap> {
  const resources = new Map<string, Resource<any, any, any>>();
  return new Proxy(client, {
    get(target, property) {
      if (typeof property === "string" && !(property in target)) {
        let resource = resources.get(property);
        if (!resource) {
          resource = target.resource(
            property as keyof TMap & string,
          ) as unknown as Resource<any, any, any>;
          resources.set(property, resource);
        }
        return resource;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as LoomupProject<TMap, TInsertMap, TUpdateMap>;
}

/**
 * Create a project client with generated property access (`project.todos`).
 * Names that collide with client APIs remain available via `project.resource(name)`.
 */
export function createProject<
  TMap = DefaultTableMap,
  TInsertMap = DefaultInsertMap,
  TUpdateMap = DefaultUpdateMap,
>(
  options: CreateClientOptions,
): LoomupProject<TMap, TInsertMap, TUpdateMap> {
  return projectFromClient(createClient<TMap, TInsertMap, TUpdateMap>(options));
}

/**
 * Encode each path segment for `/storage/v1/{bucket}/object/{*path}`.
 * Keeps `/` as separators; encodes spaces and reserved characters.
 */
export function encodeObjectPath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

export {
  browserSyncStorage,
  indexedDbSyncStorage,
  MemorySyncStorage,
  SyncStore,
  type SyncConflict,
  type SyncStorage,
  type SyncStoreOptions,
  type SyncStoreStatus,
} from "./sync.js";

export type BuiltInResourcePermissions = {
  find: boolean;
  get: boolean;
  create: boolean;
  update: boolean;
  remove: boolean;
  subscribe: boolean;
  history: boolean;
};

/** Specialized backing store, common resource verbs for the current identity. */
export class UsersResource {
  readonly name = "users";
  constructor(private readonly client: LoomupClient) {}

  async find(): Promise<{ data: User[]; meta: ListMeta }> {
    const user = await this.client.me();
    return { data: [user], meta: { limit: 1, offset: 0, total: 1 } };
  }

  async get(id: string = "me"): Promise<User> {
    const user = await this.client.me();
    if (id !== "me" && id !== user.id) {
      throw new LoomupError("user is outside the current identity scope", "not_found", 404);
    }
    return user;
  }

  async create(credentials: { email: string; password: string }): Promise<User> {
    const session = await this.client.signUp(credentials);
    return session.user ?? this.client.me();
  }

  /**
   * Server-only migration helper. Requires a service key with
   * `project:backend`; imported identities must complete password reset.
   */
  async importForPasswordReset(identities: readonly ImportedIdentity[]): Promise<User[]> {
    const response = await this.client.request<{ data: User[] }>(
      "POST",
      "/auth/users/import",
      { users: identities },
    );
    return response.data;
  }

  /** Server-only invitation helper. Requires a `project:backend` service key. */
  async invite(input: InviteUserInput): Promise<AuthActionResult> {
    const response = await this.client.request<{ data: AuthActionResult }>(
      "POST",
      "/auth/users/invite",
      input,
    );
    return response.data;
  }

  permissions(): BuiltInResourcePermissions {
    return {
      find: true,
      get: true,
      create: true,
      update: false,
      remove: false,
      subscribe: false,
      history: false,
    };
  }
}

export type FileCreateInput = {
  path: string;
  body: StorageUploadBody;
  contentType?: string;
};

/** Bucket-backed files with the same core find/get/create/update/remove verbs. */
export class FileResource {
  readonly name = "files";
  private readonly bucketApi: StorageBucket;

  constructor(
    client: LoomupClient,
    readonly bucket: string,
  ) {
    this.bucketApi = new StorageBucket(client, bucket);
  }

  find(options?: StorageListOptions): Promise<StorageListResult> {
    return this.bucketApi.list(options);
  }

  get(path: string): Promise<Blob> {
    return this.bucketApi.download(path);
  }

  create(input: FileCreateInput): Promise<StorageObject> {
    return this.bucketApi.upload(input.path, input.body, {
      contentType: input.contentType,
      upsert: false,
    });
  }

  update(path: string, input: Omit<FileCreateInput, "path">): Promise<StorageObject> {
    return this.bucketApi.upload(path, input.body, {
      contentType: input.contentType,
      upsert: true,
    });
  }

  async remove(path: string): Promise<StorageObject> {
    const [removed] = await this.bucketApi.remove(path);
    return removed!;
  }

  permissions(): BuiltInResourcePermissions {
    return {
      find: true,
      get: true,
      create: true,
      update: true,
      remove: true,
      subscribe: false,
      history: false,
    };
  }
}

/** Bucket-scoped object storage API (Supabase-style `storage.from(bucket)`). */
export class StorageBucket {
  constructor(
    private readonly client: LoomupClient,
    readonly bucket: string,
  ) {}

  private objectUrl(path: string): string {
    return `/storage/v1/${encodeURIComponent(this.bucket)}/object/${encodeObjectPath(path)}`;
  }

  /** Upload raw bytes / Blob / File / Buffer / string. Returns object metadata. */
  async upload(
    path: string,
    body: StorageUploadBody,
    options?: StorageUploadOptions,
  ): Promise<StorageObject> {
    const normalized = normalizeStorageUpload(body, options);
    const headers: Record<string, string> = {};
    if (normalized.contentType) {
      headers["Content-Type"] = normalized.contentType;
    }
    if (options?.upsert) {
      headers["x-loomup-upsert"] = "true";
    }
    const json = (await this.client.requestStorage("POST", this.objectUrl(path), {
      body: normalized.body,
      headers,
    })) as { data: StorageObject };
    return json.data;
  }

  /**
   * Convenience upload for browser/undici `File` (or any Blob).
   * Uses `file.name` only for content-type inference when not provided.
   */
  async uploadFile(
    path: string,
    file: Blob,
    options?: StorageUploadOptions,
  ): Promise<StorageObject> {
    return this.upload(path, file, options);
  }

  /** Download object bytes as a Blob. */
  async download(path: string): Promise<Blob> {
    const res = await this.downloadResponse(path);
    return res.blob();
  }

  /** Download object bytes as ArrayBuffer. */
  async downloadArrayBuffer(path: string): Promise<ArrayBuffer> {
    const res = await this.downloadResponse(path);
    return res.arrayBuffer();
  }

  /**
   * Raw download Response (status 200). Useful for streaming to a framework
   * Response (Next/Nuxt/Astro) without buffering as Blob first.
   */
  async downloadResponse(path: string): Promise<Response> {
    return (await this.client.requestStorage("GET", this.objectUrl(path), {
      raw: true,
    })) as Response;
  }

  /** List objects (optionally under `prefix`). */
  async list(options?: StorageListOptions): Promise<StorageListResult> {
    const q = new URLSearchParams();
    if (options?.prefix) q.set("prefix", options.prefix);
    if (options?.limit != null) q.set("limit", String(options.limit));
    if (options?.offset != null) q.set("offset", String(options.offset));
    const qs = q.toString();
    const path = `/storage/v1/${encodeURIComponent(this.bucket)}${qs ? `?${qs}` : ""}`;
    const json = (await this.client.requestStorage("GET", path)) as StorageListResult;
    return {
      data: json.data ?? [],
      meta: json.meta ?? { limit: options?.limit ?? 100, offset: options?.offset ?? 0, total: 0 },
    };
  }

  /** Delete one or more objects by path. */
  async remove(paths: string | string[]): Promise<StorageObject[]> {
    const list = Array.isArray(paths) ? paths : [paths];
    const out: StorageObject[] = [];
    for (const p of list) {
      const json = (await this.client.requestStorage(
        "DELETE",
        this.objectUrl(p),
      )) as { data: StorageObject };
      out.push(json.data);
    }
    return out;
  }

  /** Create an authenticated, short-lived browser download URL. */
  async createSignedUrl(path: string, expiresIn = 900): Promise<SignedStorageUrl> {
    const endpoint = `/storage/v1/${encodeURIComponent(this.bucket)}/sign/${encodeObjectPath(path)}`;
    const response = (await this.client.requestStorage("POST", endpoint, {
      body: JSON.stringify({ expires_in: expiresIn }),
      headers: { "Content-Type": "application/json" },
    })) as { data: SignedStorageUrl };
    return {
      ...response.data,
      url: joinUrl(this.client.url, response.data.url),
    };
  }

  /**
   * Absolute direct download URL for a public object. For private objects use
   * `createSignedUrl`.
   */
  getPublicUrl(path: string): string {
    return joinUrl(this.client.url, this.objectUrl(path));
  }
}
