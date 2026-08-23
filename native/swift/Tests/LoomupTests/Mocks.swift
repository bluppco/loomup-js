import Foundation
@testable import Loomup

// MARK: - HTTP mock

final class MockHTTP: HTTPTransport, @unchecked Sendable {
    struct Call: Sendable {
        let method: String
        let url: String
        let auth: String?
        let body: Data?
    }

    private let lock = NSLock()
    private(set) var calls: [Call] = []
    /// Handler receives method, url string, auth header, body.
    var handler: (@Sendable (String, String, String?, Data?) async throws -> (Data, Int))?

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let method = request.httpMethod ?? "GET"
        let url = request.url?.absoluteString ?? ""
        let auth = request.value(forHTTPHeaderField: "Authorization")
        let body = request.httpBody
        lock.lock()
        calls.append(Call(method: method, url: url, auth: auth, body: body))
        lock.unlock()
        guard let handler else {
            throw LoomupError("no mock handler", code: "test")
        }
        let (data, status) = try await handler(method, url, auth, body)
        let response = HTTPURLResponse(
            url: request.url ?? URL(string: "http://example.test")!,
            statusCode: status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (data, response)
    }

    func snapshotCalls() -> [Call] {
        lock.lock()
        defer { lock.unlock() }
        return calls
    }
}

func jsonData(_ object: Any) -> Data {
    try! JSONSerialization.data(withJSONObject: object)
}

// MARK: - WebSocket mock

final class MockWebSocket: WebSocketConnecting, @unchecked Sendable {
    var onOpen: (() -> Void)?
    var onMessage: ((String) -> Void)?
    var onClose: (() -> Void)?

    private let lock = NSLock()
    private(set) var sent: [String] = []
    private(set) var connectCount = 0
    private var _isOpen = false
    private var _connecting = false
    var openDelay: TimeInterval = 0
    /// If false, stay CONNECTING forever (for timeout tests).
    var autoOpen = true
    /// Optional hook after each outbound frame (used to auto-ack/error in tests).
    var onSend: ((String) -> Void)?

    var isOpen: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isOpen
    }

    var isConnectingOrOpen: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _connecting || _isOpen
    }

    func connect(url: URL) {
        lock.lock()
        connectCount += 1
        _connecting = true
        _isOpen = false
        lock.unlock()
        guard autoOpen else { return }
        let delay = openDelay
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.simulateOpen()
        }
    }

    func send(text: String) {
        lock.lock()
        sent.append(text)
        let hook = onSend
        lock.unlock()
        hook?(text)
    }

    func close() {
        lock.lock()
        _isOpen = false
        _connecting = false
        lock.unlock()
        onClose?()
    }

    func simulateOpen() {
        lock.lock()
        _isOpen = true
        _connecting = false
        lock.unlock()
        onOpen?()
    }

    func simulateMessage(_ text: String) {
        onMessage?(text)
    }

    func simulateClose() {
        lock.lock()
        _isOpen = false
        _connecting = false
        lock.unlock()
        onClose?()
    }

    func snapshotSent() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return sent
    }

    func clearSent() {
        lock.lock()
        sent.removeAll()
        lock.unlock()
    }

    func parsedSent() -> [[String: Any]] {
        snapshotSent().compactMap { text in
            guard let data = text.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return nil }
            return obj
        }
    }
}

/// Holds the latest mock socket so tests can drive messages after connect.
final class MockWebSocketBox: @unchecked Sendable {
    private let lock = NSLock()
    private var current: MockWebSocket?
    var autoOpen = true
    var openDelay: TimeInterval = 0

    func note(_ ws: MockWebSocket) {
        lock.lock()
        current = ws
        lock.unlock()
    }

    func factory() -> WebSocketFactory {
        { [weak self] in
            let ws = MockWebSocket()
            ws.autoOpen = self?.autoOpen ?? true
            ws.openDelay = self?.openDelay ?? 0
            self?.note(ws)
            return ws
        }
    }

    var socket: MockWebSocket? {
        lock.lock()
        defer { lock.unlock() }
        return current
    }
}
