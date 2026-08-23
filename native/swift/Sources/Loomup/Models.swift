import Foundation

/// Error thrown by the Loomup client for HTTP and protocol failures.
public struct LoomupError: Error, Equatable, Sendable, LocalizedError {
    public var message: String
    public var code: String?
    public var status: Int?

    public init(_ message: String, code: String? = nil, status: Int? = nil) {
        self.message = message
        self.code = code
        self.status = status
    }

    public var errorDescription: String? { message }
}

public struct User: Codable, Sendable, Equatable {
    public var id: String
    public var email: String
    public var role: String
    public var disabled: Bool
    public var createdAt: Int64

    public init(
        id: String,
        email: String,
        role: String,
        disabled: Bool,
        createdAt: Int64
    ) {
        self.id = id
        self.email = email
        self.role = role
        self.disabled = disabled
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey {
        case id, email, role, disabled
        case createdAt = "created_at"
    }
}

/// Object metadata from `/storage/v1`.
public struct StorageObject: Codable, Sendable, Equatable {
    public var id: String
    public var bucket: String
    public var path: String
    public var name: String
    public var ownerId: String?
    public var contentType: String?
    public var size: Int64
    public var etag: String?
    public var createdAt: Int64
    public var updatedAt: Int64

    enum CodingKeys: String, CodingKey {
        case id, bucket, path, name, size, etag
        case ownerId = "owner_id"
        case contentType = "content_type"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

public struct StorageBucketInfo: Codable, Sendable, Equatable {
    public var name: String
    public var `public`: Bool
}

/// Registered push device (`POST /push/devices`).
public struct PushDevice: Codable, Sendable, Equatable {
    public var id: String
    public var userId: String
    public var token: String
    public var provider: String
    public var platform: String?
    public var deviceId: String?
    public var appVersion: String?
    public var locale: String?
    public var createdAt: Int64
    public var updatedAt: Int64
    public var lastSeenAt: Int64?
    public var disabled: Bool
    public var disabledReason: String?

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case token
        case provider
        case platform
        case deviceId = "device_id"
        case appVersion = "app_version"
        case locale
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case lastSeenAt = "last_seen_at"
        case disabled
        case disabledReason = "disabled_reason"
    }
}

public struct AuthTokens: Codable, Sendable, Equatable {
    public var accessToken: String
    public var refreshToken: String
    public var tokenType: String
    public var expiresIn: Int
    public var user: User?

    public init(
        accessToken: String,
        refreshToken: String,
        tokenType: String,
        expiresIn: Int,
        user: User? = nil
    ) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.tokenType = tokenType
        self.expiresIn = expiresIn
        self.user = user
    }

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case tokenType = "token_type"
        case expiresIn = "expires_in"
        case user
    }
}

public struct ListMeta: Codable, Sendable, Equatable {
    public var limit: Int
    public var offset: Int
    public var total: Int
    /// Present when rule-filtered list hit the server scan cap; total is a lower bound.
    public var truncated: Bool?
    /// Signed opaque cursor for the next page. Nil on the final page.
    public var nextCursor: String?

    public init(limit: Int, offset: Int, total: Int, truncated: Bool? = nil, nextCursor: String? = nil) {
        self.limit = limit
        self.offset = offset
        self.total = total
        self.truncated = truncated
        self.nextCursor = nextCursor
    }

    enum CodingKeys: String, CodingKey {
        case limit, offset, total, truncated
        case nextCursor = "next_cursor"
    }
}

public struct ListResult: Sendable, Equatable {
    public var data: [[String: JSONValue]]
    public var meta: ListMeta

    public init(data: [[String: JSONValue]], meta: ListMeta) {
        self.data = data
        self.meta = meta
    }
}

/// Realtime change frame (`type: "change"`).
public struct ChangeEvent: Sendable, Equatable {
    public var type: String
    public var channel: String?
    public var table: String
    public var op: String
    public var id: String
    public var data: [String: JSONValue]?
    /// Unix **seconds** (same unit as server CDC events).
    public var ts: Int64

    public init(
        type: String = "change",
        channel: String? = nil,
        table: String,
        op: String,
        id: String,
        data: [String: JSONValue]? = nil,
        ts: Int64
    ) {
        self.type = type
        self.channel = channel
        self.table = table
        self.op = op
        self.id = id
        self.data = data
        self.ts = ts
    }
}

/// Non-change control frames (auth/subscribe/error).
public struct ControlEvent: Sendable, Equatable {
    public var type: String
    public var requestId: String?
    public var channel: String?
    public var table: String?
    public var message: String?
    public var code: String?
    public var id: String?

    public init(
        type: String,
        requestId: String? = nil,
        channel: String? = nil,
        table: String? = nil,
        message: String? = nil,
        code: String? = nil,
        id: String? = nil
    ) {
        self.type = type
        self.requestId = requestId
        self.channel = channel
        self.table = table
        self.message = message
        self.code = code
        self.id = id
    }
}

public typealias SubscribeHandler = @Sendable (ChangeEvent) -> Void
public typealias ControlHandler = @Sendable (ControlEvent) -> Void
public typealias Unsubscribe = () -> Void

// MARK: - Envelope decoding helpers

struct DataEnvelope<T: Decodable>: Decodable {
    let data: T
}

struct ListEnvelope: Decodable {
    let data: [[String: JSONValue]]
    let meta: ListMeta
}

struct ErrorBody: Decodable {
    struct ErrorDetail: Decodable {
        let code: String?
        let message: String?
    }

    let error: ErrorDetail?
    let message: String?
}
