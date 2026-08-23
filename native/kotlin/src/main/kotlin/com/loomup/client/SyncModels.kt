package com.loomup.client

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@Serializable data class SyncRecord(val data: Map<String, JsonValue>, val version: Long)
@Serializable data class SyncResourceSnapshot(val records: List<SyncRecord> = emptyList())
@Serializable data class SyncBootstrapResponse(
    @SerialName("protocol_version") val protocolVersion: Int,
    @SerialName("schema_version") val schemaVersion: String,
    val cursor: Long,
    val resources: Map<String, SyncResourceSnapshot>,
)
@Serializable data class SyncEvent(
    val sequence: Long,
    @SerialName("event_id") val eventId: String,
    val resource: String,
    @SerialName("record_id") val recordId: String,
    val operation: String,
    val before: Map<String, JsonValue>? = null,
    val after: Map<String, JsonValue>? = null,
    @SerialName("actor_id") val actorId: String? = null,
    val origin: String,
    @SerialName("committed_at") val committedAt: Long,
    @SerialName("schema_version") val schemaVersion: Long,
)
@Serializable data class SyncPullResponse(
    @SerialName("protocol_version") val protocolVersion: Int,
    @SerialName("schema_version") val schemaVersion: String,
    val cursor: Long,
    @SerialName("has_more") val hasMore: Boolean,
    val events: List<SyncEvent>,
)
@Serializable data class SyncMutation(
    val id: String,
    val resource: String,
    val operation: String,
    @SerialName("record_id") val recordId: String? = null,
    val data: Map<String, JsonValue>? = null,
    @SerialName("base_sequence") val baseSequence: Long? = null,
)
@Serializable data class SyncMutationError(
    val code: String,
    val message: String,
    val details: Map<String, JsonValue>? = null,
)
@Serializable data class SyncMutationResult(
    @SerialName("mutation_id") val mutationId: String,
    val status: String,
    val record: Map<String, JsonValue>? = null,
    val sequence: Long? = null,
    val error: SyncMutationError? = null,
)
@Serializable data class SyncMutationResponse(
    @SerialName("protocol_version") val protocolVersion: Int,
    val results: List<SyncMutationResult>,
)

interface SyncTransport {
    suspend fun syncBootstrap(resources: List<String>, clientId: String): SyncBootstrapResponse
    suspend fun syncPull(cursor: Long, resources: List<String>, clientId: String): SyncPullResponse
    suspend fun syncMutations(mutations: List<SyncMutation>): SyncMutationResponse
}

@Serializable private data class SyncMutationBody(
    @SerialName("protocol_version") val protocolVersion: Int = 1,
    val mutations: List<SyncMutation>,
)

suspend fun LoomupClient.syncBootstrap(resources: List<String>, clientId: String): SyncBootstrapResponse {
    val query = "resources=${encodeURIComponent(resources.joinToString(","))}&client_id=${encodeURIComponent(clientId)}&protocol_version=1"
    return requestJson<DataEnvelope<SyncBootstrapResponse>>("GET", "/sync/v1/bootstrap?$query").data
}
suspend fun LoomupClient.syncPull(cursor: Long, resources: List<String>, clientId: String): SyncPullResponse {
    val query = "resources=${encodeURIComponent(resources.joinToString(","))}&cursor=$cursor&client_id=${encodeURIComponent(clientId)}&protocol_version=1"
    return requestJson<DataEnvelope<SyncPullResponse>>("GET", "/sync/v1/pull?$query").data
}
suspend fun LoomupClient.syncMutations(mutations: List<SyncMutation>): SyncMutationResponse {
    val body = clientJson.encodeToString(SyncMutationBody(mutations = mutations)).toByteArray()
    return requestJson<DataEnvelope<SyncMutationResponse>>("POST", "/sync/v1/mutations", body).data
}

class LoomupSyncTransport(private val client: LoomupClient) : SyncTransport {
    override suspend fun syncBootstrap(resources: List<String>, clientId: String) = client.syncBootstrap(resources, clientId)
    override suspend fun syncPull(cursor: Long, resources: List<String>, clientId: String) = client.syncPull(cursor, resources, clientId)
    override suspend fun syncMutations(mutations: List<SyncMutation>) = client.syncMutations(mutations)
}
