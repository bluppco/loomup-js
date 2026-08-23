/**
 * Pluggable token storage for auth session persistence.
 * Works with browser localStorage (sync) or AsyncStorage / SecureStore (async).
 */

export type TokenStorage = {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
};

/** Browser localStorage adapter. Returns null when localStorage is unavailable. */
export function localStorageAdapter(): TokenStorage | null {
  try {
    if (typeof globalThis.localStorage === "undefined") return null;
  } catch {
    return null;
  }
  return {
    getItem(key: string) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* ignore quota / private mode */
      }
    },
    removeItem(key: string) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

export async function loadTokens(
  storage: TokenStorage | null,
  storageKey: string,
): Promise<{ access?: string; refresh?: string }> {
  if (!storage) return {};
  try {
    const access = (await storage.getItem(`${storageKey}:access`)) ?? undefined;
    const refresh = (await storage.getItem(`${storageKey}:refresh`)) ?? undefined;
    return {
      access: access || undefined,
      refresh: refresh || undefined,
    };
  } catch {
    return {};
  }
}

export async function saveTokens(
  storage: TokenStorage | null,
  storageKey: string,
  access?: string,
  refresh?: string,
): Promise<void> {
  if (!storage) return;
  try {
    if (access) await storage.setItem(`${storageKey}:access`, access);
    else await storage.removeItem(`${storageKey}:access`);
    if (refresh) await storage.setItem(`${storageKey}:refresh`, refresh);
    else await storage.removeItem(`${storageKey}:refresh`);
  } catch {
    /* ignore quota / private mode */
  }
}

export async function clearTokens(
  storage: TokenStorage | null,
  storageKey: string,
): Promise<void> {
  await saveTokens(storage, storageKey, undefined, undefined);
}
