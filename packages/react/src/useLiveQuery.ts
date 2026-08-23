import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, ListMeta } from "@loomup/client";
import { useLoomup } from "./context.js";
import {
  applyChangeToRows,
  errorMessage,
  stableSerialize,
  type LiveStrategy,
  type SelectOptions,
} from "./utils.js";

export type UseLiveQueryOptions = SelectOptions & {
  enabled?: boolean;
  /**
   * How to apply realtime events:
   * - `refetch` (default): re-run select on any change (correct with where/rules).
   * - `merge`: apply INSERT/UPDATE/DELETE/RESYNC to local array (best for unfiltered lists).
   */
  strategy?: LiveStrategy;
  /** Primary key column for merge strategy. Default "id". */
  primaryKey?: string;
  /** Wait for subscribe ack before marking ready. Default true. */
  waitForAck?: boolean;
};

export type UseLiveQueryResult<T> = {
  data: T[] | null;
  meta: ListMeta | null;
  loading: boolean;
  error: string | null;
  ready: boolean;
  refetch: () => Promise<void>;
};

/**
 * Initial select + realtime subscription that keeps local rows in sync.
 */
export function useLiveQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  table: string,
  options?: UseLiveQueryOptions,
): UseLiveQueryResult<T> {
  const client = useLoomup();
  const enabled = options?.enabled !== false;
  const strategy: LiveStrategy = options?.strategy ?? "refetch";
  const primaryKey = options?.primaryKey ?? "id";
  const waitForAck = options?.waitForAck !== false;

  const optsKey = stableSerialize({
    where: options?.where,
    sort: options?.sort,
    limit: options?.limit,
    offset: options?.offset,
  });

  const [data, setData] = useState<T[] | null>(null);
  const [meta, setMeta] = useState<ListMeta | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const gen = useRef(0);

  const refetch = useCallback(async () => {
    const id = ++gen.current;
    setLoading(true);
    setError(null);
    try {
      const selectOpts: SelectOptions = JSON.parse(optsKey) as SelectOptions;
      const res = await client.from(table).select(selectOpts);
      if (id !== gen.current) return;
      setData(res.data as T[]);
      setMeta(res.meta);
    } catch (err) {
      if (id !== gen.current) return;
      setError(errorMessage(err));
    } finally {
      if (id === gen.current) setLoading(false);
    }
  }, [client, table, optsKey]);

  // Initial + option-driven fetch.
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void refetch();
  }, [enabled, refetch]);

  // Realtime subscription.
  useEffect(() => {
    if (!enabled) {
      setReady(false);
      return;
    }

    let unsub: (() => void) | undefined;
    let cancelled = false;

    const onEvent = (ev: ChangeEvent) => {
      if (strategy === "refetch") {
        void refetch();
        return;
      }
      // merge strategy
      setData((prev) => {
        const base = prev ?? [];
        return applyChangeToRows(base, ev, primaryKey) as T[];
      });
    };

    (async () => {
      setReady(false);
      try {
        if (waitForAck) {
          unsub = await client.from(table).subscribeReady(onEvent);
        } else {
          unsub = client.from(table).subscribe(onEvent);
        }
        if (cancelled) {
          unsub();
          return;
        }
        setReady(true);
      } catch (err) {
        if (!cancelled) {
          setError(errorMessage(err));
          setReady(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      unsub?.();
      setReady(false);
    };
  }, [client, table, enabled, strategy, primaryKey, waitForAck, refetch]);

  return { data, meta, loading, error, ready, refetch };
}
