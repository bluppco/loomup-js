import type { ListFilters } from "./types.js";

/**
 * Recursively sort object keys so `{ b: 1, a: 2 }` and `{ a: 2, b: 1 }`
 * produce the same JSON string (and thus the same query key).
 */
export function stableSerialize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortKeys(obj[key]);
  }
  return out;
}

/**
 * Stable representation of list filters for query keys.
 * Omitting filters (or empty object) yields the same key segment: `undefined`
 * is not placed in the key when there are no filters.
 */
export function stableFilters(
  filters?: ListFilters,
): string | undefined {
  if (filters == null) return undefined;
  const hasWhere =
    filters.where != null && Object.keys(filters.where).length > 0;
  const hasSort = filters.sort != null && filters.sort !== "";
  const hasLimit = filters.limit != null;
  const hasOffset = filters.offset != null;
  if (!hasWhere && !hasSort && !hasLimit && !hasOffset) {
    return undefined;
  }
  const normalized: ListFilters = {};
  if (hasWhere) normalized.where = filters.where;
  if (hasSort) normalized.sort = filters.sort;
  if (hasLimit) normalized.limit = filters.limit;
  if (hasOffset) normalized.offset = filters.offset;
  return stableSerialize(normalized);
}

/** Hierarchical query keys for Loomup + TanStack Query. */
export const loomupKeys = {
  all: ["loomup"] as const,

  table: (table: string) => ["loomup", table] as const,

  lists: (table: string) => ["loomup", table, "list"] as const,

  list: (table: string, filters?: ListFilters) => {
    const stable = stableFilters(filters);
    if (stable === undefined) {
      return ["loomup", table, "list"] as const;
    }
    return ["loomup", table, "list", stable] as const;
  },

  details: (table: string) => ["loomup", table, "detail"] as const,

  detail: (table: string, id: string | number) =>
    ["loomup", table, "detail", String(id)] as const,

  me: () => ["loomup", "auth", "me"] as const,
};

/** Invalidate all list + detail queries for a table. */
export function invalidateTable(
  queryClient: { invalidateQueries: (opts: { queryKey: readonly unknown[] }) => unknown },
  table: string,
): void {
  void queryClient.invalidateQueries({ queryKey: loomupKeys.table(table) });
}

/** Write a single row into the detail cache. */
export function setDetail<T>(
  queryClient: {
    setQueryData: (key: readonly unknown[], data: T) => unknown;
  },
  table: string,
  id: string | number,
  row: T,
): void {
  queryClient.setQueryData(loomupKeys.detail(table, id), row);
}

/** Remove a detail query from the cache. */
export function removeDetail(
  queryClient: {
    removeQueries: (opts: { queryKey: readonly unknown[] }) => unknown;
  },
  table: string,
  id: string | number,
): void {
  queryClient.removeQueries({ queryKey: loomupKeys.detail(table, id) });
}
