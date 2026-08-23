import { useMemo, type ReactNode } from "react";
import {
  LoomupProvider,
  type LoomupProviderProps,
  type PersistOptions,
  type TokenStorage,
} from "@loomup/react";
import type {
  DefaultInsertMap,
  DefaultTableMap,
  DefaultUpdateMap,
} from "@loomup/client";
import {
  asyncStorageAdapter,
  type AsyncStorageLike,
} from "./storage.js";

export type NativePersistOptions = PersistOptions & {
  /**
   * When true (default), persist tokens with AsyncStorage.
   * Differs from web `@loomup/react` where persist defaults to false.
   */
  enabled?: boolean;
};

export type LoomupNativeProviderProps<
  TMap extends DefaultTableMap = DefaultTableMap,
  TInsertMap extends DefaultInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap extends DefaultUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
> = Omit<LoomupProviderProps<TMap, TInsertMap, TUpdateMap>, "persist"> & {
  children: ReactNode;
  /**
   * Token persistence. Defaults to `{ enabled: true }` with AsyncStorage.
   * Pass `enabled: false` to keep tokens in memory only.
   * Pass `storage` for a custom backend (e.g. SecureStore adapter).
   */
  persist?: NativePersistOptions;
  /**
   * AsyncStorage implementation. Required when persist is enabled and
   * `persist.storage` is not provided. Typically:
   * `import AsyncStorage from "@react-native-async-storage/async-storage"`.
   */
  asyncStorage?: AsyncStorageLike;
};

/**
 * Loomup provider preconfigured for React Native (AsyncStorage session).
 *
 * @example
 * ```tsx
 * import AsyncStorage from "@react-native-async-storage/async-storage";
 * import {
 *   createNativeClient,
 *   LoomupNativeProvider,
 * } from "@loomup/react-native";
 *
 * const client = createNativeClient({ url: "http://10.0.2.2:3000" });
 *
 * export function App() {
 *   return (
 *     <LoomupNativeProvider client={client} asyncStorage={AsyncStorage}>
 *       <Main />
 *     </LoomupNativeProvider>
 *   );
 * }
 * ```
 */
export function LoomupNativeProvider<
  TMap extends DefaultTableMap = DefaultTableMap,
  TInsertMap extends DefaultInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap extends DefaultUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
>(props: LoomupNativeProviderProps<TMap, TInsertMap, TUpdateMap>) {
  const {
    children,
    client,
    options,
    persist: persistProp,
    asyncStorage,
  } = props;

  const persist = useMemo((): PersistOptions => {
    const enabled = persistProp?.enabled ?? true;
    const storageKey = persistProp?.storageKey ?? "loomup";
    let storage: TokenStorage | undefined = persistProp?.storage;

    if (enabled && !storage) {
      if (!asyncStorage) {
        throw new Error(
          "LoomupNativeProvider requires `asyncStorage` (or persist.storage) when persist is enabled. " +
            'Pass import AsyncStorage from "@react-native-async-storage/async-storage".',
        );
      }
      storage = asyncStorageAdapter(asyncStorage);
    }

    return {
      enabled,
      storageKey,
      storage,
    };
  }, [
    persistProp?.enabled,
    persistProp?.storageKey,
    persistProp?.storage,
    asyncStorage,
  ]);

  return (
    <LoomupProvider client={client} options={options} persist={persist}>
      {children}
    </LoomupProvider>
  );
}
