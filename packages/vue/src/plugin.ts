import { provide, type App, type Plugin } from "vue";
import {
  createClient,
  type CreateClientOptions,
  type DefaultInsertMap,
  type DefaultTableMap,
  type DefaultUpdateMap,
  type LoomupClient,
} from "@loomup/client";
import { LoomupKey, type LoomupContextValue } from "./inject.js";

export type PersistOptions = {
  /** Persist access + refresh tokens to localStorage (browser only). Default false. */
  enabled?: boolean;
  /** Storage key prefix. Default "loomup". */
  storageKey?: string;
};

export type LoomupPluginOptions<
  TMap extends DefaultTableMap = DefaultTableMap,
  TInsertMap extends DefaultInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap extends DefaultUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
> = {
  /** Existing client instance (preferred — keep stable across the app lifetime). */
  client?: LoomupClient<TMap, TInsertMap, TUpdateMap>;
  /** When `client` is omitted, create one from these options (once at install). */
  options?: CreateClientOptions;
  /** Optional token persistence for useAuth hydration. */
  persist?: PersistOptions;
};

const DEFAULT_PERSIST: Required<PersistOptions> = {
  enabled: false,
  storageKey: "loomup",
};

function resolveContext(opts: LoomupPluginOptions): LoomupContextValue {
  let client: LoomupClient | undefined = opts.client as LoomupClient | undefined;
  if (!client) {
    if (!opts.options) {
      throw new Error(
        "LoomupPlugin requires either a `client` option or `options` to create one.",
      );
    }
    client = createClient(opts.options) as LoomupClient;
  }

  const persist: Required<PersistOptions> = {
    enabled: opts.persist?.enabled ?? DEFAULT_PERSIST.enabled,
    storageKey: opts.persist?.storageKey ?? DEFAULT_PERSIST.storageKey,
  };

  return { client, persist };
}

/**
 * Vue plugin: `app.use(LoomupPlugin, { client })`.
 * Prefer a module-level `createClient(...)` so reconnects are not churned.
 */
export const LoomupPlugin: Plugin<LoomupPluginOptions> = {
  install(app: App, options: LoomupPluginOptions = {}) {
    const value = resolveContext(options);
    app.provide(LoomupKey, value);
  },
};

/**
 * Tree-level provide for Composition API (tests, nested apps, Storybook).
 * Call from `setup()` of a parent component.
 */
export function provideLoomup(options: LoomupPluginOptions): LoomupContextValue {
  const value = resolveContext(options);
  provide(LoomupKey, value);
  return value;
}
