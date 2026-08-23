/**
 * @loomup/next — Next.js session helpers for Loomup.
 *
 * Sessions use Next-owned HttpOnly cookies + Bearer auth to Loomup
 * (not Loomup server cookie_mode).
 */

export {
  DEFAULT_ACCESS_COOKIE,
  DEFAULT_REFRESH_COOKIE,
  DEFAULT_ACCESS_MAX_AGE,
  DEFAULT_REFRESH_MAX_AGE,
  resolveCookieNames,
  sessionCookiesFromTokens,
  clearSessionCookies,
  readTokensFromCookies,
  serializeCookie,
  jwtExpiresAt,
  accessNeedsRefresh,
} from "./cookies.js";

export { createClientFromCookies } from "./storage.js";

export {
  createServerClient,
  type CreateServerClientOptions,
  type NextCookiesStore,
} from "./createServerClient.js";

export {
  createPagesServerClient,
  pagesCookieMethods,
  type CreatePagesServerClientOptions,
  type PagesContext,
  type PagesRequest,
  type PagesResponse,
} from "./createPagesServerClient.js";

export {
  updateSession,
  createMiddlewareClient,
  type UpdateSessionOptions,
  type MiddlewareRequest,
  type MiddlewareResponse,
} from "./createMiddlewareClient.js";

export {
  createBrowserClient,
  type CreateBrowserClientOptions,
} from "./createBrowserClient.js";

export {
  createAuthRouteHandlers,
  type AuthRouteHandlersOptions,
} from "./createAuthRouteHandlers.js";

export {
  LoomupProvider,
  useLoomup,
  type LoomupProviderProps,
  type LoomupContextValue,
} from "./provider.js";

export type {
  CookieMethods,
  CookieRecord,
  CookieSerializeOptions,
  SessionCookieOptions,
  LoomupNextOptions,
} from "./types.js";

// Object storage (server Route Handlers / Server Actions) — full client API + helpers.
export {
  fileAndPathFromFormData,
  uploadFromFormData,
  storageDownloadResponse,
  type UploadFormDataOptions,
} from "./objectStorage.js";

export type {
  StorageObject,
  StorageBucketInfo,
  StorageUploadOptions,
  StorageListOptions,
  StorageListResult,
  StorageUploadBody,
} from "@loomup/client";
export {
  StorageBucket,
  encodeObjectPath,
  normalizeStorageUpload,
  createClient,
  LoomupError,
} from "@loomup/client";
