import { useCallback, useState } from "react";
import type { LoomupClient } from "@loomup/client";
import { useLoomup } from "./context.js";
import { errorMessage } from "./utils.js";

export type UseMutationResult<TArgs extends unknown[], TResult> = {
  mutate: (...args: TArgs) => Promise<TResult>;
  loading: boolean;
  error: string | null;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(
    async (...args: TArgs) => {
      setLoading(true);
      setError(null);
      try {
        return await fn(client, ...args);
      } catch (err) {
        setError(errorMessage(err));
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [client, fn],
  );

  const reset = useCallback(() => {
    setError(null);
    setLoading(false);
  }, []);

  return { mutate, loading, error, reset };
}
