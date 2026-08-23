import Foundation

/// Fluent table accessor: CRUD + realtime for one table name.
public struct TableQuery: Sendable {
    private let client: LoomupClient
    private let table: String

    init(client: LoomupClient, table: String) {
        self.client = client
        self.table = table
    }

    public func select(
        where whereClause: [String: WhereValue]? = nil,
        filter: [String: [String: WhereValue]]? = nil,
        select: [String]? = nil,
        sort: String? = nil,
        limit: Int? = nil,
        offset: Int? = nil,
        cursor: String? = nil
    ) async throws -> ListResult {
        var items: [URLQueryItem] = []
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        if let limit { items.append(URLQueryItem(name: "limit", value: String(limit))) }
        if let offset { items.append(URLQueryItem(name: "offset", value: String(offset))) }
        if let sort { items.append(URLQueryItem(name: "sort", value: sort)) }
        if let select, !select.isEmpty {
            items.append(URLQueryItem(name: "select", value: select.joined(separator: ",")))
        }
        if let whereClause {
            for (k, v) in whereClause {
                items.append(URLQueryItem(name: "where[\(k)]", value: v.queryString))
            }
        }
        if let filter {
            for (field, operations) in filter {
                for (operation, value) in operations {
                    let wireOperation: String
                    switch operation {
                    case "isNull": wireOperation = "is_null"
                    case "startsWith": wireOperation = "starts_with"
                    default: wireOperation = operation
                    }
                    items.append(URLQueryItem(
                        name: "filter[\(field)][\(wireOperation)]",
                        value: value.queryString
                    ))
                }
            }
        }

        var path = "/api/\(encodeURIComponent(table))"
        if !items.isEmpty {
            var components = URLComponents()
            components.queryItems = items
            if let q = components.percentEncodedQuery {
                path += "?\(q)"
            }
        }

        let env: ListEnvelope = try await client.requestJSON(method: "GET", path: path)
        return ListResult(data: env.data, meta: env.meta)
    }

    public func get(_ id: String) async throws -> [String: JSONValue] {
        let path = "/api/\(encodeURIComponent(table))/\(encodeURIComponent(id))"
        let env: DataEnvelope<[String: JSONValue]> = try await client.requestJSON(
            method: "GET",
            path: path
        )
        return env.data
    }

    public func get(_ id: Int) async throws -> [String: JSONValue] {
        try await get(String(id))
    }

    public func insert(_ row: [String: JSONValue]) async throws -> [String: JSONValue] {
        let body = try JSONEncoder().encode(row)
        let path = "/api/\(encodeURIComponent(table))"
        let env: DataEnvelope<[String: JSONValue]> = try await client.requestJSON(
            method: "POST",
            path: path,
            body: body
        )
        return env.data
    }

    public func update(_ id: String, patch: [String: JSONValue]) async throws -> [String: JSONValue] {
        let body = try JSONEncoder().encode(patch)
        let path = "/api/\(encodeURIComponent(table))/\(encodeURIComponent(id))"
        let env: DataEnvelope<[String: JSONValue]> = try await client.requestJSON(
            method: "PATCH",
            path: path,
            body: body
        )
        return env.data
    }

    public func update(_ id: Int, patch: [String: JSONValue]) async throws -> [String: JSONValue] {
        try await update(String(id), patch: patch)
    }

    public func delete(_ id: String) async throws -> [String: JSONValue] {
        let path = "/api/\(encodeURIComponent(table))/\(encodeURIComponent(id))"
        let env: DataEnvelope<[String: JSONValue]> = try await client.requestJSON(
            method: "DELETE",
            path: path
        )
        return env.data
    }

    public func delete(_ id: Int) async throws -> [String: JSONValue] {
        try await delete(String(id))
    }

    @discardableResult
    public func subscribe(
        rowId: String? = nil,
        handler: @escaping SubscribeHandler
    ) -> Unsubscribe {
        client.subscribeTable(table: table, rowId: rowId, handler: handler)
    }

    /// Awaitable subscribe — resolves when the server acknowledges (`subscribed` frame).
    public func subscribeReady(
        rowId: String? = nil,
        timeoutMs: Int = 5000,
        handler: @escaping SubscribeHandler
    ) async throws -> Unsubscribe {
        try await client.subscribeTableReady(
            table: table,
            rowId: rowId,
            timeoutMs: timeoutMs,
            handler: handler
        )
    }
}
