import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { SyncConflict, SyncStore, SyncStoreStatus } from "@loomup/client";

const SyncStoreContext = createContext<SyncStore | null>(null);

export function SyncStoreProvider({
  store,
  children,
}: {
  store: SyncStore;
  children: ReactNode;
}) {
  return <SyncStoreContext.Provider value={store}>{children}</SyncStoreContext.Provider>;
}

export function useSyncStore(): SyncStore {
  const store = useContext(SyncStoreContext);
  if (!store) throw new Error("useSyncStore must be used within SyncStoreProvider");
  return store;
}

export type UseSyncResourceResult<T extends Record<string, unknown>> = {
  data: readonly T[];
  status: SyncStoreStatus;
  conflicts: readonly SyncConflict[];
  create: (
    data: Record<string, unknown>,
    options?: { recordId?: string; mutationId?: string },
  ) => Promise<Record<string, unknown>>;
  update: (
    id: string | number,
    patch: Record<string, unknown>,
    options?: { mutationId?: string },
  ) => Promise<Record<string, unknown>>;
  remove: (id: string | number, options?: { mutationId?: string }) => Promise<void>;
  sync: () => Promise<void>;
  setOnline: (online: boolean) => Promise<void>;
};

/** Reactive, optimistic local rows backed by the durable SyncStore queue. */
export function useSyncResource<
  T extends Record<string, unknown> = Record<string, unknown>,
>(resource: string): UseSyncResourceResult<T> {
  const store = useSyncStore();
  const [, setRevision] = useState(0);
  useEffect(
    () => store.subscribe(() => setRevision((revision) => revision + 1)),
    [store],
  );
  const create = useCallback(
    (data: Record<string, unknown>, options?: { recordId?: string; mutationId?: string }) =>
      store.create(resource, data, options),
    [store, resource],
  );
  const update = useCallback(
    (
      id: string | number,
      patch: Record<string, unknown>,
      options?: { mutationId?: string },
    ) => store.update(resource, id, patch, options),
    [store, resource],
  );
  const remove = useCallback(
    (id: string | number, options?: { mutationId?: string }) =>
      store.remove(resource, id, options),
    [store, resource],
  );
  return {
    data: store.find(resource) as readonly T[],
    status: store.status,
    conflicts: store.conflicts,
    create,
    update,
    remove,
    sync: () => store.sync(),
    setOnline: (online) => store.setOnline(online),
  };
}
