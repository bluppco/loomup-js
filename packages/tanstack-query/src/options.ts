import type { QueryClient } from "@tanstack/query-core";
import type {
  AuthTokens,
  DefaultInsertMap,
  DefaultTableMap,
  DefaultUpdateMap,
  ListMeta,
  LoomupClient,
  User,
} from "@loomup/client";
import {
  invalidateTable,
  loomupKeys,
  removeDetail,
  setDetail,
} from "./keys.js";
import { syncRealtime, type SyncRealtimeOptions } from "./realtime.js";
import type {
  ListFilters,
  MutationCacheOptions,
  UpdateVariables,
} from "./types.js";

type SelectResult<TRow> = { data: TRow[]; meta: ListMeta };

/**
 * Bind TanStack Query option factories to a Loomup client instance.
 * Generics flow from the client so `from("todos")` stays typed.
 */
export function createLoomupQuery<
  TMap extends DefaultTableMap = DefaultTableMap,
  TInsertMap extends DefaultInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap extends DefaultUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
>(client: LoomupClient<TMap, TInsertMap, TUpdateMap>) {
  return {
    keys: loomupKeys,

    from<K extends keyof TMap & string>(table: K) {
      type TRow = TMap[K];
      type TInsert = K extends keyof TInsertMap
        ? NonNullable<TInsertMap[K]>
        : Partial<TMap[K]> & Record<string, unknown>;
      type TUpdate = K extends keyof TUpdateMap
        ? NonNullable<TUpdateMap[K]>
        : Partial<TMap[K]> & Record<string, unknown>;

      const tq = client.from(table);

      return {
        /** Query options for `select` (list). */
        selectOptions(filters?: ListFilters, overrides?: Record<string, unknown>) {
          return {
            queryKey: loomupKeys.list(table, filters),
            queryFn: (): Promise<SelectResult<TRow>> =>
              tq.select(filters) as Promise<SelectResult<TRow>>,
            ...overrides,
          };
        },

        /** Query options for `get` (detail by id). */
        getOptions(id: string | number, overrides?: Record<string, unknown>) {
          return {
            queryKey: loomupKeys.detail(table, id),
            queryFn: (): Promise<TRow> => tq.get(id) as Promise<TRow>,
            ...overrides,
          };
        },

        /**
         * Mutation options for insert.
         * Pass `{ queryClient }` to auto-invalidate the table on success.
         */
        insertOptions(
          opts?: MutationCacheOptions & Record<string, unknown>,
        ) {
          const { queryClient, ...overrides } = opts ?? {};
          return {
            mutationFn: (row: TInsert): Promise<TRow> =>
              tq.insert(row) as Promise<TRow>,
            ...(queryClient
              ? {
                  onSuccess: (data: TRow) => {
                    const row = data as Record<string, unknown>;
                    const id = row?.id;
                    if (id != null) {
                      setDetail(queryClient, table, id as string | number, data);
                    }
                    invalidateTable(queryClient, table);
                  },
                }
              : {}),
            ...overrides,
          };
        },

        /**
         * Mutation options for update.
         * `mutationFn` args: `{ id, patch }`.
         * Pass `{ queryClient }` to set detail + invalidate table on success.
         */
        updateOptions(
          opts?: MutationCacheOptions & Record<string, unknown>,
        ) {
          const { queryClient, ...overrides } = opts ?? {};
          return {
            mutationFn: ({
              id,
              patch,
            }: UpdateVariables<TUpdate>): Promise<TRow> =>
              tq.update(id, patch) as Promise<TRow>,
            ...(queryClient
              ? {
                  onSuccess: (
                    data: TRow,
                    variables: UpdateVariables<TUpdate>,
                  ) => {
                    setDetail(queryClient, table, variables.id, data);
                    invalidateTable(queryClient, table);
                  },
                }
              : {}),
            ...overrides,
          };
        },

        /**
         * Mutation options for delete.
         * Pass `{ queryClient }` to remove detail + invalidate table on success.
         */
        deleteOptions(
          opts?: MutationCacheOptions & Record<string, unknown>,
        ) {
          const { queryClient, ...overrides } = opts ?? {};
          return {
            mutationFn: (id: string | number): Promise<TRow> =>
              tq.delete(id) as Promise<TRow>,
            ...(queryClient
              ? {
                  onSuccess: (_data: TRow, id: string | number) => {
                    removeDetail(queryClient, table, id);
                    invalidateTable(queryClient, table);
                  },
                }
              : {}),
            ...overrides,
          };
        },

        /**
         * Subscribe to realtime changes and sync the QueryClient cache.
         * Returns unsubscribe — call from effect cleanup.
         */
        syncRealtime(
          queryClient: QueryClient,
          options?: SyncRealtimeOptions,
        ): () => void {
          return syncRealtime(
            client as unknown as LoomupClient,
            table,
            queryClient,
            options,
          );
        },
      };
    },

    auth: {
      meOptions(overrides?: Record<string, unknown>) {
        return {
          queryKey: loomupKeys.me(),
          queryFn: (): Promise<User> => client.auth.me(),
          ...overrides,
        };
      },

      signInOptions(opts?: MutationCacheOptions & Record<string, unknown>) {
        const { queryClient, ...overrides } = opts ?? {};
        return {
          mutationFn: (creds: {
            email: string;
            password: string;
          }): Promise<AuthTokens> => client.auth.signIn(creds),
          ...(queryClient
            ? {
                onSuccess: (data: AuthTokens) => {
                  if (data.user) {
                    queryClient.setQueryData(loomupKeys.me(), data.user);
                  }
                },
              }
            : {}),
          ...overrides,
        };
      },

      signUpOptions(opts?: MutationCacheOptions & Record<string, unknown>) {
        const { queryClient, ...overrides } = opts ?? {};
        return {
          mutationFn: (creds: {
            email: string;
            password: string;
          }): Promise<AuthTokens> => client.auth.signUp(creds),
          ...(queryClient
            ? {
                onSuccess: (data: AuthTokens) => {
                  if (data.user) {
                    queryClient.setQueryData(loomupKeys.me(), data.user);
                  }
                },
              }
            : {}),
          ...overrides,
        };
      },

      signOutOptions(opts?: MutationCacheOptions & Record<string, unknown>) {
        const { queryClient, ...overrides } = opts ?? {};
        return {
          mutationFn: (): Promise<void> => client.auth.signOut(),
          ...(queryClient
            ? {
                onSuccess: () => {
                  queryClient.removeQueries({ queryKey: loomupKeys.all });
                },
              }
            : {}),
          ...overrides,
        };
      },
    },
  };
}

export type LoomupQueryHelpers<
  TMap extends DefaultTableMap = DefaultTableMap,
  TInsertMap extends DefaultInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap extends DefaultUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
> = ReturnType<typeof createLoomupQuery<TMap, TInsertMap, TUpdateMap>>;
