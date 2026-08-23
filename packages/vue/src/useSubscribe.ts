import {
  onUnmounted,
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type Ref,
} from "vue";
import type { ChangeEvent, SubscribeHandler } from "@loomup/client";
import { useLoomup } from "./inject.js";
import { errorMessage } from "./utils.js";

export type UseSubscribeOptions = {
  rowId?: string;
  /** When false, do not subscribe. Default true. Accepts ref/getter. */
  enabled?: MaybeRefOrGetter<boolean>;
  /**
   * Wait for server subscribe ack before setting ready.
   * Default true (uses subscribeReady).
   */
  waitForAck?: boolean;
  timeoutMs?: number;
};

export type UseSubscribeResult = {
  /** True after subscription is active (and ack received when waitForAck). */
  ready: Ref<boolean>;
  error: Ref<string | null>;
};

/**
 * Subscribe to table (or row) changes. Unsubscribes on unmount / option change.
 * Handler identity can change without resubscribing.
 */
export function useSubscribe(
  table: string,
  handler: SubscribeHandler,
  options?: UseSubscribeOptions,
): UseSubscribeResult {
  const client = useLoomup();
  const ready = ref(false);
  const error = ref<string | null>(null);

  // Keep latest handler without resubscribing when identity changes.
  let latestHandler = handler;
  watch(
    () => handler,
    (h) => {
      latestHandler = h;
    },
  );

  let unsub: (() => void) | undefined;
  let cancelled = false;

  watch(
    () =>
      [
        table,
        options?.rowId,
        toValue(options?.enabled) !== false,
        options?.waitForAck !== false,
        options?.timeoutMs ?? 5000,
      ] as const,
    async ([tbl, rowId, enabled, waitForAck, timeoutMs], _prev, onCleanup) => {
      cancelled = true;
      unsub?.();
      unsub = undefined;
      cancelled = false;

      if (!enabled) {
        ready.value = false;
        error.value = null;
        return;
      }

      const wrapped: SubscribeHandler = (ev: ChangeEvent) => {
        latestHandler(ev);
      };

      ready.value = false;
      error.value = null;

      try {
        if (waitForAck) {
          unsub = await client.from(tbl).subscribeReady(wrapped, rowId, timeoutMs);
        } else {
          unsub = client.from(tbl).subscribe(wrapped, rowId);
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

  return { ready, error };
}
