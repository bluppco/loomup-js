package com.loomup.client

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.sql.DriverManager
import java.util.UUID

interface SyncStorage {
    suspend fun getItem(key: String): String?
    suspend fun setItem(key: String, value: String)
    suspend fun removeItem(key: String)
}

class MemorySyncStorage : SyncStorage {
    private val values = mutableMapOf<String, String>()
    override suspend fun getItem(key: String) = values[key]
    override suspend fun setItem(key: String, value: String) { values[key] = value }
    override suspend fun removeItem(key: String) { values.remove(key) }
}

/** JVM/desktop SQLite persistence; Android can provide the same SyncStorage contract via Room. */
class SQLiteSyncStorage(database: File) : SyncStorage, AutoCloseable {
    private val connection = DriverManager.getConnection("jdbc:sqlite:${database.absolutePath}")
    init { connection.createStatement().use { it.execute("CREATE TABLE IF NOT EXISTS loomup_sync_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)") } }
    override suspend fun getItem(key: String): String? = connection.prepareStatement("SELECT value FROM loomup_sync_store WHERE key=?").use { statement ->
        statement.setString(1, key); statement.executeQuery().use { if (it.next()) it.getString(1) else null }
    }
    override suspend fun setItem(key: String, value: String) {
        connection.prepareStatement("INSERT INTO loomup_sync_store(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").use {
            it.setString(1, key); it.setString(2, value); it.setLong(3, System.currentTimeMillis() / 1000); it.executeUpdate()
        }
    }
    override suspend fun removeItem(key: String) { connection.prepareStatement("DELETE FROM loomup_sync_store WHERE key=?").use { it.setString(1, key); it.executeUpdate() } }
    override fun close() = connection.close()
}

enum class OfflinePhase { IDLE, SYNCING, OFFLINE, CONFLICT, ERROR }
data class OfflineStatus(val phase: OfflinePhase, val online: Boolean, val cursor: Long, val pending: Int, val conflicts: Int, val lastError: String? = null)
@Serializable data class OfflineConflict(val mutation: SyncMutation, val error: SyncMutationError)
@Serializable private data class LocalRecord(val data: Map<String, JsonValue>, val version: Long)
@Serializable private data class PersistedOfflineState(
    val format: Int = 1,
    val clientId: String = UUID.randomUUID().toString(),
    var schemaVersion: String = "",
    var cursor: Long = 0,
    val rows: MutableMap<String, MutableMap<String, LocalRecord>> = mutableMapOf(),
    val pending: MutableList<SyncMutation> = mutableListOf(),
    val conflicts: MutableList<OfflineConflict> = mutableListOf(),
)

class OfflineStore private constructor(
    private val transport: SyncTransport,
    private val resources: List<String>,
    private val storage: SyncStorage,
    private val storageKey: String,
    private val primaryKeys: Map<String, String>,
    private var state: PersistedOfflineState,
    online: Boolean,
) {
    private val mutex = Mutex()
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private var online = online
    private var phase = if (online) OfflinePhase.IDLE else OfflinePhase.OFFLINE
    private var lastError: String? = null
    private val _status = MutableStateFlow(snapshot())
    val status: StateFlow<OfflineStatus> = _status
    private val realtimeScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var realtimeUnsubscribes: List<Unsubscribe> = emptyList()

    private fun snapshot() = OfflineStatus(phase, online, state.cursor, state.pending.size, state.conflicts.size, lastError)
    private fun notifyStatus() { _status.value = snapshot() }
    private suspend fun persist() = storage.setItem(storageKey, json.encodeToString(state))
    private fun pk(resource: String) = primaryKeys[resource] ?: "id"
    private fun requireResource(resource: String) = require(resources.contains(resource)) { "resource $resource is not synchronized" }

    suspend fun find(resource: String): List<Map<String, JsonValue>> = mutex.withLock { requireResource(resource); state.rows[resource]?.values?.map { it.data }.orEmpty() }
    suspend fun get(resource: String, id: String): Map<String, JsonValue>? = mutex.withLock { requireResource(resource); state.rows[resource]?.get(id)?.data }
    suspend fun conflicts(): List<OfflineConflict> = mutex.withLock { state.conflicts.toList() }

    suspend fun create(resource: String, data: Map<String, JsonValue>, recordId: String? = null, mutationId: String = UUID.randomUUID().toString()): Map<String, JsonValue> = mutex.withLock {
        requireResource(resource); val id = recordId ?: data[pk(resource)]?.stringValue ?: UUID.randomUUID().toString()
        val row = data + (pk(resource) to JsonValue.String(id)); state.rows.getOrPut(resource) { mutableMapOf() }[id] = LocalRecord(row, 0)
        state.pending += SyncMutation(mutationId, resource, "create", id, row); persist(); notifyStatus(); if (online) syncLocked(); row
    }
    suspend fun update(resource: String, id: String, patch: Map<String, JsonValue>, mutationId: String = UUID.randomUUID().toString()): Map<String, JsonValue> = mutex.withLock {
        requireResource(resource); val old = state.rows[resource]?.get(id) ?: error("local record not found"); val row = old.data + patch
        state.rows[resource]!![id] = LocalRecord(row, old.version); state.pending += SyncMutation(mutationId, resource, "update", id, patch, old.version)
        persist(); notifyStatus(); if (online) syncLocked(); row
    }
    suspend fun remove(resource: String, id: String, mutationId: String = UUID.randomUUID().toString()) = mutex.withLock {
        requireResource(resource); val old = state.rows[resource]?.remove(id) ?: error("local record not found")
        state.pending += SyncMutation(mutationId, resource, "delete", id, baseSequence = old.version); persist(); notifyStatus(); if (online) syncLocked()
    }
    suspend fun setOnline(value: Boolean) = mutex.withLock { online = value; phase = if (value) OfflinePhase.IDLE else OfflinePhase.OFFLINE; notifyStatus(); if (value) syncLocked() }
    suspend fun sync() = mutex.withLock { syncLocked() }

    /** Pull whenever Loomup realtime reports that a synchronized resource changed. */
    fun startRealtime(client: LoomupClient) {
        stopRealtime()
        realtimeUnsubscribes = resources.map { resource ->
            client.from(resource).subscribe { realtimeScope.launch { sync() } }
        }
    }
    fun stopRealtime() { realtimeUnsubscribes.forEach { it() }; realtimeUnsubscribes = emptyList() }
    fun close() { stopRealtime(); realtimeScope.cancel() }

    private suspend fun syncLocked() {
        if (!online) { phase = OfflinePhase.OFFLINE; notifyStatus(); return }
        phase = OfflinePhase.SYNCING; lastError = null; notifyStatus()
        try {
            if (state.schemaVersion.isEmpty()) bootstrap()
            while (state.pending.isNotEmpty()) {
                val mutation = state.pending.first(); val result = transport.syncMutations(listOf(mutation)).results.first()
                if (result.status == "acknowledged" && result.sequence != null) {
                    state.pending.removeAt(0); mutation.recordId?.let { id -> if (mutation.operation == "delete") state.rows[mutation.resource]?.remove(id) else result.record?.let { state.rows.getOrPut(mutation.resource) { mutableMapOf() }[id] = LocalRecord(it, result.sequence) } }
                } else if (result.status == "conflict" || result.status == "rejected") {
                    state.pending.removeAt(0); state.conflicts += OfflineConflict(mutation, result.error ?: SyncMutationError("conflict", "mutation rejected")); break
                } else break
            }
            if (state.conflicts.isEmpty()) pullAll(); persist(); phase = if (state.conflicts.isEmpty()) OfflinePhase.IDLE else OfflinePhase.CONFLICT
        } catch (error: LoomupError) {
            if (error.code == "reset_required") try { bootstrap(); persist(); phase = if (state.conflicts.isEmpty()) OfflinePhase.IDLE else OfflinePhase.CONFLICT }
            catch (resetError: Exception) { phase = OfflinePhase.ERROR; lastError = resetError.message ?: resetError.toString() }
            else { phase = OfflinePhase.ERROR; lastError = error.message ?: error.toString() }
        } catch (error: Exception) { phase = OfflinePhase.ERROR; lastError = error.message ?: error.toString() }
        notifyStatus()
    }
    private suspend fun bootstrap() {
        val response = transport.syncBootstrap(resources, state.clientId); state.rows.clear()
        resources.forEach { resource -> response.resources[resource]?.records.orEmpty().forEach { record -> record.data[pk(resource)]?.stringValue?.let { state.rows.getOrPut(resource) { mutableMapOf() }[it] = LocalRecord(record.data, record.version) } } }
        state.cursor = response.cursor; state.schemaVersion = response.schemaVersion; applyOptimisticPending()
    }
    private fun applyOptimisticPending() {
        state.pending.forEach { mutation -> mutation.recordId?.let { id ->
            when (mutation.operation) {
                "delete" -> state.rows[mutation.resource]?.remove(id)
                "create" -> mutation.data?.let { state.rows.getOrPut(mutation.resource) { mutableMapOf() }[id] = LocalRecord(it, 0) }
                "update" -> mutation.data?.let { patch -> state.rows[mutation.resource]?.get(id)?.let { state.rows[mutation.resource]!![id] = LocalRecord(it.data + patch, it.version) } }
            }
        } }
    }
    private suspend fun pullAll() { do { val response = transport.syncPull(state.cursor, resources, state.clientId); response.events.forEach { event -> val current = state.rows[event.resource]?.get(event.recordId); if (current == null || current.version < event.sequence) { if (event.operation == "DELETE" || event.after == null) state.rows[event.resource]?.remove(event.recordId) else state.rows.getOrPut(event.resource) { mutableMapOf() }[event.recordId] = LocalRecord(event.after, event.sequence) } }; state.cursor = response.cursor; state.schemaVersion = response.schemaVersion } while (response.hasMore) }

    companion object {
        suspend fun open(transport: SyncTransport, resources: List<String>, storage: SyncStorage = MemorySyncStorage(), storageKey: String = "loomup.sync.v1", primaryKeys: Map<String, String> = emptyMap(), online: Boolean = true): OfflineStore {
            require(resources.isNotEmpty()); val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }; val saved = storage.getItem(storageKey)
            val state = saved?.let { runCatching { json.decodeFromString<PersistedOfflineState>(it) }.getOrNull() } ?: PersistedOfflineState()
            return OfflineStore(transport, resources.distinct().sorted(), storage, storageKey, primaryKeys, state, online).also { if (online) it.sync() }
        }
    }
}

suspend fun LoomupClient.offline(resources: List<String>, storage: SyncStorage = MemorySyncStorage(), storageKey: String = "loomup.sync.v1", primaryKeys: Map<String, String> = emptyMap(), online: Boolean = true): OfflineStore =
    OfflineStore.open(LoomupSyncTransport(this), resources, storage, storageKey, primaryKeys, online).also { it.startRealtime(this) }
