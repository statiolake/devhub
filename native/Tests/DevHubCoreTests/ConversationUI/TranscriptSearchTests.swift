// Port of apps/desktop/src/shell/conversation/transcriptSearch.test.ts, over
// sections rather than a document.

import XCTest
@testable import DevHubCore

final class TranscriptSearchTests: XCTestCase {
    @MainActor
    final class Slices {
        var queue: [() -> Void] = []
        var longest: Double = 0

        func schedule(_ run: @escaping @MainActor () -> Void) -> () -> Void {
            let box = { MainActor.assumeIsolated { run() } }
            queue.append(box)
            return {}
        }

        func drain() -> Int {
            var ran = 0
            while !queue.isEmpty {
                let run = queue.removeFirst()
                let start = Date()
                run()
                longest = max(longest, Date().timeIntervalSince(start) * 1000)
                ran += 1
            }
            return ran
        }
    }

    static func sections(_ count: Int, _ text: (Int) -> String) -> [SearchSection] {
        (0..<count).map { SearchSection(id: "e\($0)", text: text($0)) }
    }

    func testCountsEveryMatchExactlyInSlices() {
        MainActor.assumeIsolated {
            let slices = Slices()
            let search = TranscriptSearch(sections: Self.sections(2_000, { _ in String(repeating: "a", count: 1_000) }), onChange: {}, schedule: { run in slices.schedule(run) })
            search.setQuery("a", caseSensitive: false)
            XCTAssertFalse(search.status.complete)
            let first = search.status
            XCTAssertGreaterThan(first.total, 0)
            XCTAssertEqual(first.current, first.total - 1)
            XCTAssertEqual(search.currentMatch?.section, "e1999")
            XCTAssertGreaterThan(slices.drain(), 5)
            XCTAssertEqual(search.status.total, 2_000_000)
            XCTAssertTrue(search.status.complete)
            XCTAssertEqual(search.status.current, 1_999_999)
            XCTAssertLessThan(slices.longest, 200)
        }
    }

    func testANewQueryDropsTheOld() {
        MainActor.assumeIsolated {
            let slices = Slices()
            let search = TranscriptSearch(sections: Self.sections(500, { "\(String(repeating: "a", count: 1_000)) b\($0)" }), onChange: {}, schedule: { run in slices.schedule(run) })
            search.setQuery("a", caseSensitive: false)
            search.setQuery("b1", caseSensitive: false)
            _ = slices.drain()
            XCTAssertEqual(search.status.total, 111)
            XCTAssertEqual(search.status.current, 110)
            XCTAssertEqual(search.currentMatch?.section, "e199")
        }
    }

    func testStepsWhileTheCountGrows() {
        MainActor.assumeIsolated {
            let slices = Slices()
            let search = TranscriptSearch(sections: Self.sections(2_000, { _ in String(repeating: "a", count: 1_000) }), onChange: {}, schedule: { run in slices.schedule(run) })
            search.setQuery("a", caseSensitive: false)
            let total = search.status.total
            search.step(-1)
            XCTAssertEqual(search.status.current, total - 2)
            search.step(1)
            search.step(1)
            XCTAssertEqual(search.status.current, 0)
            _ = slices.drain()
            XCTAssertEqual(search.status.total, 2_000_000)
            XCTAssertEqual(search.status.current, 2_000_000 - total)
        }
    }

    func testNewQueryLastMatchAndCase() {
        MainActor.assumeIsolated {
            let search = TranscriptSearch(sections: Self.sections(3, { "parse parser \($0)" }), onChange: {}, schedule: { run in run(); return {} })
            search.setQuery("parser", caseSensitive: false)
            XCTAssertEqual(search.status.total, 3)
            XCTAssertEqual(search.status.current, 2)
            search.step(1)
            XCTAssertEqual(search.status.current, 0)
            search.setQuery("parse", caseSensitive: false)
            XCTAssertEqual(search.status.total, 6)
            XCTAssertEqual(search.status.current, 5)
            let cased = TranscriptSearch(sections: [SearchSection(id: "e", text: "Parser parser PARSER")], onChange: {}, schedule: { run in run(); return {} })
            cased.setQuery("parser", caseSensitive: false)
            XCTAssertEqual(cased.status.total, 3)
            cased.setQuery("Parser", caseSensitive: true)
            XCTAssertEqual(cased.status.total, 1)
            cased.setQuery("", caseSensitive: false)
            XCTAssertEqual(cased.status.total, 0)
            XCTAssertTrue(cased.status.complete)
        }
    }

    func testNoMatchRunsAcrossBlocks() {
        MainActor.assumeIsolated {
            let search = TranscriptSearch(sections: [SearchSection(id: "e", text: "alpha beta" + BLOCK_BREAK + "gamma")], onChange: {}, schedule: { run in run(); return {} })
            search.setQuery("alpha beta", caseSensitive: false)
            XCTAssertEqual(search.status.total, 1)
            search.setQuery("betagamma", caseSensitive: false)
            XCTAssertEqual(search.status.total, 0)
        }
    }

    func testAGrowingConversation() {
        MainActor.assumeIsolated {
            var drawn = Self.sections(1_000, { "step \($0) parser" })
            let search = TranscriptSearch(sections: drawn, onChange: {}, schedule: { run in run(); return {} })
            search.setQuery("parser", caseSensitive: false)
            XCTAssertEqual(search.status.current, 999)
            search.step(1)
            search.step(1)
            search.step(1)
            let current = search.currentMatch
            drawn.append(SearchSection(id: "new", text: "one more parser note"))
            search.refresh(drawn)
            XCTAssertEqual(search.status.total, 1_001)
            XCTAssertEqual(search.status.current, 2)
            XCTAssertEqual(search.currentMatch, current)
        }
    }

    func testTheCurrentMatchStaysWhenItsEntryIsDrawnAgain() {
        MainActor.assumeIsolated {
            var drawn = Self.sections(3, { "parser \($0) parser" })
            let search = TranscriptSearch(sections: drawn, onChange: {}, schedule: { run in run(); return {} })
            search.setQuery("parser", caseSensitive: false)
            search.step(-1)
            search.step(-1)
            XCTAssertEqual(search.status.current, 3)
            drawn[1].text += " and parser"
            search.refresh(drawn)
            XCTAssertEqual(search.status.total, 7)
            XCTAssertEqual(search.status.current, 3)
            XCTAssertEqual(search.currentMatch?.section, "e1")
        }
    }

    func testMovesToTheMatchAtItsPlaceWhenItsEntryGoes() {
        MainActor.assumeIsolated {
            var drawn = Self.sections(3, { _ in "parser" })
            let search = TranscriptSearch(sections: drawn, onChange: {}, schedule: { run in run(); return {} })
            search.setQuery("parser", caseSensitive: false)
            search.step(-1)
            drawn.remove(at: 1)
            search.refresh(drawn)
            XCTAssertEqual(search.status.total, 2)
            XCTAssertEqual(search.status.current, 1)
        }
    }

    func testFoldCase() {
        MainActor.assumeIsolated {
            XCTAssertEqual(foldCase("AbC"), "abc")
            XCTAssertEqual(foldCase("İx").utf16.count, "İx".utf16.count)
        }
    }
}

final class PathLinkStoreTests: XCTestCase {
    @MainActor
    func testAsksInOneBatchRemembersAndForgetsTheAbsent() async throws {
        var asked: [[String]] = []
        var pendingWork: [@MainActor () -> Void] = []
        let links = PathLinks(
            resolve: { cwd, paths in
                asked.append(paths)
                return paths.map { $0 == "src/a.ts" ? "\(cwd!)/src/a.ts" : nil }
            }, reportFailure: { _ in }, schedule: { pendingWork.append($0) })
        links.want("/p", "src/a.ts")
        links.want("/p", "nope.ts")
        links.want("/p", "src/a.ts")
        XCTAssertNil(links.file("/p", "src/a.ts"))
        XCTAssertEqual(pendingWork.count, 1)
        pendingWork.removeFirst()()
        for _ in 0..<20 where links.file("/p", "nope.ts") == nil { await Task.yield() }
        XCTAssertEqual(asked, [["src/a.ts", "nope.ts"]])
        XCTAssertEqual(links.file("/p", "src/a.ts"), .file("/p/src/a.ts"))
        XCTAssertEqual(links.file("/p", "nope.ts"), PathLinks.Known.none)
        links.forgetAbsent()
        XCTAssertNil(links.file("/p", "nope.ts"))
        XCTAssertNotNil(links.file("/p", "src/a.ts"))
        // Relative with no directory named: nothing to ask.
        links.want(nil, "x.ts")
        XCTAssertEqual(links.file(nil, "x.ts"), PathLinks.Known.none)
    }
}
