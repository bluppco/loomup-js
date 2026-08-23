import XCTest
@testable import Loomup

final class AuthRefreshTests: XCTestCase {
    func testOn401RefreshesOnceAndRetries() async throws {
        let http = MockHTTP()
        var access = "old-access"
        http.handler = { method, url, auth, body in
            if url.hasSuffix("/auth/refresh") {
                access = "new-access"
                return (
                    jsonData([
                        "data": [
                            "access_token": access,
                            "refresh_token": "refresh-2",
                            "token_type": "Bearer",
                            "expires_in": 900,
                        ],
                    ]),
                    200
                )
            }
            if url.hasSuffix("/auth/me") {
                if auth == "Bearer old-access" {
                    return (
                        jsonData(["error": ["code": "unauthorized", "message": "expired"]]),
                        401
                    )
                }
                if auth == "Bearer new-access" {
                    return (
                        jsonData([
                            "data": [
                                "id": "u1",
                                "email": "a@b.com",
                                "role": "user",
                                "disabled": false,
                                "created_at": 1,
                            ],
                        ]),
                        200
                    )
                }
            }
            return (Data("not found".utf8), 404)
        }

        let c = createClient(
            url: URL(string: "http://example.test")!,
            token: "old-access",
            refreshToken: "refresh-1",
            http: http
        )
        let me = try await c.me()
        XCTAssertEqual(me.email, "a@b.com")
        XCTAssertEqual(c.accessToken, "new-access")
        let calls = http.snapshotCalls()
        XCTAssertTrue(calls.contains { $0.url.hasSuffix("/auth/refresh") })
        let meCalls = calls.filter { $0.url.hasSuffix("/auth/me") }
        XCTAssertEqual(meCalls.count, 2)
        XCTAssertEqual(meCalls[0].auth, "Bearer old-access")
        XCTAssertEqual(meCalls[1].auth, "Bearer new-access")
    }

    func testManualRefreshUpdatesTokens() async throws {
        let http = MockHTTP()
        http.handler = { _, url, _, _ in
            if url.hasSuffix("/auth/refresh") {
                return (
                    jsonData([
                        "data": [
                            "access_token": "a2",
                            "refresh_token": "r2",
                            "token_type": "Bearer",
                            "expires_in": 60,
                        ],
                    ]),
                    200
                )
            }
            return (Data("nope".utf8), 500)
        }
        let c = createClient(
            url: URL(string: "http://example.test")!,
            refreshToken: "r1",
            http: http
        )
        let tokens = try await c.refresh()
        XCTAssertEqual(tokens.accessToken, "a2")
        XCTAssertEqual(c.accessToken, "a2")
    }

    func testRefreshWithoutTokenThrows() async {
        let c = createClient(url: URL(string: "http://example.test")!)
        do {
            _ = try await c.refresh()
            XCTFail("expected throw")
        } catch let e as LoomupError {
            XCTAssertEqual(e.code, "no_refresh")
        } catch {
            XCTFail("wrong error \(error)")
        }
    }
}
