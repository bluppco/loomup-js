#if canImport(SQLite3)
import Foundation
import SQLite3

/// Durable offline state stored in the platform SQLite library.
public actor SQLiteSyncStorage: SyncStorage {
    private var database: OpaquePointer?

    public init(url: URL) throws {
        var handle: OpaquePointer?
        guard sqlite3_open(url.path, &handle) == SQLITE_OK, let handle else {
            if let handle { sqlite3_close(handle) }
            throw LoomupError("failed to open offline SQLite database")
        }
        database = handle
        let sql = """
        CREATE TABLE IF NOT EXISTS loomup_sync_store (
          key TEXT PRIMARY KEY,
          value BLOB NOT NULL,
          updated_at INTEGER NOT NULL
        )
        """
        guard sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK else {
            let message = String(cString: sqlite3_errmsg(handle))
            sqlite3_close(handle); database = nil
            throw LoomupError("failed to initialize offline SQLite database: \(message)")
        }
    }

    deinit { if let database { sqlite3_close(database) } }

    public func getItem(_ key: String) throws -> Data? {
        let statement = try prepare("SELECT value FROM loomup_sync_store WHERE key = ?")
        defer { sqlite3_finalize(statement) }
        try bind(key, at: 1, to: statement)
        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
        let count = Int(sqlite3_column_bytes(statement, 0))
        guard count > 0, let bytes = sqlite3_column_blob(statement, 0) else { return Data() }
        return Data(bytes: bytes, count: count)
    }

    public func setItem(_ key: String, value: Data) throws {
        let statement = try prepare("""
        INSERT INTO loomup_sync_store(key,value,updated_at) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
        """)
        defer { sqlite3_finalize(statement) }
        try bind(key, at: 1, to: statement)
        let result = value.withUnsafeBytes { bytes in
            sqlite3_bind_blob(statement, 2, bytes.baseAddress, Int32(bytes.count), sqliteTransient)
        }
        guard result == SQLITE_OK else { throw databaseError() }
        sqlite3_bind_int64(statement, 3, Int64(Date().timeIntervalSince1970))
        guard sqlite3_step(statement) == SQLITE_DONE else { throw databaseError() }
    }

    public func removeItem(_ key: String) throws {
        let statement = try prepare("DELETE FROM loomup_sync_store WHERE key = ?")
        defer { sqlite3_finalize(statement) }
        try bind(key, at: 1, to: statement)
        guard sqlite3_step(statement) == SQLITE_DONE else { throw databaseError() }
    }

    private var sqliteTransient: sqlite3_destructor_type {
        unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    }

    private func prepare(_ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw databaseError()
        }
        return statement
    }

    private func bind(_ value: String, at index: Int32, to statement: OpaquePointer) throws {
        guard sqlite3_bind_text(statement, index, value, -1, sqliteTransient) == SQLITE_OK else {
            throw databaseError()
        }
    }

    private func databaseError() -> LoomupError {
        LoomupError(database.map { String(cString: sqlite3_errmsg($0)) } ?? "offline SQLite error")
    }
}
#endif
