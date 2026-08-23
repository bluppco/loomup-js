import { useCallback, useEffect, useRef, useState } from "react";
import type { ListMeta } from "@loomup/client";
import { useLoomup } from "./context.js";
import { errorMessage, stableSerialize, type SelectOptions } from "./utils.js";

export type UseSelectOptions = SelectOptions & {
  /** When false, skip fetching. Default true. */
  enabled?: boolean;
};

export type UseSelectResult<T> = {
  data: T[] | null;
  meta: ListMeta | null;
  loading: boolean;
  error: string | null;
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
  const enabled = options?.enabled !== false;
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
      setData(null);
      setMeta(null);
    } finally {
      if (id === gen.current) setLoading(false);
    }
  }, [client, table, optsKey]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void refetch();
  }, [enabled, refetch]);

  return { data, meta, loading, error, refetch };
}

export type UseRowResult<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
};

/**
 * Fetch a single row by id via REST.
 */
export function useRow<T = Record<string, unknown>>(
  table: string,
  id: string | number | null | undefined,
  options?: { enabled?: boolean },
): UseRowResult<T> {
  const client = useLoomup();
  const enabled = options?.enabled !== false && id !== null && id !== undefined && id !== "";

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);

  const refetch = useCallback(async () => {
    if (id === null || id === undefined || id === "") {
      setData(null);
      setLoading(false);
      return;
    }
    const reqId = ++gen.current;
    setLoading(true);
    setError(null);
    try {
      const row = await client.from(table).get(id);
      if (reqId !== gen.current) return;
      setData(row as T);
    } catch (err) {
      if (reqId !== gen.current) return;
      setError(errorMessage(err));
      setData(null);
    } finally {
      if (reqId === gen.current) setLoading(false);
    }
  }, [client, table, id]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void refetch();
  }, [enabled, refetch]);

  return { data, loading, error, refetch };
}
