package com.loomup.client

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Error thrown by the Loomup client for HTTP and protocol failures. */
class LoomupError(
    message: String,
    val code: String? = null,
    val status: Int? = null,
) : Exception(message) {
    val errorMessage: String get() = message ?: ""
}

@Serializable
data class User(
    val id: String,
    val email: String,
    val role: String,
    val disabled: Boolean,
    @SerialName("created_at") val createdAt: Long,
)

@Serializable
data class AuthTokens(
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String,
    @SerialName("token_type") val tokenType: String,
    @SerialName("expires_in") val expiresIn: Int,
    val user: User? = null,
)

@Serializable
data class PushDevice(
    val id: String,
    @SerialName("user_id") val userId: String,
    val token: String,
    val provider: String,
    val platform: String? = null,
    @SerialName("device_id") val deviceId: String? = null,
    @SerialName("app_version") val appVersion: String? = null,
    val locale: String? = null,
    @SerialName("created_at") val createdAt: Long,
    @SerialName("updated_at") val updatedAt: Long,
    @SerialName("last_seen_at") val lastSeenAt: Long? = null,
    val disabled: Boolean = false,
    @SerialName("disabled_reason") val disabledReason: String? = null,
)

@Serializable
data class StorageObject(
    val id: String,
    val bucket: String,
    val path: String,
    val name: String,
    @SerialName("owner_id") val ownerId: String? = null,
    @SerialName("content_type") val contentType: String? = null,
    val size: Long,
    val etag: String? = null,
    @SerialName("created_at") val createdAt: Long,
    @SerialName("updated_at") val updatedAt: Long,
)

@Serializable
data class StorageBucketInfo(
    val name: String,
    val public: Boolean = false,
)

@Serializable
data class ListMeta(
    val limit: Int,
    val offset: Int,
    val total: Int,
    /** Present when rule-filtered list hit the server scan cap; total is a lower bound. */
    val truncated: Boolean? = null,
    /** Signed opaque cursor for the next page. Null on the final page. */
    @SerialName("next_cursor") val nextCursor: String? = null,
)

data class ListResult(
    val data: List<Map<String, JsonValue>>,
    val meta: ListMeta,
)

/** Realtime change frame (`type: "change"`). */
data class ChangeEvent(
    val type: String = "change",
    val channel: String? = null,
    val table: String,
    val op: String,
    val id: String,
    val data: Map<String, JsonValue>? = null,
    /** Unix **seconds** (same unit as server CDC events). */
    val ts: Long,
)

/** Non-change control frames (auth/subscribe/error). */
data class ControlEvent(
    val type: String,
    val requestId: String? = null,
    val channel: String? = null,
    val table: String? = null,
    val message: String? = null,
    val code: String? = null,
    val id: String? = null,
)

typealias SubscribeHandler = (ChangeEvent) -> Unit
typealias ControlHandler = (ControlEvent) -> Unit
typealias Unsubscribe = () -> Unit

@Serializable
@PublishedApi
internal data class DataEnvelope<T>(val data: T)

@Serializable
internal data class ListEnvelope(
    val data: List<Map<String, JsonValue>>,
    val meta: ListMeta,
)

@Serializable
internal data class StorageListEnvelope(
    val data: List<StorageObject>,
    val meta: ListMeta,
)

@Serializable
internal data class ErrorBody(
    val error: ErrorDetail? = null,
    val message: String? = null,
) {
    @Serializable
    data class ErrorDetail(
        val code: String? = null,
        val message: String? = null,
    )
}
