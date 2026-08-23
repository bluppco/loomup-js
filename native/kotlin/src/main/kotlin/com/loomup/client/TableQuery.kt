package com.loomup.client

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/** Fluent table accessor: CRUD + realtime for one table name. */
class TableQuery internal constructor(
    private val client: LoomupClient,
    private val table: String,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        isLenient = true
    }

    suspend fun select(
        where: Map<String, WhereValue>? = null,
        filter: Map<String, Map<String, WhereValue>>? = null,
        select: List<String>? = null,
        sort: String? = null,
        limit: Int? = null,
        offset: Int? = null,
        cursor: String? = null,
    ): ListResult {
        val items = mutableListOf<Pair<String, String>>()
        if (cursor != null) items.add("cursor" to cursor)
        if (limit != null) items.add("limit" to limit.toString())
        if (offset != null) items.add("offset" to offset.toString())
        if (sort != null) items.add("sort" to sort)
        if (!select.isNullOrEmpty()) items.add("select" to select.joinToString(","))
        if (where != null) {
            for ((k, v) in where) {
                items.add("where[$k]" to v.queryString)
            }
        }
        if (filter != null) {
            for ((field, operations) in filter) {
                for ((operation, value) in operations) {
                    val wireOperation = when (operation) {
                        "isNull" -> "is_null"
                        "startsWith" -> "starts_with"
                        else -> operation
                    }
                    items.add("filter[$field][$wireOperation]" to value.queryString)
                }
            }
        }

        var path = "/api/${encodeURIComponent(table)}"
        if (items.isNotEmpty()) {
            val query = items.joinToString("&") { (k, v) ->
                "${encodeQueryComponent(k)}=${encodeQueryComponent(v)}"
            }
            path += "?$query"
        }

        val env: ListEnvelope = client.requestJson("GET", path)
        return ListResult(data = env.data, meta = env.meta)
    }

    suspend fun get(id: String): Map<String, JsonValue> {
        val path = "/api/${encodeURIComponent(table)}/${encodeURIComponent(id)}"
        val env: DataEnvelope<Map<String, JsonValue>> = client.requestJson("GET", path)
        return env.data
    }

    suspend fun get(id: Int): Map<String, JsonValue> = get(id.toString())

    suspend fun insert(row: Map<String, JsonValue>): Map<String, JsonValue> {
        val body = json.encodeToString(row).toByteArray(StandardCharsets.UTF_8)
        val path = "/api/${encodeURIComponent(table)}"
        val env: DataEnvelope<Map<String, JsonValue>> = client.requestJson("POST", path, body)
        return env.data
    }

    suspend fun update(id: String, patch: Map<String, JsonValue>): Map<String, JsonValue> {
        val body = json.encodeToString(patch).toByteArray(StandardCharsets.UTF_8)
        val path = "/api/${encodeURIComponent(table)}/${encodeURIComponent(id)}"
        val env: DataEnvelope<Map<String, JsonValue>> = client.requestJson("PATCH", path, body)
        return env.data
    }

    suspend fun update(id: Int, patch: Map<String, JsonValue>): Map<String, JsonValue> =
        update(id.toString(), patch)

    suspend fun delete(id: String): Map<String, JsonValue> {
        val path = "/api/${encodeURIComponent(table)}/${encodeURIComponent(id)}"
        val env: DataEnvelope<Map<String, JsonValue>> = client.requestJson("DELETE", path)
        return env.data
    }

    suspend fun delete(id: Int): Map<String, JsonValue> = delete(id.toString())

    fun subscribe(
        rowId: String? = null,
        handler: SubscribeHandler,
    ): Unsubscribe {
        return client.subscribeTable(table = table, rowId = rowId, handler = handler)
    }

    /** Awaitable subscribe — resolves when the server acknowledges (`subscribed` frame). */
    suspend fun subscribeReady(
        rowId: String? = null,
        timeoutMs: Int = 5000,
        handler: SubscribeHandler,
    ): Unsubscribe {
        return client.subscribeTableReady(
            table = table,
            rowId = rowId,
            timeoutMs = timeoutMs,
            handler = handler,
        )
    }

    private fun encodeQueryComponent(value: String): String {
        return URLEncoder.encode(value, StandardCharsets.UTF_8.name())
            .replace("+", "%20")
    }
}
