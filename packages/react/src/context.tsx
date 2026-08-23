import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  createClient,
  type CreateClientOptions,
  type DefaultInsertMap,
  type DefaultTableMap,
  type DefaultUpdateMap,
  type LoomupClient,
} from "@loomup/client";
import {
  localStorageAdapter,
  type TokenStorage,
} from "./storage.js";

export type { TokenStorage } from "./storage.js";

export type PersistOptions = {
  /**
   * Persist access + refresh tokens via `storage` (default: browser localStorage).
   * Default false.
   */
  enabled?: boolean;
  /** Storage key prefix. Default "loomup". */
  storageKey?: string;
  /**
   * Token storage backend. Defaults to localStorage when available.
   * Pass AsyncStorage / SecureStore adapters for React Native.
   */
  storage?: TokenStorage;
};

/** Resolved persist config held in context (storage may be null when unavailable). */
export type ResolvedPersistOptions = {
  enabled: boolean;
  storageKey: string;
  storage: TokenStorage | null;
};

export type LoomupProviderProps<
  TMap extends DefaultTableMap = DefaultTableMap,
  TInsertMap extends DefaultInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap extends DefaultUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
> = {
  children: ReactNode;
  /** Existing client instance (preferred — keep stable across renders). */
  client?: LoomupClient<TMap, TInsertMap, TUpdateMap>;
  /** When `client` is omitted, create one from these options (once per provider mount). */
  options?: CreateClientOptions;
  /** Optional token persistence for useAuth hydration. */
  persist?: PersistOptions;
};

type LoomupContextValue = {
  client: LoomupClient;
  persist: ResolvedPersistOptions;
};

const LoomupContext = createContext<LoomupContextValue | null>(null);

const DEFAULT_STORAGE_KEY = "loomup";

/**
 * Provide a Loomup client to React hooks.
 * Prefer a module-level `createClient(...)` so reconnects are not churned on re-render.
 */
export function LoomupProvider<
  TMap extends DefaultTableMap = DefaultTableMap,
  TInsertMap extends DefaultInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap extends DefaultUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
>(props: LoomupProviderProps<TMap, TInsertMap, TUpdateMap>) {
  const { children, client: clientProp, options, persist: persistProp } = props;

  // Create owned client once per mount when no client prop is provided.
  const ownedRef = useRef<LoomupClient | null>(null);
  if (!clientProp && !ownedRef.current) {
    if (!options) {
      throw new Error(
        "LoomupProvider requires either a `client` prop or `options` to create one.",
      );
    }
    ownedRef.current = createClient(options) as LoomupClient;
  }
  const client = (clientProp ?? ownedRef.current) as LoomupClient;

  const persist = useMemo((): ResolvedPersistOptions => {
    const enabled = persistProp?.enabled ?? false;
    const storageKey = persistProp?.storageKey ?? DEFAULT_STORAGE_KEY;
    const storage =
      persistProp?.storage ?? (enabled ? localStorageAdapter() : null);
    return { enabled, storageKey, storage };
  }, [
    persistProp?.enabled,
    persistProp?.storageKey,
    persistProp?.storage,
  ]);

  const value = useMemo(
    (): LoomupContextValue => ({ client, persist }),
    [client, persist],
  );

  return (
    <LoomupContext.Provider value={value}>{children}</LoomupContext.Provider>
  );
}

/** Access the Loomup client from context. Throws outside LoomupProvider. */
export function useLoomup<
  TMap extends DefaultTableMap = DefaultTableMap,
  TInsertMap extends DefaultInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap extends DefaultUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
>(): LoomupClient<TMap, TInsertMap, TUpdateMap> {
  const ctx = useContext(LoomupContext);
  if (!ctx) {
    throw new Error("useLoomup must be used within a LoomupProvider");
  }
  return ctx.client as LoomupClient<TMap, TInsertMap, TUpdateMap>;
}

/** Internal: full context including persist options. */
export function useLoomupContext(): LoomupContextValue {
  const ctx = useContext(LoomupContext);
  if (!ctx) {
    throw new Error("Loomup hooks must be used within a LoomupProvider");
  }
  return ctx;
}
