import type { QueryClient } from "@tanstack/query-core";

/** Filters that participate in list query keys (must be stable-serialized). */
export type ListFilters = {
  where?: Record<string, string | number | boolean>;
  sort?: string;
  limit?: number;
  offset?: number;
};

/** Shared option bag for mutations that attach default cache side-effects. */
export type MutationCacheOptions = {
  /**
   * When provided, default `onSuccess` handlers invalidate / update the cache.
   * Omit for pure `mutationFn`-only options (compose your own `onSuccess`).
   */
  queryClient?: QueryClient;
};

/** Variables for table update mutations. */
export type UpdateVariables<TUpdate> = {
  id: string | number;
  patch: TUpdate;
};
