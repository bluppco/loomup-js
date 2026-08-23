import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, SubscribeHandler } from "@loomup/client";
import { useLoomup } from "./context.js";
import { errorMessage } from "./utils.js";

export type UseSubscribeOptions = {
  rowId?: string;
  /** When false, do not subscribe. Default true. */
  enabled?: boolean;
  /**
   * Wait for server subscribe ack before setting ready.
   * Default true (uses subscribeReady).
   */
  waitForAck?: boolean;
  timeoutMs?: number;
};

export type UseSubscribeResult = {
  /** True after subscription is active (and ack received when waitForAck). */
  ready: boolean;
  error: string | null;
};

/**
 * Subscribe to table (or row) changes. Unsubscribes on unmount / option change.
 * Handler is stored in a ref so identity changes do not resubscribe.
 */
export function useSubscribe(
  table: string,
  handler: SubscribeHandler,
  options?: UseSubscribeOptions,
): UseSubscribeResult {
  const client = useLoomup();
  const enabled = options?.enabled !== false;
  const rowId = options?.rowId;
  const waitForAck = options?.waitForAck !== false;
  const timeoutMs = options?.timeoutMs ?? 5000;

  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setReady(false);
      setError(null);
      return;
    }

    let unsub: (() => void) | undefined;
    let cancelled = false;

    const wrapped: SubscribeHandler = (ev: ChangeEvent) => {
      handlerRef.current(ev);
    };

    (async () => {
      setReady(false);
      setError(null);
      try {
        if (waitForAck) {
          unsub = await client.from(table).subscribeReady(wrapped, rowId, timeoutMs);
        } else {
          unsub = client.from(table).subscribe(wrapped, rowId);
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
  }, [client, table, rowId, enabled, waitForAck, timeoutMs]);

  return { ready, error };
}
