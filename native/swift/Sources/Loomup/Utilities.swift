import Foundation

/// Join base URL with a path (path may be absolute-looking `/api/...`).
public func joinURL(base: URL, path: String) -> URL {
    let trimmedBase = base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let p = path.hasPrefix("/") ? path : "/\(path)"
    return URL(string: trimmedBase + p)!
}

/**
 Subscription keys are `table` or `table#rowId`. Split only on the first `#`
 so row IDs that themselves contain `#` round-trip correctly.
 */
public func parseSubKey(_ key: String) -> (table: String, rowId: String?) {
    if let idx = key.firstIndex(of: "#") {
        let table = String(key[..<idx])
        let rowId = String(key[key.index(after: idx)...])
        return (table, rowId)
    }
    return (key, nil)
}

public func makeSubKey(table: String, rowId: String? = nil) -> String {
    if let rowId, !rowId.isEmpty {
        return "\(table)#\(rowId)"
    }
    return table
}

func encodeURIComponent(_ value: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
}

func realtimeWebSocketURL(from httpBase: URL) -> URL {
    var components = URLComponents(url: httpBase, resolvingAgainstBaseURL: false)!
    switch components.scheme?.lowercased() {
    case "https":
        components.scheme = "wss"
    default:
        components.scheme = "ws"
    }
    components.path = "/realtime"
    components.query = nil
    components.fragment = nil
    return components.url!
}

func unixSecondsNow() -> Int64 {
    Int64(Date().timeIntervalSince1970)
}

func makeRequestId(table: String) -> String {
    let rand = String(UUID().uuidString.prefix(8)).lowercased()
    return "sub_\(table)_\(Int(Date().timeIntervalSince1970 * 1000))_\(rand)"
}
