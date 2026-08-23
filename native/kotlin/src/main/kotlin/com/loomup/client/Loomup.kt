package com.loomup.client

/**
 * Loomup — Kotlin client for Loomup Realtime.
 *
 * Mirrors the TypeScript `@loomup/client` and Swift `Loomup` SDKs:
 *
 * ```kotlin
 * import com.loomup.client.createClient
 *
 * val client = createClient(url = "http://127.0.0.1:3000")
 * val tokens = client.auth.signUp(email = "a@b.com", password = "secret12")
 * val list = client.from("todos").select(
 *     where = mapOf("completed" to WhereValue.Bool(false)),
 *     limit = 20,
 * )
 * val unsub = client.from("todos").subscribeReady { event ->
 *     println("${event.op} ${event.data}")
 * }
 * unsub()
 * client.closeRealtime()
 * ```
 */

data class LoomupClientOptions(
    val url: String,
    val token: String? = null,
    val refreshToken: String? = null,
    val publishableKey: String? = null,
    val serviceKey: String? = null,
    val http: HttpTransport = OkHttpHttpTransport(),
    val webSocketFactory: WebSocketFactory? = null,
)

/** Create a Loomup client (TypeScript `createClient` equivalent). */
fun createClient(
    url: String,
    token: String? = null,
    refreshToken: String? = null,
    publishableKey: String? = null,
    serviceKey: String? = null,
    http: HttpTransport = OkHttpHttpTransport(),
    webSocketFactory: WebSocketFactory? = null,
): LoomupClient {
    return LoomupClient(
        LoomupClientOptions(
            url = url,
            token = token,
            refreshToken = refreshToken,
            publishableKey = publishableKey,
            serviceKey = serviceKey,
            http = http,
            webSocketFactory = webSocketFactory,
        ),
    )
}
