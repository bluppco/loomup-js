/**
 * @loomup/react-native — React Native helpers for Loomup Realtime.
 */

export { createNativeClient } from "./createNativeClient.js";
export type { CreateNativeClientOptions } from "./createNativeClient.js";
export { signInWithOAuth } from "./oauth.js";
export type { NativeOAuthSignInOptions, OAuthSessionLauncher } from "./oauth.js";

export { LoomupNativeProvider } from "./provider.js";
export type {
  LoomupNativeProviderProps,
  NativePersistOptions,
} from "./provider.js";

export { asyncStorageAdapter } from "./storage.js";
export type { AsyncStorageLike } from "./storage.js";
export { sqliteSyncStorage } from "./sync.js";
export type { SQLiteSyncDatabase } from "./sync.js";

// Re-export React hooks and types for a single import path.
export {
  LoomupProvider,
  useLoomup,
  useAuth,
  useSelect,
  useRow,
  useMutation,
  useSubscribe,
  useLiveQuery,
  SyncStoreProvider,
  useSyncResource,
  useSyncStore,
  applyChangeToRows,
  rowIdFrom,
  stableSerialize,
  errorMessage,
  localStorageAdapter,
  loadTokens,
  saveTokens,
  clearTokens,
  browserSyncStorage,
  createClient,
  LoomupError,
  MemorySyncStorage,
  SyncStore,
} from "@loomup/react";

export type {
  LoomupProviderProps,
  PersistOptions,
  ResolvedPersistOptions,
  TokenStorage,
  AuthSession,
  UseAuthResult,
  UseSelectOptions,
  UseSelectResult,
  UseRowResult,
  UseMutationResult,
  UseSubscribeOptions,
  UseSubscribeResult,
  UseLiveQueryOptions,
  UseLiveQueryResult,
  UseSyncResourceResult,
  SelectOptions,
  LiveStrategy,
  AuthTokens,
  ChangeEvent,
  ControlEvent,
  CreateClientOptions,
  ListMeta,
  LoomupClient,
  SyncConflict,
  SyncStoreOptions,
  SyncStoreStatus,
  User,
} from "@loomup/react";
