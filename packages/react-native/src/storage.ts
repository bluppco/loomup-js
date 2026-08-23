/**
 * AsyncStorage adapter for @loomup/react TokenStorage.
 */

import type { TokenStorage } from "@loomup/react";

/** Minimal AsyncStorage-compatible surface (avoids hard dep at typecheck time). */
export type AsyncStorageLike = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

/**
 * Map React Native AsyncStorage (or any compatible store) to TokenStorage.
 *
 * @example
 * ```ts
 * import AsyncStorage from "@react-native-async-storage/async-storage";
 * import { asyncStorageAdapter } from "@loomup/react-native";
 *
 * const storage = asyncStorageAdapter(AsyncStorage);
 * ```
 */
export function asyncStorageAdapter(storage: AsyncStorageLike): TokenStorage {
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
  };
}
