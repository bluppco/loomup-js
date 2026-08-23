import XCTest
@testable import Loomup

final class SubKeyTests: XCTestCase {
    func testParseSubKeySplitsOnlyOnFirstHash() {
        let a = parseSubKey("todos")
        XCTAssertEqual(a.table, "todos")
        XCTAssertNil(a.rowId)

        let b = parseSubKey("todos#1")
        XCTAssertEqual(b.table, "todos")
        XCTAssertEqual(b.rowId, "1")

        let c = parseSubKey("todos#a#b#c")
        XCTAssertEqual(c.table, "todos")
        XCTAssertEqual(c.rowId, "a#b#c")

        XCTAssertEqual(makeSubKey(table: "todos", rowId: "a#b"), "todos#a#b")
        let round = parseSubKey(makeSubKey(table: "notes", rowId: "x#y"))
        XCTAssertEqual(round.table, "notes")
        XCTAssertEqual(round.rowId, "x#y")
    }
}
