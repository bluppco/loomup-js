/**
 * @loomup/react — React hooks and provider for Loomup Realtime.
 */

export { LoomupProvider, useLoomup } from "./context.js";
export type {
  LoomupProviderProps,
  PersistOptions,
  ResolvedPersistOptions,
  TokenStorage,
} from "./context.js";

export {
  localStorageAdapter,
  loadTokens,
  saveTokens,
  clearTokens,
} from "./storage.js";

export { useAuth } from "./useAuth.js";
export type { AuthSession, UseAuthResult } from "./useAuth.js";

export { useSelect, useRow } from "./useSelect.js";
export type {
  UseSelectOptions,
  UseSelectResult,
  UseRowResult,
} from "./useSelect.js";

export { useMutation } from "./useMutation.js";
export type { UseMutationResult } from "./useMutation.js";

export { useSubscribe } from "./useSubscribe.js";
export type { UseSubscribeOptions, UseSubscribeResult } from "./useSubscribe.js";

export { useLiveQuery } from "./useLiveQuery.js";
export type {
  UseLiveQueryOptions,
  UseLiveQueryResult,
} from "./useLiveQuery.js";

export {
  SyncStoreProvider,
  useSyncResource,
  useSyncStore,
} from "./useSyncResource.js";
export type { UseSyncResourceResult } from "./useSyncResource.js";

export {
  applyChangeToRows,
  rowIdFrom,
  stableSerialize,
  errorMessage,
} from "./utils.js";
export type { SelectOptions, LiveStrategy } from "./utils.js";

// Re-export commonly used client types for convenience.
export type {
  AuthTokens,
  ChangeEvent,
  ControlEvent,
  CreateClientOptions,
  ListMeta,
  LoomupClient,
  SyncConflict,
  SyncStorage,
  SyncStoreOptions,
  SyncStoreStatus,
  User,
} from "@loomup/client";
export {
  browserSyncStorage,
  createClient,
  LoomupError,
  MemorySyncStorage,
  SyncStore,
} from "@loomup/client";
