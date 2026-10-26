// model/fuzzy.ts has no TS test of its own; these pin its rules.
import XCTest
@testable import DevHubCore

final class FuzzyTests: XCTestCase {
    func testAnEmptyQueryMatchesEverything() {
        XCTAssertEqual(Fuzzy.score("/anything", ""), 1)
    }

    func testIsASubsequenceMatchIgnoringCase() {
        XCTAssertEqual(Fuzzy.score("/Users/me/src/DevHub", "dvhb"), 10)
        XCTAssertEqual(Fuzzy.score("/Users/me/src/DevHub", "zzz"), 0)
        XCTAssertEqual(Fuzzy.score("abc", "cba"), 0)
    }

    func testPrefersAHitInTheLastPathComponent() {
        XCTAssertEqual(Fuzzy.score("/Users/me/src/DevHub", "hub"), 100)
        XCTAssertEqual(Fuzzy.score("/hub/elsewhere", "hub"), 10)
        XCTAssertEqual(Fuzzy.score("devhub", "HUB"), 100)
    }
}
