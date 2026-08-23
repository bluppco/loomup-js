import Foundation

public struct OperationMeta: Codable, Sendable, Equatable {
    public var operation: String
    public var database: String
    public var durationMs: UInt64
    public var contract: String
    public var rows: Int?
    public var replayed: Bool?

    enum CodingKeys: String, CodingKey {
        case operation, database, contract, rows, replayed
        case durationMs = "duration_ms"
    }
}

public struct OperationResponse<Output: Decodable>: Decodable {
    public var data: Output
    public var meta: OperationMeta
}

public struct BatchItemResult<Output: Decodable>: Decodable {
    public var index: Int
    public var status: String
    public var data: Output?
    public var error: String?
}

private struct CommandBatchBody<Element: Encodable>: Encodable {
    let items: [Element]
}
private struct JobEnqueueBody<Element: Encodable>: Encodable { let payload: Element; let run_at: Int64? }
private struct JobIdResponse: Decodable { let id: String }
private struct JobClaimBody: Encodable { let worker_id: String; let lease_seconds: UInt64 }
private struct JobHeartbeatBody: Encodable { let worker_id: String; let lease_seconds: UInt64 }
private struct JobCompleteBody<Element: Encodable>: Encodable { let worker_id: String; let result: Element }
private struct JobFailureBody: Encodable { let worker_id: String; let error: String }

public struct JobLease<Payload: Decodable>: Decodable {
    public let id: String
    public let job: String
    public let payload: Payload
    public let attempt: UInt32
    public let maxAttempts: UInt32
    public let leaseExpiresAt: Int64

    enum CodingKeys: String, CodingKey {
        case id, job, payload, attempt
        case maxAttempts = "max_attempts"
        case leaseExpiresAt = "lease_expires_at"
    }
}

extension LoomupClient {
    public struct SearchInput: Codable, Sendable {
        public let query: String
        public let limit: Int?
        public let offset: Int?

        public init(query: String, limit: Int? = nil, offset: Int? = nil) {
            self.query = query
            self.limit = limit
            self.offset = offset
        }
    }

    /// Execute a manifest-declared read-only query.
    public func query<Input: Encodable, Output: Decodable>(
        _ name: String,
        input: Input,
        as output: Output.Type = Output.self
    ) async throws -> OperationResponse<Output> {
        try await requestJSON(
            method: "POST",
            path: "/api/queries/\(encodeURIComponent(name))",
            body: JSONEncoder().encode(input)
        )
    }

    /// Execute a manifest-declared transactional command.
    public func command<Input: Encodable, Output: Decodable>(
        _ name: String,
        input: Input,
        idempotencyKey: String? = nil,
        as output: Output.Type = Output.self
    ) async throws -> OperationResponse<Output> {
        let headers = idempotencyKey.map { ["Idempotency-Key": $0] } ?? [:]
        return try await requestJSON(
            method: "POST",
            path: "/api/commands/\(encodeURIComponent(name))",
            body: JSONEncoder().encode(input),
            extraHeaders: headers
        )
    }

    /// Execute a bounded command batch when enabled by the manifest.
    public func commandBatch<Input: Encodable, Output: Decodable>(
        _ name: String,
        items: [Input],
        idempotencyKey: String? = nil,
        as output: Output.Type = Output.self
    ) async throws -> OperationResponse<[BatchItemResult<Output>]> {
        let headers = idempotencyKey.map { ["Idempotency-Key": $0] } ?? [:]
        return try await requestJSON(
            method: "POST",
            path: "/api/commands/\(encodeURIComponent(name))/batch",
            body: JSONEncoder().encode(CommandBatchBody(items: items)),
            extraHeaders: headers
        )
    }

    public func search<Output: Decodable>(
        _ name: String,
        input: SearchInput,
        as output: Output.Type = Output.self
    ) async throws -> OperationResponse<[Output]> {
        try await requestJSON(
            method: "POST",
            path: "/api/search/\(encodeURIComponent(name))",
            body: JSONEncoder().encode(input)
        )
    }

    public func enqueueJob<Payload: Encodable>(
        _ name: String,
        payload: Payload,
        runAt: Int64? = nil
    ) async throws -> String {
        let response: DataEnvelope<JobIdResponse> = try await requestJSON(
            method: "POST",
            path: "/api/jobs/\(encodeURIComponent(name))/enqueue",
            body: JSONEncoder().encode(JobEnqueueBody(payload: payload, run_at: runAt))
        )
        return response.data.id
    }

    public func claimJob<Payload: Decodable>(
        workerId: String,
        leaseSeconds: UInt64 = 60,
        as payload: Payload.Type = Payload.self
    ) async throws -> JobLease<Payload>? {
        let response: DataEnvelope<JobLease<Payload>?> = try await requestJSON(
            method: "POST",
            path: "/api/jobs/claim",
            body: JSONEncoder().encode(JobClaimBody(worker_id: workerId, lease_seconds: leaseSeconds))
        )
        return response.data
    }

    public func heartbeatJob(_ id: String, workerId: String, leaseSeconds: UInt64 = 60) async throws {
        _ = try await request(
            method: "POST",
            path: "/api/jobs/\(encodeURIComponent(id))/heartbeat",
            body: JSONEncoder().encode(JobHeartbeatBody(worker_id: workerId, lease_seconds: leaseSeconds))
        )
    }

    public func completeJob<Result: Encodable>(_ id: String, workerId: String, result: Result) async throws {
        _ = try await request(
            method: "POST",
            path: "/api/jobs/\(encodeURIComponent(id))/complete",
            body: JSONEncoder().encode(JobCompleteBody(worker_id: workerId, result: result))
        )
    }

    public func failJob(_ id: String, workerId: String, error: String) async throws {
        _ = try await request(
            method: "POST",
            path: "/api/jobs/\(encodeURIComponent(id))/fail",
            body: JSONEncoder().encode(JobFailureBody(worker_id: workerId, error: error))
        )
    }
}
