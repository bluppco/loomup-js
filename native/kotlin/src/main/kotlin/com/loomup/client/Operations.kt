package com.loomup.client

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import java.nio.charset.StandardCharsets

@Serializable
data class OperationMeta(
    val operation: String,
    val database: String,
    @kotlinx.serialization.SerialName("duration_ms") val durationMs: Long,
    val contract: String,
    val rows: Int? = null,
    val replayed: Boolean? = null,
)

@Serializable
data class OperationResponse<T>(
    val data: T,
    val meta: OperationMeta,
)

@Serializable
data class BatchItemResult<T>(
    val index: Int,
    val status: String,
    val data: T? = null,
    val error: String? = null,
)

@PublishedApi
@Serializable
internal data class CommandBatchBody<T>(val items: List<T>)

@Serializable
data class SearchInput(val query: String, val limit: Int? = null, val offset: Int? = null)

@Serializable
data class JobLease<T>(
    val id: String,
    val job: String,
    val payload: T,
    val attempt: Int,
    @kotlinx.serialization.SerialName("max_attempts") val maxAttempts: Int,
    @kotlinx.serialization.SerialName("lease_expires_at") val leaseExpiresAt: Long,
)

@PublishedApi @Serializable internal data class JobEnqueueBody<T>(val payload: T, @kotlinx.serialization.SerialName("run_at") val runAt: Long?)
@PublishedApi @Serializable internal data class JobWorkerBody(
    @kotlinx.serialization.SerialName("worker_id") val workerId: String,
    @kotlinx.serialization.SerialName("lease_seconds") val leaseSeconds: Long = 60,
    val result: kotlinx.serialization.json.JsonElement? = null,
    val error: String = "",
)
@PublishedApi @Serializable internal data class JobCompleteBody<T>(@kotlinx.serialization.SerialName("worker_id") val workerId: String, val result: T)
@PublishedApi @Serializable internal data class JobFailBody(@kotlinx.serialization.SerialName("worker_id") val workerId: String, val error: String)

/** Execute a manifest-declared, read-only named query. */
suspend inline fun <reified Input, reified Output> LoomupClient.query(
    name: String,
    input: Input,
): OperationResponse<Output> = requestJson(
    method = "POST",
    path = "/api/queries/${encodeURIComponent(name)}",
    body = clientJson.encodeToString(input).toByteArray(StandardCharsets.UTF_8),
)

/** Execute a manifest-declared transactional command. */
suspend inline fun <reified Input, reified Output> LoomupClient.command(
    name: String,
    input: Input,
    idempotencyKey: String? = null,
): OperationResponse<Output> = requestJson(
    method = "POST",
    path = "/api/commands/${encodeURIComponent(name)}",
    body = clientJson.encodeToString(input).toByteArray(StandardCharsets.UTF_8),
    extraHeaders = idempotencyKey?.let { mapOf("Idempotency-Key" to it) } ?: emptyMap(),
)

/** Execute a bounded batch when enabled on the command contract. */
suspend inline fun <reified Input, reified Output> LoomupClient.commandBatch(
    name: String,
    items: List<Input>,
    idempotencyKey: String? = null,
): OperationResponse<List<BatchItemResult<Output>>> = requestJson(
    method = "POST",
    path = "/api/commands/${encodeURIComponent(name)}/batch",
    body = clientJson.encodeToString(CommandBatchBody(items)).toByteArray(StandardCharsets.UTF_8),
    extraHeaders = idempotencyKey?.let { mapOf("Idempotency-Key" to it) } ?: emptyMap(),
)

/** Search a manifest-declared FTS index. */
suspend inline fun <reified Output> LoomupClient.search(
    name: String,
    input: SearchInput,
): OperationResponse<List<Output>> = requestJson(
    method = "POST",
    path = "/api/search/${encodeURIComponent(name)}",
    body = clientJson.encodeToString(input).toByteArray(StandardCharsets.UTF_8),
)

suspend inline fun <reified Payload> LoomupClient.enqueueJob(name: String, payload: Payload, runAt: Long? = null): String {
    val response: DataEnvelope<Map<String, String>> = requestJson(
        "POST", "/api/jobs/${encodeURIComponent(name)}/enqueue",
        clientJson.encodeToString(JobEnqueueBody(payload, runAt)).toByteArray(StandardCharsets.UTF_8),
    )
    return response.data.getValue("id")
}

suspend inline fun <reified Payload> LoomupClient.claimJob(workerId: String, leaseSeconds: Long = 60): JobLease<Payload>? {
    val response: DataEnvelope<JobLease<Payload>?> = requestJson(
        "POST", "/api/jobs/claim",
        clientJson.encodeToString(JobWorkerBody(workerId, leaseSeconds)).toByteArray(StandardCharsets.UTF_8),
    )
    return response.data
}

suspend fun LoomupClient.heartbeatJob(id: String, workerId: String, leaseSeconds: Long = 60) {
    requestJson<Map<String, kotlinx.serialization.json.JsonElement>>(
        "POST", "/api/jobs/${encodeURIComponent(id)}/heartbeat",
        clientJson.encodeToString(JobWorkerBody(workerId, leaseSeconds)).toByteArray(StandardCharsets.UTF_8),
    )
}

suspend inline fun <reified Result> LoomupClient.completeJob(id: String, workerId: String, result: Result) {
    requestJson<Map<String, kotlinx.serialization.json.JsonElement>>(
        "POST", "/api/jobs/${encodeURIComponent(id)}/complete",
        clientJson.encodeToString(JobCompleteBody(workerId, result)).toByteArray(StandardCharsets.UTF_8),
    )
}

suspend fun LoomupClient.failJob(id: String, workerId: String, error: String) {
    requestJson<Map<String, kotlinx.serialization.json.JsonElement>>(
        "POST", "/api/jobs/${encodeURIComponent(id)}/fail",
        clientJson.encodeToString(JobFailBody(workerId, error)).toByteArray(StandardCharsets.UTF_8),
    )
}
