/**
 * React Native-oriented createClient wrapper.
 *
 * URL tips for local development:
 * - Android emulator: http://10.0.2.2:3000 (maps to host loopback)
 * - iOS simulator: http://127.0.0.1:3000
 * - Physical device: http://<your-lan-ip>:3000
 * - Production: use HTTPS; cleartext HTTP may be blocked by the OS.
 */

import {
  createClient,
  type CreateClientOptions,
  type DefaultInsertMap,
  type DefaultTableMap,
  type DefaultUpdateMap,
  type LoomupClient,
} from "@loomup/client";

export type CreateNativeClientOptions = CreateClientOptions;

/**
 * Create a Loomup client for React Native.
 * Same as `createClient` from `@loomup/client` — RN provides global
 * `fetch` and `WebSocket`. Pass `WebSocketImpl` only if you need an override.
 */
export function createNativeClient<
  TMap extends DefaultTableMap = DefaultTableMap,
  TInsertMap extends DefaultInsertMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
  TUpdateMap extends DefaultUpdateMap = {
    [K in keyof TMap]: Partial<TMap[K]> & Record<string, unknown>;
  },
>(
  options: CreateNativeClientOptions,
): LoomupClient<TMap, TInsertMap, TUpdateMap> {
  return createClient<TMap, TInsertMap, TUpdateMap>(options);
}
