package com.loomup.client

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import kotlin.io.path.createTempFile
import kotlin.test.Test
import kotlin.test.assertEquals

@Serializable
private data class OfflineFixture(
    val bootstrap: SyncBootstrapResponse,
    @SerialName("offline_mutations") val offlineMutations: List<SyncMutation>,
    @SerialName("mutation_response") val mutationResponse: SyncMutationResponse,
    val pull: SyncPullResponse,
    val expected: Expected,
) {
    @Serializable data class Expected(val cursor: Long, val pending: Int, val conflicts: Int, val ids: List<String>)
}

private class FixtureSyncTransport(private val fixture: OfflineFixture) : SyncTransport {
    override suspend fun syncBootstrap(resources: List<String>, clientId: String) = fixture.bootstrap
    override suspend fun syncPull(cursor: Long, resources: List<String>, clientId: String) = fixture.pull
    override suspend fun syncMutations(mutations: List<SyncMutation>) = SyncMutationResponse(
        1, fixture.mutationResponse.results.filter { it.mutationId == mutations.single().id },
    )
}

class OfflineStoreTest {
    @Test
    fun sqliteStoragePersistsState() = runBlocking {
        val file = createTempFile("loomup-", ".sqlite").toFile()
        try {
            SQLiteSyncStorage(file).use { storage ->
                storage.setItem("state", "durable")
                assertEquals("durable", storage.getItem("state"))
                storage.removeItem("state")
                assertEquals(null, storage.getItem("state"))
            }
        } finally { file.delete() }
    }

    @Test
    fun sharedOfflineV1QueueReconnectConformance() = runBlocking {
        val fixture = Json { ignoreUnknownKeys = true }.decodeFromString<OfflineFixture>(
            File("../../conformance/offline-v1.json").readText(),
        )
        val store = OfflineStore.open(FixtureSyncTransport(fixture), listOf("items"))

        store.setOnline(false)
        val create = fixture.offlineMutations[0]
        store.create(create.resource, create.data!!, create.recordId, create.id)
        val update = fixture.offlineMutations[1]
        store.update(update.resource, update.recordId!!, update.data!!, update.id)
        assertEquals(2, store.status.value.pending)
        assertEquals(OfflinePhase.OFFLINE, store.status.value.phase)

        store.setOnline(true)
        assertEquals(fixture.expected.cursor, store.status.value.cursor)
        assertEquals(fixture.expected.pending, store.status.value.pending)
        assertEquals(fixture.expected.conflicts, store.status.value.conflicts)
        assertEquals(fixture.expected.ids.sorted(), store.find("items").mapNotNull { it["id"]?.stringValue }.sorted())
    }
}
