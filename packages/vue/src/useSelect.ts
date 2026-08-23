import {
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type Ref,
} from "vue";
import type { ListMeta } from "@loomup/client";
import { useLoomup } from "./inject.js";
import { errorMessage, stableSerialize, type SelectOptions } from "./utils.js";

export type UseSelectOptions = SelectOptions & {
  /** When false, skip fetching. Default true. Accepts ref/getter. */
  enabled?: MaybeRefOrGetter<boolean>;
};

export type UseSelectResult<T> = {
  data: Ref<T[] | null>;
  meta: Ref<ListMeta | null>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  refetch: () => Promise<void>;
};

/**
 * Fetch a table list via REST. Re-runs when table or options change.
 */
export function useSelect<T = Record<string, unknown>>(
  table: string,
  options?: UseSelectOptions,
): UseSelectResult<T> {
  const client = useLoomup();
  const data = ref<T[] | null>(null) as Ref<T[] | null>;
  const meta = ref<ListMeta | null>(null);
  const loading = ref(options?.enabled !== false);
  const error = ref<string | null>(null);
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
      data.value = null;
      meta.value = null;
    } finally {
      if (id === gen) loading.value = false;
    }
  }

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

  return { data, meta, loading, error, refetch };
}

export type UseRowResult<T> = {
  data: Ref<T | null>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  refetch: () => Promise<void>;
};

/**
 * Fetch a single row by id via REST.
 */
export function useRow<T = Record<string, unknown>>(
  table: string,
  id: MaybeRefOrGetter<string | number | null | undefined>,
  options?: { enabled?: MaybeRefOrGetter<boolean> },
): UseRowResult<T> {
  const client = useLoomup();
  const data = ref<T | null>(null) as Ref<T | null>;
  const loading = ref(true);
  const error = ref<string | null>(null);
  let gen = 0;

  async function refetch() {
    const rowId = toValue(id);
    const enabled =
      toValue(options?.enabled) !== false &&
      rowId !== null &&
      rowId !== undefined &&
      rowId !== "";
    if (!enabled) {
      data.value = null;
      loading.value = false;
      return;
    }
    const reqId = ++gen;
    loading.value = true;
    error.value = null;
    try {
      const row = await client.from(table).get(rowId!);
      if (reqId !== gen) return;
      data.value = row as T;
    } catch (err) {
      if (reqId !== gen) return;
      error.value = errorMessage(err);
      data.value = null;
    } finally {
      if (reqId === gen) loading.value = false;
    }
  }

  watch(
    () => {
      const rowId = toValue(id);
      return [
        table,
        rowId,
        toValue(options?.enabled) !== false &&
          rowId !== null &&
          rowId !== undefined &&
          rowId !== "",
      ] as const;
    },
    () => {
      void refetch();
    },
    { immediate: true },
  );

  return { data, loading, error, refetch };
}
