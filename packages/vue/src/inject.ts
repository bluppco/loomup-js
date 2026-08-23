import { inject, type InjectionKey } from "vue";
import type {
  DefaultInsertMap,
  DefaultTableMap,
  DefaultUpdateMap,
  LoomupClient,
} from "@loomup/client";
import type { PersistOptions } from "./plugin.js";

export type LoomupContextValue = {
  client: LoomupClient;
  persist: Required<PersistOptions>;
};

export const LoomupKey: InjectionKey<LoomupContextValue> = Symbol("loomup");

/** Access the Loomup client from inject. Throws outside plugin/provide. */
export function useLoomup<
  TMap extends DefaultTableMap = DefaultTableMap,
  TInsertMap extends DefaultInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap extends DefaultUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
>(): LoomupClient<TMap, TInsertMap, TUpdateMap> {
  const ctx = inject(LoomupKey);
  if (!ctx) {
    throw new Error(
      "useLoomup must be used after app.use(LoomupPlugin) or provideLoomup()",
    );
  }
  return ctx.client as LoomupClient<TMap, TInsertMap, TUpdateMap>;
}

/** Internal: full context including persist options. */
export function useLoomupContext(): LoomupContextValue {
  const ctx = inject(LoomupKey);
  if (!ctx) {
    throw new Error(
      "Loomup composables must be used after app.use(LoomupPlugin) or provideLoomup()",
    );
  }
  return ctx;
}
