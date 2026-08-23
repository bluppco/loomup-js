import Foundation

public struct SyncRecord: Codable, Sendable, Equatable {
    public var data: [String: JSONValue]
    public var version: Int64
    public init(data: [String: JSONValue], version: Int64) { self.data = data; self.version = version }
}

public struct SyncResourceSnapshot: Codable, Sendable, Equatable {
    public var records: [SyncRecord]
    public init(records: [SyncRecord] = []) { self.records = records }
}

public struct SyncBootstrapResponse: Codable, Sendable, Equatable {
    public var protocolVersion: Int
    public var schemaVersion: String
    public var cursor: Int64
    public var resources: [String: SyncResourceSnapshot]

    public init(protocolVersion: Int = 1, schemaVersion: String, cursor: Int64, resources: [String: SyncResourceSnapshot]) {
        self.protocolVersion = protocolVersion; self.schemaVersion = schemaVersion; self.cursor = cursor; self.resources = resources
    }

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol_version"
        case schemaVersion = "schema_version"
        case cursor, resources
    }
}

public struct SyncEvent: Codable, Sendable, Equatable {
    public var sequence: Int64
    public var eventId: String
    public var resource: String
    public var recordId: String
    public var operation: String
    public var before: [String: JSONValue]?
    public var after: [String: JSONValue]?
    public var actorId: String?
    public var origin: String
    public var committedAt: Int64
    public var schemaVersion: Int64

    public init(sequence: Int64, eventId: String, resource: String, recordId: String, operation: String,
                before: [String: JSONValue]? = nil, after: [String: JSONValue]? = nil, actorId: String? = nil,
                origin: String, committedAt: Int64, schemaVersion: Int64) {
        self.sequence = sequence; self.eventId = eventId; self.resource = resource; self.recordId = recordId
        self.operation = operation; self.before = before; self.after = after; self.actorId = actorId
        self.origin = origin; self.committedAt = committedAt; self.schemaVersion = schemaVersion
    }

    enum CodingKeys: String, CodingKey {
        case sequence, resource, operation, before, after, origin
        case eventId = "event_id"
        case recordId = "record_id"
        case actorId = "actor_id"
        case committedAt = "committed_at"
        case schemaVersion = "schema_version"
    }
}

public struct SyncPullResponse: Codable, Sendable, Equatable {
    public var protocolVersion: Int
    public var schemaVersion: String
    public var cursor: Int64
    public var hasMore: Bool
    public var events: [SyncEvent]

    public init(protocolVersion: Int = 1, schemaVersion: String, cursor: Int64, hasMore: Bool, events: [SyncEvent]) {
        self.protocolVersion = protocolVersion; self.schemaVersion = schemaVersion; self.cursor = cursor
        self.hasMore = hasMore; self.events = events
    }

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol_version"
        case schemaVersion = "schema_version"
        case cursor, events
        case hasMore = "has_more"
    }
}

public struct SyncMutation: Codable, Sendable, Equatable {
    public var id: String
    public var resource: String
    public var operation: String
    public var recordId: String?
    public var data: [String: JSONValue]?
    public var baseSequence: Int64?

    public init(
        id: String = UUID().uuidString,
        resource: String,
        operation: String,
        recordId: String? = nil,
        data: [String: JSONValue]? = nil,
        baseSequence: Int64? = nil
    ) {
        self.id = id
        self.resource = resource
        self.operation = operation
        self.recordId = recordId
        self.data = data
        self.baseSequence = baseSequence
    }

    enum CodingKeys: String, CodingKey {
        case id, resource, operation, data
        case recordId = "record_id"
        case baseSequence = "base_sequence"
    }
}

public struct SyncMutationError: Codable, Sendable, Equatable {
    public var code: String
    public var message: String
    public var details: [String: JSONValue]?
    public init(code: String, message: String, details: [String: JSONValue]? = nil) {
        self.code = code; self.message = message; self.details = details
    }
}

public struct SyncMutationResult: Codable, Sendable, Equatable {
    public var mutationId: String
    public var status: String
    public var record: [String: JSONValue]?
    public var sequence: Int64?
    public var error: SyncMutationError?

    public init(mutationId: String, status: String, record: [String: JSONValue]? = nil,
                sequence: Int64? = nil, error: SyncMutationError? = nil) {
        self.mutationId = mutationId; self.status = status; self.record = record
        self.sequence = sequence; self.error = error
    }

    enum CodingKeys: String, CodingKey {
        case mutationId = "mutation_id"
        case status, record, sequence, error
    }
}

public struct SyncMutationResponse: Codable, Sendable, Equatable {
    public var protocolVersion: Int
    public var results: [SyncMutationResult]

    public init(protocolVersion: Int = 1, results: [SyncMutationResult]) {
        self.protocolVersion = protocolVersion; self.results = results
    }

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol_version"
        case results
    }
}

public protocol SyncTransport: Sendable {
    func syncBootstrap(resources: [String], clientId: String) async throws -> SyncBootstrapResponse
    func syncPull(cursor: Int64, resources: [String], clientId: String) async throws -> SyncPullResponse
    func syncMutations(_ mutations: [SyncMutation]) async throws -> SyncMutationResponse
}

extension LoomupClient: SyncTransport {
    public func syncBootstrap(resources: [String], clientId: String) async throws -> SyncBootstrapResponse {
        let query = "resources=\(encodeURIComponent(resources.joined(separator: ",")))&client_id=\(encodeURIComponent(clientId))&protocol_version=1"
        let envelope: DataEnvelope<SyncBootstrapResponse> = try await requestJSON(
            method: "GET", path: "/sync/v1/bootstrap?\(query)"
        )
        return envelope.data
    }

    public func syncPull(cursor: Int64, resources: [String], clientId: String) async throws -> SyncPullResponse {
        let query = "resources=\(encodeURIComponent(resources.joined(separator: ",")))&cursor=\(cursor)&client_id=\(encodeURIComponent(clientId))&protocol_version=1"
        let envelope: DataEnvelope<SyncPullResponse> = try await requestJSON(
            method: "GET", path: "/sync/v1/pull?\(query)"
        )
        return envelope.data
    }

    public func syncMutations(_ mutations: [SyncMutation]) async throws -> SyncMutationResponse {
        struct Body: Encodable { let protocolVersion = 1; let mutations: [SyncMutation]
            enum CodingKeys: String, CodingKey { case protocolVersion = "protocol_version", mutations }
        }
        let body = try JSONEncoder().encode(Body(mutations: mutations))
        let envelope: DataEnvelope<SyncMutationResponse> = try await requestJSON(
            method: "POST", path: "/sync/v1/mutations", body: body
        )
        return envelope.data
    }
}
