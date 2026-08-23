import Foundation

/// Injectable WebSocket used by realtime. Defaults to `URLSessionWebSocketTask`.
public protocol WebSocketConnecting: AnyObject {
    var onOpen: (() -> Void)? { get set }
    var onMessage: ((String) -> Void)? { get set }
    var onClose: (() -> Void)? { get set }
    /// True when the socket can send (OPEN).
    var isOpen: Bool { get }
    /// True while connecting or open (CONNECTING | OPEN).
    var isConnectingOrOpen: Bool { get }
    func connect(url: URL)
    func send(text: String)
    func close()
}

public typealias WebSocketFactory = @Sendable () -> WebSocketConnecting

/// Production WebSocket backed by `URLSessionWebSocketTask`.
public final class URLSessionWebSocketConnection: NSObject, WebSocketConnecting, URLSessionWebSocketDelegate {
    public var onOpen: (() -> Void)?
    public var onMessage: ((String) -> Void)?
    public var onClose: (() -> Void)?

    /// Must retain the session for the lifetime of the task (delegate callbacks).
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var opened = false
    private var closed = false
    private let lock = NSLock()

    public override init() {
        super.init()
    }

    public var isOpen: Bool {
        lock.lock()
        defer { lock.unlock() }
        return opened && !closed
    }

    public var isConnectingOrOpen: Bool {
        lock.lock()
        defer { lock.unlock() }
        return task != nil && !closed
    }

    public func connect(url: URL) {
        lock.lock()
        closed = false
        opened = false
        lock.unlock()

        let config = URLSessionConfiguration.default
        let sess = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        let t = sess.webSocketTask(with: url)
        lock.lock()
        session = sess
        task = t
        lock.unlock()
        t.resume()
        receiveLoop()
    }

    public func send(text: String) {
        lock.lock()
        let t = task
        let canSend = opened && !closed
        lock.unlock()
        guard canSend, let t else { return }
        t.send(.string(text)) { _ in }
    }

    public func close() {
        lock.lock()
        closed = true
        let t = task
        task = nil
        session = nil
        lock.unlock()
        t?.cancel(with: .goingAway, reason: nil)
    }

    private func receiveLoop() {
        lock.lock()
        let t = task
        lock.unlock()
        guard let t else { return }
        t.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.onMessage?(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.onMessage?(text)
                    }
                @unknown default:
                    break
                }
                self.receiveLoop()
            case .failure:
                self.markClosed()
            }
        }
    }

    private func markClosed() {
        lock.lock()
        let already = closed
        closed = true
        opened = false
        task = nil
        lock.unlock()
        if !already {
            onClose?()
        }
    }

    // MARK: URLSessionWebSocketDelegate

    public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        lock.lock()
        opened = true
        lock.unlock()
        onOpen?()
    }

    public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        markClosed()
    }

    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        if error != nil {
            markClosed()
        }
    }
}
