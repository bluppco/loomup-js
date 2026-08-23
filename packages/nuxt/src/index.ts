/**
 * @loomup/nuxt public re-exports (non-module consumers / tests).
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

export type {
  CookieSerializeOptions,
  CookieRecord,
  CookieMethods,
  SessionCookieOptions,
  ModuleOptions,
} from "./types.js";

export {
  createServerClient,
  cookieMethodsFromEvent,
  resolveLoomupUrl,
  type CreateServerClientOptions,
  type H3EventLike,
  type CookieAdapter,
} from "./runtime/server/client.js";

export { createClientFromCookies } from "./runtime/server/storage.js";

export {
  fileAndPathFromFormData,
  uploadFromFormData,
  storageDownloadResponse,
  type UploadFormDataOptions,
} from "./runtime/server/objectStorage.js";

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

export {
  updateSession,
  type UpdateSessionOptions,
} from "./runtime/server/session.js";

export {
  createAuthHandlers,
  type AuthHandlersOptions,
  type AuthHandlerResult,
  type AuthBody,
} from "./runtime/server/authHandlers.js";

export { default as default } from "./module.js";
