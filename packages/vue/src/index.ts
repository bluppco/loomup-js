/**
 * @loomup/vue — Vue 3 composables and plugin for Loomup Realtime.
 */

export { LoomupPlugin, provideLoomup } from "./plugin.js";
export type { LoomupPluginOptions, PersistOptions } from "./plugin.js";

export { useLoomup, useLoomupContext, LoomupKey } from "./inject.js";
export type { LoomupContextValue } from "./inject.js";

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
  User,
} from "@loomup/client";
export { createClient, LoomupError } from "@loomup/client";
