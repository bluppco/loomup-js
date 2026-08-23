import XCTest
@testable import Loomup

final class ClientTests: XCTestCase {
    func testCreateClientStoresUrlAndToken() {
        let c = createClient(
            url: URL(string: "http://localhost:3000/")!,
            token: "abc"
        )
        XCTAssertEqual(c.url.absoluteString, "http://localhost:3000")
        XCTAssertEqual(c.accessToken, "abc")
    }

    func testFromReturnsQueryMethods() {
        let c = createClient(url: URL(string: "http://127.0.0.1:3000")!)
        let q = c.from("todos")
        // Compile-time surface: call sites exist
        XCTAssertNotNil(q)
        XCTAssertNotNil(c.auth)
    }

    func testLoomupErrorCarriesCode() {
        let e = LoomupError("nope", code: "forbidden", status: 403)
        XCTAssertEqual(e.code, "forbidden")
        XCTAssertEqual(e.status, 403)
        XCTAssertEqual(e.message, "nope")
    }

    func testSelectEncodesBooleanWhereAsZeroOne() async throws {
        let http = MockHTTP()
        var urls: [String] = []
        http.handler = { _, url, _, _ in
            urls.append(url)
            let body = jsonData([
                "data": [],
                "meta": ["limit": 10, "offset": 0, "total": 0],
            ])
            return (body, 200)
        }
        let c = createClient(
            url: URL(string: "http://localhost:3000")!,
            http: http
        )
        _ = try await c.from("todos").select(where: ["completed": true], limit: 5)
        XCTAssertTrue(
            urls[0].contains("where%5Bcompleted%5D=1") || urls[0].contains("where[completed]=1"),
            urls[0]
        )
        urls.removeAll()
        _ = try await c.from("todos").select(where: ["completed": false])
        XCTAssertTrue(
            urls[0].contains("where%5Bcompleted%5D=0") || urls[0].contains("where[completed]=0"),
            urls[0]
        )
    }

    func testRestOnlyDoesNotRequireWebSocket() async throws {
        let http = MockHTTP()
        http.handler = { _, url, _, _ in
            if url.hasSuffix("/auth/login") {
                return (
                    jsonData([
                        "data": [
                            "access_token": "a",
                            "refresh_token": "r",
                            "token_type": "Bearer",
                            "expires_in": 60,
                            "user": [
                                "id": "u1",
                                "email": "a@b.com",
                                "role": "user",
                                "disabled": false,
                                "created_at": 1,
                            ],
                        ],
                    ]),
                    200
                )
            }
            return (Data("nope".utf8), 404)
        }
        let c = createClient(url: URL(string: "http://example.test")!, http: http)
        let tokens = try await c.signIn(email: "a@b.com", password: "secret12")
        XCTAssertEqual(tokens.accessToken, "a")
        XCTAssertEqual(c.accessToken, "a")
    }

    func testCRUDInsertUpdateDeletePaths() async throws {
        let http = MockHTTP()
        http.handler = { method, url, _, body in
            if method == "POST", url.hasSuffix("/api/todos") {
                XCTAssertNotNil(body)
                return (jsonData(["data": ["id": 1, "title": "hi"]]), 200)
            }
            if method == "PATCH", url.contains("/api/todos/1") {
                return (jsonData(["data": ["id": 1, "title": "bye"]]), 200)
            }
            if method == "DELETE", url.contains("/api/todos/1") {
                return (jsonData(["data": ["id": 1, "title": "bye"]]), 200)
            }
            if method == "GET", url.hasSuffix("/api/todos/1") {
                return (jsonData(["data": ["id": 1, "title": "hi"]]), 200)
            }
            return (Data("nope".utf8), 404)
        }
        let c = createClient(url: URL(string: "http://example.test")!, http: http)
        let inserted = try await c.from("todos").insert([
            "title": .string("hi"),
            "completed": .number(0),
        ])
        XCTAssertEqual(inserted["title"]?.stringValue, "hi")
        let got = try await c.from("todos").get(1)
        XCTAssertEqual(got["id"]?.intValue, 1)
        let updated = try await c.from("todos").update(1, patch: ["title": .string("bye")])
        XCTAssertEqual(updated["title"]?.stringValue, "bye")
        let deleted = try await c.from("todos").delete(1)
        XCTAssertEqual(deleted["id"]?.intValue, 1)
    }
}
