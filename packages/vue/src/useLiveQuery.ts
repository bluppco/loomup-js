import {
  onUnmounted,
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type Ref,
} from "vue";
import type { ChangeEvent, ListMeta } from "@loomup/client";
import { useLoomup } from "./inject.js";
import {
  applyChangeToRows,
  errorMessage,
  stableSerialize,
  type LiveStrategy,
  type SelectOptions,
} from "./utils.js";

export type UseLiveQueryOptions = SelectOptions & {
  /** When false, skip fetch + subscribe. Accepts ref/getter. Default true. */
  enabled?: MaybeRefOrGetter<boolean>;
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
  data: Ref<T[] | null>;
  meta: Ref<ListMeta | null>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  ready: Ref<boolean>;
  refetch: () => Promise<void>;
};

/**
 * Initial select + realtime subscription that keeps local rows in sync.
 */
export function useLiveQuery<
  T extends Record<string, unknown> = Record<string, unknown>,
>(table: string, options?: UseLiveQueryOptions): UseLiveQueryResult<T> {
  const client = useLoomup();
  const data = ref<T[] | null>(null) as Ref<T[] | null>;
  const meta = ref<ListMeta | null>(null);
  const loading = ref(options?.enabled !== false);
  const error = ref<string | null>(null);
  const ready = ref(false);
  let gen = 0;

  async function refetch() {
    const enabled = toValue(options?.enabled) !== false;
    if (!enabled) {
      loading.value = false;
      return;
    }
    const id = ++gen;
    loading.value = true;
    error.value = null;
    try {
      const selectOpts: SelectOptions = {
        where: options?.where,
        sort: options?.sort,
        limit: options?.limit,
        offset: options?.offset,
      };
      const res = await client.from(table).select(selectOpts);
      if (id !== gen) return;
      data.value = res.data as T[];
      meta.value = res.meta;
    } catch (err) {
      if (id !== gen) return;
      error.value = errorMessage(err);
    } finally {
      if (id === gen) loading.value = false;
    }
  }

  // Initial + option-driven fetch.
  watch(
    () =>
      [
        table,
        toValue(options?.enabled) !== false,
        stableSerialize({
          where: options?.where,
          sort: options?.sort,
          limit: options?.limit,
          offset: options?.offset,
        }),
      ] as const,
    () => {
      void refetch();
    },
    { immediate: true },
  );

  // Realtime subscription.
  let unsub: (() => void) | undefined;
  let cancelled = false;

  watch(
    () =>
      [
        table,
        toValue(options?.enabled) !== false,
        options?.strategy ?? "refetch",
        options?.primaryKey ?? "id",
        options?.waitForAck !== false,
      ] as const,
    async ([tbl, enabled, strategy, primaryKey, waitForAck], _prev, onCleanup) => {
      cancelled = true;
      unsub?.();
      unsub = undefined;
      cancelled = false;

      if (!enabled) {
        ready.value = false;
        return;
      }

      const onEvent = (ev: ChangeEvent) => {
        if (strategy === "refetch") {
          void refetch();
          return;
        }
        // merge strategy
        const base = data.value ?? [];
        data.value = applyChangeToRows(base, ev, primaryKey) as T[];
      };

      ready.value = false;
      try {
        if (waitForAck) {
          unsub = await client.from(tbl).subscribeReady(onEvent);
        } else {
          unsub = client.from(tbl).subscribe(onEvent);
        }
        if (cancelled) {
          unsub();
          unsub = undefined;
          return;
        }
        ready.value = true;
      } catch (err) {
        if (!cancelled) {
          error.value = errorMessage(err);
          ready.value = false;
        }
      }

      onCleanup(() => {
        cancelled = true;
        unsub?.();
        unsub = undefined;
        ready.value = false;
      });
    },
    { immediate: true },
  );

  onUnmounted(() => {
    cancelled = true;
    unsub?.();
    unsub = undefined;
  });

  return { data, meta, loading, error, ready, refetch };
}
