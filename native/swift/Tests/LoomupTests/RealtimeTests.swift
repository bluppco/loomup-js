import XCTest
@testable import Loomup

final class RealtimeTests: XCTestCase {
    func testInjectedWebSocketConstructedOnSubscribe() async throws {
        let box = MockWebSocketBox()
        let c = createClient(
            url: URL(string: "http://localhost:3000")!,
            webSocketFactory: box.factory()
        )
        XCTAssertNil(box.socket)
        let unsub = c.from("todos").subscribe { _ in }
        // Allow connect/open
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertNotNil(box.socket)
        XCTAssertEqual(box.socket?.connectCount, 1)
        unsub()
        c.closeRealtime()
    }

    func testControlErrorFramesSurfaceWithCode() async throws {
        let box = MockWebSocketBox()
        let c = createClient(
            url: URL(string: "http://localhost:3000")!,
            webSocketFactory: box.factory()
        )
        var controls: [ControlEvent] = []
        let off = c.onControl { controls.append($0) }
        let unsub = c.from("todos").subscribe { _ in }
        try await Task.sleep(nanoseconds: 50_000_000)
        box.socket?.simulateMessage(
            #"{"type":"error","code":"AUTH_ERROR","message":"invalid or expired token"}"#
        )
        box.socket?.simulateMessage(
            #"{"type":"error","code":"SUBSCRIBE_ERROR","table":"todos","message":"subscribe forbidden"}"#
        )
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertTrue(controls.contains { $0.type == "error" && $0.code == "AUTH_ERROR" })
        XCTAssertTrue(controls.contains { $0.type == "error" && $0.code == "SUBSCRIBE_ERROR" })
        off()
        unsub()
        c.closeRealtime()
    }

    func testSetTokenReauthsAndResubscribes() async throws {
        let box = MockWebSocketBox()
        let c = createClient(
            url: URL(string: "http://localhost:3000")!,
            token: "old-token",
            webSocketFactory: box.factory()
        )
        let unsub = c.from("todos").subscribe(rowId: "1") { _ in }
        try await Task.sleep(nanoseconds: 50_000_000)
        box.socket?.clearSent()
        c.setToken("new-token")
        try await Task.sleep(nanoseconds: 20_000_000)
        let frames = box.socket?.parsedSent() ?? []
        XCTAssertTrue(
            frames.contains { ($0["type"] as? String) == "auth" && ($0["token"] as? String) == "new-token" },
            "\(frames)"
        )
        XCTAssertTrue(
            frames.contains { ($0["type"] as? String) == "subscribe" && ($0["token"] as? String) == "new-token" },
            "\(frames)"
        )
        unsub()
        c.closeRealtime()
    }

    func testRowUnsubSendsId() async throws {
        let box = MockWebSocketBox()
        let c = createClient(
            url: URL(string: "http://localhost:3000")!,
            webSocketFactory: box.factory()
        )
        let u1 = c.from("todos").subscribe(rowId: "1") { _ in }
        let u2 = c.from("todos").subscribe(rowId: "2") { _ in }
        try await Task.sleep(nanoseconds: 40_000_000)
        u1()
        try await Task.sleep(nanoseconds: 20_000_000)
        let unsubs = (box.socket?.parsedSent() ?? []).filter { ($0["type"] as? String) == "unsubscribe" }
        XCTAssertTrue(unsubs.contains { ($0["id"] as? String) == "1" }, "\(unsubs)")
        u2()
        c.closeRealtime()
    }

    func testSubscribeWithHashInRowId() async throws {
        let box = MockWebSocketBox()
        let c = createClient(
            url: URL(string: "http://localhost:3000")!,
            token: "tok1",
            webSocketFactory: box.factory()
        )
        let rowId = "prefix#with#hashes"
        let unsub = c.from("items").subscribe(rowId: rowId) { _ in }
        try await Task.sleep(nanoseconds: 50_000_000)
        let subs = (box.socket?.parsedSent() ?? []).filter { ($0["type"] as? String) == "subscribe" }
        XCTAssertTrue(
            subs.contains { ($0["id"] as? String) == rowId && ($0["table"] as? String) == "items" },
            "\(subs)"
        )
        unsub()
        c.closeRealtime()
    }

    func testRefreshApplyTokensSendsAuthAndResubscribe() async throws {
        let http = MockHTTP()
        http.handler = { _, url, _, _ in
            if url.hasSuffix("/auth/refresh") {
                return (
                    jsonData([
                        "data": [
                            "access_token": "rotated-access",
                            "refresh_token": "rotated-refresh",
                            "token_type": "Bearer",
                            "expires_in": 900,
                        ],
                    ]),
                    200
                )
            }
            return (Data("nope".utf8), 500)
        }
        let box = MockWebSocketBox()
        let c = createClient(
            url: URL(string: "http://example.test")!,
            token: "old-access",
            refreshToken: "r1",
            http: http,
            webSocketFactory: box.factory()
        )
        // Start with open socket: force OPEN immediately for send after refresh.
        let unsub = c.from("todos").subscribe(rowId: "42") { _ in }
        try await Task.sleep(nanoseconds: 50_000_000)
        // Ensure socket is open for reauth path
        if box.socket?.isOpen != true {
            box.socket?.simulateOpen()
        }
        box.socket?.clearSent()
        _ = try await c.refresh()
        XCTAssertEqual(c.accessToken, "rotated-access")
        try await Task.sleep(nanoseconds: 30_000_000)
        let frames = box.socket?.parsedSent() ?? []
        XCTAssertTrue(
            frames.contains { ($0["type"] as? String) == "auth" && ($0["token"] as? String) == "rotated-access" },
            "\(frames)"
        )
        XCTAssertTrue(
            frames.contains {
                ($0["type"] as? String) == "subscribe"
                    && ($0["token"] as? String) == "rotated-access"
                    && ($0["table"] as? String) == "todos"
                    && ($0["id"] as? String) == "42"
            },
            "\(frames)"
        )
        unsub()
        c.closeRealtime()
    }

    func testReconnectResyncDeliversResyncEvents() async throws {
        let http = MockHTTP()
        http.handler = { _, url, _, _ in
            if url.contains("/api/todos/7") {
                return (jsonData(["data": ["id": 7, "title": "after-outage"]]), 200)
            }
            return (Data("nope".utf8), 404)
        }
        let box = MockWebSocketBox()
        let c = createClient(
            url: URL(string: "http://example.test")!,
            token: "t",
            http: http,
            webSocketFactory: box.factory()
        )
        var events: [ChangeEvent] = []
        let unsub = c.from("todos").subscribe(rowId: "7") { events.append($0) }
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(events.filter { $0.op == "RESYNC" }.count, 0)

        // Drop + reconnect
        box.socket?.simulateClose()
        // Wait for reconnect timer (min ~50ms, jitter up to 1s first attempt)
        try await Task.sleep(nanoseconds: 1_200_000_000)
        try await Task.sleep(nanoseconds: 100_000_000)

        let resyncs = events.filter { $0.op == "RESYNC" }
        XCTAssertGreaterThanOrEqual(resyncs.count, 1, "events=\(events.map { $0.op })")
        if let first = resyncs.first {
            XCTAssertEqual(first.id, "7")
            XCTAssertEqual(first.data?["title"]?.stringValue, "after-outage")
        }
        unsub()
        c.closeRealtime()
    }

    func testSubscribeReadyAwaitsSubscribedAck() async throws {
        let box = MockWebSocketBox()
        let factory: WebSocketFactory = {
            let ws = MockWebSocket()
            ws.onSend = { [weak ws] text in
                guard let data = text.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      (obj["type"] as? String) == "subscribe",
                      let rid = obj["requestId"] as? String
                else { return }
                let ack: [String: Any] = [
                    "type": "subscribed",
                    "requestId": rid,
                    "table": "todos",
                    "channel": "todos",
                ]
                if let d = try? JSONSerialization.data(withJSONObject: ack),
                   let s = String(data: d, encoding: .utf8)
                {
                    // Async so pending-ack registration completes first.
                    DispatchQueue.global().async {
                        ws?.simulateMessage(s)
                    }
                }
            }
            box.note(ws)
            return ws
        }
        let c = createClient(
            url: URL(string: "http://example.test")!,
            webSocketFactory: factory
        )
        let unsub = try await c.from("todos").subscribeReady { _ in }
        unsub()
        c.closeRealtime()
    }

    func testSubscribeReadyTimeoutCleansUp() async throws {
        let box = MockWebSocketBox()
        let c = createClient(
            url: URL(string: "http://example.test")!,
            webSocketFactory: box.factory()
        )
        do {
            _ = try await c.from("todos").subscribeReady(timeoutMs: 80) { _ in }
            XCTFail("expected timeout")
        } catch let e as LoomupError {
            XCTAssertTrue(
                e.message.contains("timeout") || e.code == "subscribe_timeout",
                e.message
            )
        }
        c.closeRealtime()
    }

    func testSubscribeReadyRejectsOnErrorFrame() async throws {
        let box = MockWebSocketBox()
        let factory: WebSocketFactory = {
            let ws = MockWebSocket()
            ws.onSend = { [weak ws] text in
                guard let data = text.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      (obj["type"] as? String) == "subscribe",
                      let rid = obj["requestId"] as? String
                else { return }
                let err: [String: Any] = [
                    "type": "error",
                    "code": "SUBSCRIBE_ERROR",
                    "requestId": rid,
                    "message": "table not exposed or realtime disabled",
                ]
                if let d = try? JSONSerialization.data(withJSONObject: err),
                   let s = String(data: d, encoding: .utf8)
                {
                    DispatchQueue.global().async {
                        ws?.simulateMessage(s)
                    }
                }
            }
            box.note(ws)
            return ws
        }
        let c = createClient(
            url: URL(string: "http://example.test")!,
            webSocketFactory: factory
        )
        do {
            _ = try await c.from("todos").subscribeReady(timeoutMs: 2000) { _ in }
            XCTFail("expected error")
        } catch let e as LoomupError {
            XCTAssertTrue(
                e.message.contains("table not exposed")
                    || e.code == "SUBSCRIBE_ERROR"
                    || e.message.contains("subscribe"),
                e.message
            )
        }
        c.closeRealtime()
    }

    func testChangeEventFanout() async throws {
        let box = MockWebSocketBox()
        let c = createClient(
            url: URL(string: "http://example.test")!,
            webSocketFactory: box.factory()
        )
        var tableEvents: [ChangeEvent] = []
        var rowEvents: [ChangeEvent] = []
        let u1 = c.from("todos").subscribe { tableEvents.append($0) }
        let u2 = c.from("todos").subscribe(rowId: "9") { rowEvents.append($0) }
        try await Task.sleep(nanoseconds: 40_000_000)
        box.socket?.simulateMessage(
            #"{"type":"change","table":"todos","op":"INSERT","id":"9","data":{"id":9,"title":"x"},"ts":100}"#
        )
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(tableEvents.count, 1)
        XCTAssertEqual(rowEvents.count, 1)
        XCTAssertEqual(tableEvents.first?.op, "INSERT")
        u1()
        u2()
        c.closeRealtime()
    }
}
