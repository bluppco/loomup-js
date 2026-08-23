import { ref, type Ref } from "vue";
import type { LoomupClient } from "@loomup/client";
import { useLoomup } from "./inject.js";
import { errorMessage } from "./utils.js";

export type UseMutationResult<TArgs extends unknown[], TResult> = {
  mutate: (...args: TArgs) => Promise<TResult>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  reset: () => void;
};

/**
 * Thin mutation helper that standardizes loading/error around a client call.
 *
 * @example
 * const { mutate, loading } = useMutation((client, title: string) =>
 *   client.from("todos").insert({ title, completed: 0 }),
 * );
 */
export function useMutation<TArgs extends unknown[], TResult>(
  fn: (client: LoomupClient, ...args: TArgs) => Promise<TResult>,
): UseMutationResult<TArgs, TResult> {
  const client = useLoomup();
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function mutate(...args: TArgs): Promise<TResult> {
    loading.value = true;
    error.value = null;
    try {
      return await fn(client, ...args);
    } catch (err) {
      error.value = errorMessage(err);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  function reset() {
    error.value = null;
    loading.value = false;
  }

  return { mutate, loading, error, reset };
}
