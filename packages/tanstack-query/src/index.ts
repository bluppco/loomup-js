/**
 * @loomup/tanstack-query — TanStack Query helpers for @loomup/client.
 */

export { createLoomupQuery } from "./options.js";
export type { LoomupQueryHelpers } from "./options.js";

export {
  loomupKeys,
  stableSerialize,
  stableFilters,
  invalidateTable,
  setDetail,
  removeDetail,
} from "./keys.js";

export { syncRealtime, applyChangeToCache } from "./realtime.js";
export type { SyncRealtimeOptions } from "./realtime.js";

export type {
  ListFilters,
  MutationCacheOptions,
  UpdateVariables,
} from "./types.js";
