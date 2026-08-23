import type { QueryClient } from "@tanstack/query-core";
import type { ChangeEvent, LoomupClient } from "@loomup/client";
import { loomupKeys, removeDetail, setDetail } from "./keys.js";

export type SyncRealtimeOptions = {
  /** Row-scoped subscription (same as client `subscribe(handler, rowId)`). */
  rowId?: string;
};

/**
 * Subscribe to table (or row) changes and keep TanStack Query cache in sync:
 * - INSERT / UPDATE / RESYNC with `data` → set detail cache + invalidate lists
 * - DELETE → remove detail + invalidate lists
 *
 * Returns an unsubscribe function suitable for `useEffect` cleanup.
 */
export function syncRealtime(
  client: LoomupClient,
  table: string,
  queryClient: QueryClient,
  options?: SyncRealtimeOptions,
): () => void {
  return client.from(table).subscribe((event: ChangeEvent) => {
    applyChangeToCache(queryClient, table, event);
  }, options?.rowId);
}

/**
 * Apply a single change event to the QueryClient cache (exported for tests).
 */
export function applyChangeToCache(
  queryClient: QueryClient,
  table: string,
  event: ChangeEvent,
): void {
  const id = event.id;
  const op = String(event.op || "").toUpperCase();

  if (op === "DELETE") {
    if (id) removeDetail(queryClient, table, id);
    void queryClient.invalidateQueries({
      queryKey: loomupKeys.lists(table),
    });
    return;
  }

  // INSERT, UPDATE, RESYNC, or any other op that carries row data
  if (event.data && id) {
    setDetail(queryClient, table, id, event.data);
  }
  void queryClient.invalidateQueries({
    queryKey: loomupKeys.lists(table),
  });
}
