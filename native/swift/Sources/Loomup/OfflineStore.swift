import Foundation

public protocol SyncStorage: Sendable {
    func getItem(_ key: String) async throws -> Data?
    func setItem(_ key: String, value: Data) async throws
    func removeItem(_ key: String) async throws
}

public actor MemorySyncStorage: SyncStorage {
    private var values: [String: Data] = [:]
    public init() {}
    public func getItem(_ key: String) -> Data? { values[key] }
    public func setItem(_ key: String, value: Data) { values[key] = value }
    public func removeItem(_ key: String) { values.removeValue(forKey: key) }
}

public struct OfflineStatus: Sendable, Equatable {
    public enum Phase: String, Sendable { case idle, syncing, offline, conflict, error }
    public var phase: Phase
    public var online: Bool
    public var cursor: Int64
    public var pending: Int
    public var conflicts: Int
    public var lastError: String?
}

public struct OfflineConflict: Codable, Sendable, Equatable {
    public var mutation: SyncMutation
    public var error: SyncMutationError
}

private struct LocalRecord: Codable, Sendable {
    var data: [String: JSONValue]
    var version: Int64
}

private struct OfflineState: Codable, Sendable {
    var format = 1
    var clientId = UUID().uuidString
    var schemaVersion = ""
    var cursor: Int64 = 0
    var rows: [String: [String: LocalRecord]] = [:]
    var pending: [SyncMutation] = []
    var conflicts: [OfflineConflict] = []
}

public actor OfflineStore {
    private let transport: SyncTransport
    private let resources: [String]
    private let storage: SyncStorage
    private let storageKey: String
    private let primaryKeys: [String: String]
    private var state: OfflineState
    private var phase: OfflineStatus.Phase
    private var online: Bool
    private var lastError: String?
    private var continuations: [UUID: AsyncStream<OfflineStatus>.Continuation] = [:]
    private var realtimeUnsubscribes: [Unsubscribe] = []

    private init(
        transport: SyncTransport,
        resources: [String],
        storage: SyncStorage,
        storageKey: String,
        primaryKeys: [String: String],
        state: OfflineState,
        online: Bool
    ) {
        self.transport = transport
        self.resources = resources
        self.storage = storage
        self.storageKey = storageKey
        self.primaryKeys = primaryKeys
        self.state = state
        self.online = online
        phase = online ? .idle : .offline
    }

    public static func open(
        transport: SyncTransport,
        resources: [String],
        storage: SyncStorage = MemorySyncStorage(),
        storageKey: String = "loomup.sync.v1",
        primaryKeys: [String: String] = [:],
        online: Bool = true
    ) async throws -> OfflineStore {
        guard !resources.isEmpty else { throw LoomupError("OfflineStore requires resources") }
        let saved = try await storage.getItem(storageKey)
        let state = saved.flatMap { try? JSONDecoder().decode(OfflineState.self, from: $0) } ?? OfflineState()
        let store = OfflineStore(
            transport: transport, resources: Array(Set(resources)).sorted(), storage: storage,
            storageKey: storageKey, primaryKeys: primaryKeys, state: state, online: online
        )
        if online { await store.sync() }
        return store
    }

    public var status: OfflineStatus {
        OfflineStatus(
            phase: phase, online: online, cursor: state.cursor, pending: state.pending.count,
            conflicts: state.conflicts.count, lastError: lastError
        )
    }

    public var conflicts: [OfflineConflict] { state.conflicts }

    public func statusStream() -> AsyncStream<OfflineStatus> {
        let id = UUID()
        return AsyncStream { continuation in
            continuations[id] = continuation
            continuation.yield(status)
            continuation.onTermination = { [weak self] _ in Task { await self?.removeContinuation(id) } }
        }
    }

    private func removeContinuation(_ id: UUID) { continuations.removeValue(forKey: id) }
    private func notify() { for continuation in continuations.values { continuation.yield(status) } }
    private func persist() async throws { try await storage.setItem(storageKey, value: JSONEncoder().encode(state)) }
    private func pk(_ resource: String) -> String { primaryKeys[resource] ?? "id" }
    private func require(_ resource: String) throws {
        if !resources.contains(resource) { throw LoomupError("resource \(resource) is not synchronized") }
    }

    public func find(_ resource: String) throws -> [[String: JSONValue]] {
        try require(resource)
        return (state.rows[resource] ?? [:]).values.map(\.data)
    }

    public func get(_ resource: String, id: String) throws -> [String: JSONValue]? {
        try require(resource)
        return state.rows[resource]?[id]?.data
    }

    @discardableResult
    public func create(
        _ resource: String,
        data: [String: JSONValue],
        recordId: String? = nil,
        mutationId: String = UUID().uuidString
    ) async throws -> [String: JSONValue] {
        try require(resource)
        let id = recordId ?? data[pk(resource)]?.stringValue ?? UUID().uuidString
        var row = data; row[pk(resource)] = .string(id)
        state.rows[resource, default: [:]][id] = LocalRecord(data: row, version: 0)
        state.pending.append(SyncMutation(id: mutationId, resource: resource, operation: "create", recordId: id, data: row))
        try await persist(); notify()
        if online { await sync() }
        return row
    }

    @discardableResult
    public func update(
        _ resource: String, id: String, patch: [String: JSONValue],
        mutationId: String = UUID().uuidString
    ) async throws -> [String: JSONValue] {
        try require(resource)
        guard var record = state.rows[resource]?[id] else { throw LoomupError("local record not found") }
        record.data.merge(patch) { _, new in new }
        state.rows[resource]?[id] = record
        state.pending.append(SyncMutation(
            id: mutationId, resource: resource, operation: "update", recordId: id,
            data: patch, baseSequence: record.version
        ))
        try await persist(); notify()
        if online { await sync() }
        return record.data
    }

    public func remove(
        _ resource: String, id: String, mutationId: String = UUID().uuidString
    ) async throws {
        try require(resource)
        guard let record = state.rows[resource]?[id] else { throw LoomupError("local record not found") }
        state.rows[resource]?.removeValue(forKey: id)
        state.pending.append(SyncMutation(
            id: mutationId, resource: resource, operation: "delete", recordId: id,
            baseSequence: record.version
        ))
        try await persist(); notify()
        if online { await sync() }
    }

    public func setOnline(_ value: Bool) async {
        online = value; phase = value ? .idle : .offline; notify()
        if value { await sync() }
    }

    public func sync() async {
        guard online else { phase = .offline; notify(); return }
        phase = .syncing; lastError = nil; notify()
        do {
            if state.schemaVersion.isEmpty { try await bootstrap() }
            while let mutation = state.pending.first {
                let response = try await transport.syncMutations([mutation])
                guard let result = response.results.first else { throw LoomupError("empty mutation response") }
                if result.status == "acknowledged", let sequence = result.sequence {
                    state.pending.removeFirst()
                    if let id = mutation.recordId {
                        if mutation.operation == "delete" { state.rows[mutation.resource]?.removeValue(forKey: id) }
                        else if let row = result.record { state.rows[mutation.resource, default: [:]][id] = LocalRecord(data: row, version: sequence) }
                    }
                } else if result.status == "conflict" || result.status == "rejected" {
                    state.pending.removeFirst()
                    state.conflicts.append(OfflineConflict(
                        mutation: mutation,
                        error: result.error ?? SyncMutationError(code: "conflict", message: "mutation rejected")
                    ))
                    break
                } else { break }
            }
            if state.conflicts.isEmpty { try await pullAll() }
            try await persist()
            phase = state.conflicts.isEmpty ? .idle : .conflict
        } catch let error as LoomupError where error.code == "reset_required" {
            do {
                try await bootstrap()
                try await persist()
                phase = state.conflicts.isEmpty ? .idle : .conflict
            } catch {
                phase = .error; lastError = String(describing: error)
            }
        } catch {
            phase = .error; lastError = String(describing: error)
        }
        notify()
    }

    /// Pull whenever Loomup realtime reports that a synchronized resource changed.
    public func startRealtime(client: LoomupClient) {
        stopRealtime()
        realtimeUnsubscribes = resources.map { resource in
            client.from(resource).subscribe { [weak self] _ in
                Task { await self?.sync() }
            }
        }
    }

    public func stopRealtime() {
        realtimeUnsubscribes.forEach { $0() }
        realtimeUnsubscribes.removeAll()
    }

    public func close() {
        stopRealtime()
        continuations.values.forEach { $0.finish() }
        continuations.removeAll()
    }

    private func bootstrap() async throws {
        let response = try await transport.syncBootstrap(resources: resources, clientId: state.clientId)
        var rows: [String: [String: LocalRecord]] = [:]
        for resource in resources {
            for record in response.resources[resource]?.records ?? [] {
                guard let id = record.data[pk(resource)]?.stringValue else { continue }
                rows[resource, default: [:]][id] = LocalRecord(data: record.data, version: record.version)
            }
        }
        state.rows = rows; state.cursor = response.cursor; state.schemaVersion = response.schemaVersion
        applyOptimisticPending()
    }

    private func applyOptimisticPending() {
        for mutation in state.pending {
            guard let id = mutation.recordId else { continue }
            if mutation.operation == "delete" { state.rows[mutation.resource]?.removeValue(forKey: id); continue }
            if mutation.operation == "create", let data = mutation.data {
                state.rows[mutation.resource, default: [:]][id] = LocalRecord(data: data, version: 0)
            } else if mutation.operation == "update", let patch = mutation.data, var record = state.rows[mutation.resource]?[id] {
                record.data.merge(patch) { _, new in new }; state.rows[mutation.resource]?[id] = record
            }
        }
    }

    private func pullAll() async throws {
        while true {
            let response = try await transport.syncPull(cursor: state.cursor, resources: resources, clientId: state.clientId)
            if !state.schemaVersion.isEmpty, response.schemaVersion != state.schemaVersion { try await bootstrap(); return }
            for event in response.events {
                let current = state.rows[event.resource]?[event.recordId]
                if let current, current.version >= event.sequence { continue }
                if event.operation == "DELETE" || event.after == nil { state.rows[event.resource]?.removeValue(forKey: event.recordId) }
                else { state.rows[event.resource, default: [:]][event.recordId] = LocalRecord(data: event.after!, version: event.sequence) }
            }
            state.cursor = response.cursor; state.schemaVersion = response.schemaVersion
            if !response.hasMore { break }
        }
    }
}

public extension LoomupClient {
    func offline(
        resources: [String], storage: SyncStorage = MemorySyncStorage(), storageKey: String = "loomup.sync.v1",
        primaryKeys: [String: String] = [:], online: Bool = true
    ) async throws -> OfflineStore {
        let store = try await OfflineStore.open(
            transport: self, resources: resources, storage: storage,
            storageKey: storageKey, primaryKeys: primaryKeys, online: online
        )
        await store.startRealtime(client: self)
        return store
    }
}
