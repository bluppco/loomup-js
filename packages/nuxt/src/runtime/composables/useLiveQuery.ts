/**
 * Initial select + realtime subscription (Vue port of @loomup/react useLiveQuery).
 */

import {
  ref,
  watch,
  onMounted,
  onBeforeUnmount,
  type Ref,
} from "vue";
import type { ChangeEvent, ListMeta } from "@loomup/client";
import { useLoomup } from "./useLoomup.js";
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
   * - `refetch` (default): re-run select on any change.
   * - `merge`: apply INSERT/UPDATE/DELETE/RESYNC to local array.
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

export function useLiveQuery<
  T extends Record<string, unknown> = Record<string, unknown>,
>(table: string, options?: UseLiveQueryOptions): UseLiveQueryResult<T> {
  const client = useLoomup();
  const enabled = options?.enabled !== false;
  const strategy: LiveStrategy = options?.strategy ?? "refetch";
  const primaryKey = options?.primaryKey ?? "id";
  const waitForAck = options?.waitForAck !== false;

  const data = ref<T[] | null>(null) as Ref<T[] | null>;
  const meta = ref<ListMeta | null>(null);
  const loading = ref(enabled);
  const error = ref<string | null>(null);
  const ready = ref(false);

  let gen = 0;
  let unsub: (() => void) | undefined;

  const optsKey = () =>
    stableSerialize({
      where: options?.where,
      sort: options?.sort,
      limit: options?.limit,
      offset: options?.offset,
    });

  async function refetch() {
    const id = ++gen;
    loading.value = true;
    error.value = null;
    try {
      const selectOpts = JSON.parse(optsKey()) as SelectOptions;
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

  function teardown() {
    unsub?.();
    unsub = undefined;
    ready.value = false;
  }

  async function setupSubscription() {
    teardown();
    if (!enabled) {
      loading.value = false;
      return;
    }

    let cancelled = false;
    const onEvent = (ev: ChangeEvent) => {
      if (strategy === "refetch") {
        void refetch();
        return;
      }
      data.value = applyChangeToRows(
        (data.value ?? []) as T[],
        ev,
        primaryKey,
      ) as T[];
    };

    ready.value = false;
    try {
      if (waitForAck) {
        unsub = await client.from(table).subscribeReady(onEvent);
      } else {
        unsub = client.from(table).subscribe(onEvent);
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

    return () => {
      cancelled = true;
    };
  }

  onMounted(() => {
    if (enabled) {
      void refetch();
      void setupSubscription();
    }
  });

  onBeforeUnmount(() => {
    gen++;
    teardown();
  });

  watch(
    () => [table, optsKey(), enabled, strategy, primaryKey, waitForAck] as const,
    () => {
      if (!enabled) {
        teardown();
        loading.value = false;
        return;
      }
      void refetch();
      void setupSubscription();
    },
  );

  return { data, meta, loading, error, ready, refetch };
}
