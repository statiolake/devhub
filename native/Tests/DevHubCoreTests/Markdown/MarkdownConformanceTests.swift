// The native Markdown parser against the TS app's (micromark's mdast) for
// every CommonMark and GFM spec example and the answers DevHub draws.
// See Fixtures/markdown/README.md.

import Foundation
import XCTest
@testable import DevHubCore

final class MarkdownConformanceTests: XCTestCase {
    struct Case: Decodable {
        let markdown: String
        let mdast: String
    }

    func cases(_ name: String) throws -> [Case] {
        let data = try Data(contentsOf: Fixtures.url("markdown", name))
        return try JSONDecoder().decode([Case].self, from: data)
    }

    func check(_ name: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let all = try cases(name)
        var failures: [String] = []
        for (index, example) in all.enumerated() {
            let got = MarkdownSpelling.of(MarkdownParser.parse(example.markdown))
            if got != example.mdast {
                failures.append("#\(index) \(MarkdownSpelling.quoted(example.markdown))\n  want \(example.mdast)\n  got  \(got)")
            }
        }
        if !failures.isEmpty {
            XCTFail("\(failures.count) of \(all.count) differ:\n" + failures.prefix(400).joined(separator: "\n"), file: file, line: line)
        }
    }

    func testSpecExamples() throws { try check("commonmark-gfm-spec.json") }

    func testAnswers() throws { try check("extra.json") }
}
