import XCTest
@testable import Loomup

private struct OfflineFixture: Decodable {
    let bootstrap: SyncBootstrapResponse
    let offlineMutations: [SyncMutation]
    let mutationResponse: SyncMutationResponse
    let pull: SyncPullResponse
    let expected: Expected
    struct Expected: Decodable { let cursor: Int64; let pending: Int; let conflicts: Int; let ids: [String] }
    enum CodingKeys: String, CodingKey {
        case bootstrap, pull, expected
        case offlineMutations = "offline_mutations"
        case mutationResponse = "mutation_response"
    }
}

private actor FixtureSyncTransport: SyncTransport {
    let fixture: OfflineFixture
    init(_ fixture: OfflineFixture) { self.fixture = fixture }
    func syncBootstrap(resources: [String], clientId: String) async throws -> SyncBootstrapResponse { fixture.bootstrap }
    func syncPull(cursor: Int64, resources: [String], clientId: String) async throws -> SyncPullResponse { fixture.pull }
    func syncMutations(_ mutations: [SyncMutation]) async throws -> SyncMutationResponse {
        SyncMutationResponse(protocolVersion: 1, results: fixture.mutationResponse.results.filter { $0.mutationId == mutations[0].id })
    }
}

final class OfflineStoreTests: XCTestCase {
#if canImport(SQLite3)
    func testSQLiteStoragePersistsState() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("loomup-\(UUID().uuidString).sqlite")
        defer { try? FileManager.default.removeItem(at: url) }
        let storage = try SQLiteSyncStorage(url: url)
        let value = Data("durable".utf8)
        try await storage.setItem("state", value: value)
        let saved = try await storage.getItem("state")
        XCTAssertEqual(saved, value)
        try await storage.removeItem("state")
        let removed = try await storage.getItem("state")
        XCTAssertNil(removed)
    }
#endif

    func testSharedOfflineV1QueueReconnectConformance() async throws {
        let fixtureURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("conformance/offline-v1.json")
        let fixture = try JSONDecoder().decode(OfflineFixture.self, from: Data(contentsOf: fixtureURL))
        let store = try await OfflineStore.open(transport: FixtureSyncTransport(fixture), resources: ["items"])

        await store.setOnline(false)
        let create = fixture.offlineMutations[0]
        _ = try await store.create(create.resource, data: create.data!, recordId: create.recordId, mutationId: create.id)
        let update = fixture.offlineMutations[1]
        _ = try await store.update(update.resource, id: update.recordId!, patch: update.data!, mutationId: update.id)
        var status = await store.status
        XCTAssertEqual(status.pending, 2)
        XCTAssertEqual(status.phase, .offline)

        await store.setOnline(true)
        status = await store.status
        XCTAssertEqual(status.cursor, fixture.expected.cursor)
        XCTAssertEqual(status.pending, fixture.expected.pending)
        XCTAssertEqual(status.conflicts, fixture.expected.conflicts)
        let ids = try await store.find("items").compactMap { $0["id"]?.stringValue }.sorted()
        XCTAssertEqual(ids, fixture.expected.ids.sorted())
    }
}
