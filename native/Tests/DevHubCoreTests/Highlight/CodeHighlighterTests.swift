// The native TextMate tokenizer and Light+/Dark+ against the TS app's
// (Shiki's) colours for a sample of every grammar, and the ported tests of
// highlight.ts's `grammarFor` (markdownBlocks.test.ts).

import Foundation
import XCTest
@testable import DevHubCore

final class CodeHighlighterTests: XCTestCase {
    func testGrammarFor() {
        XCTAssertEqual(CodeGrammar.of(info: "TypeScript"), .typescript)
        XCTAssertEqual(CodeGrammar.of(info: "rust ignore"), .rust)
        XCTAssertEqual(CodeGrammar.of(info: "  py "), .python)
        XCTAssertEqual(CodeGrammar.of(info: "ts"), .typescript)
        XCTAssertEqual(CodeGrammar.of(info: "sh"), .shellscript)
        XCTAssertEqual(CodeGrammar.of(info: "zsh"), .shellscript)
        XCTAssertEqual(CodeGrammar.of(info: "dockerfile"), .docker)
        XCTAssertNil(CodeGrammar.of(info: "cobol"))
        XCTAssertNil(CodeGrammar.of(info: ""))
        XCTAssertNil(CodeGrammar.of(info: nil))
        XCTAssertNil(CodeGrammar.of(info: "constructor"))
    }

    /// Each UTF-16 unit's colour, line by line.
    func colours(_ lines: [[(String, String?, String?)]]) -> [[(String?, String?)]] {
        lines.map { line in
            line.flatMap { token in Array(repeating: (token.1?.lowercased(), token.2?.lowercased()), count: (token.0 as NSString).length) }
        }
    }

    func testColoursMatchShiki() throws {
        let samples = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: Fixtures.url("highlight", "samples.json")))
        let expected = try JsonValue.parse(Data(contentsOf: Fixtures.url("highlight", "expected.json")))
        let highlighter = CodeHighlighter(root: CodeHighlighter.resourceRoot)
        var report: [String] = []
        var wrongUnits = 0
        var allUnits = 0
        for grammar in CodeGrammar.allCases {
            guard let code = samples[grammar.rawValue], let want = expected[grammar.rawValue]?.arrayValue else {
                XCTFail("no sample for \(grammar)")
                continue
            }
            let wantLines: [[(String, String?, String?)]] = want.map { line in
                (line.arrayValue ?? []).map { token in
                    let parts = token.arrayValue ?? []
                    return (parts[0].stringValue ?? "", parts[1].stringValue, parts[2].stringValue)
                }
            }
            let got = highlighter.highlight(code, grammar).map { $0.map { ($0.text, $0.light, $0.dark) } }
            let wantColours = colours(wantLines), gotColours = colours(got)
            for (index, line) in wantColours.enumerated() {
                let other = index < gotColours.count ? gotColours[index] : []
                allUnits += line.count
                var bad = 0
                for (unit, colour) in line.enumerated() {
                    let mine = unit < other.count ? other[unit] : (nil, nil)
                    if mine.0 != colour.0 || mine.1 != colour.1 { bad += 1 }
                }
                if bad > 0 {
                    wrongUnits += bad
                    let text = code.components(separatedBy: "\n")[index]
                    let scopes = highlighter.tokenize(text, grammar).first?.map { "\($0.text)=\($0.scopes.last ?? "")" }.joined(separator: " ") ?? ""
                    report.append("\(grammar) line \(index): \(bad) units differ: \(text)\n   want \(wantLines[index].map { "\($0.0)|\($0.2 ?? "-")" })\n   got  \(got[index].map { "\($0.0)|\($0.2 ?? "-")" })\n   scopes \(scopes)")
                }
            }
        }
        print("highlight: \(wrongUnits) of \(allUnits) characters coloured differently")
        if !report.isEmpty { XCTFail(report.joined(separator: "\n")) }
    }

    /// Every pattern of every vendored grammar, in each of its anchor variants, compiles on ICU.
    func testEveryPatternCompiles() throws {
        guard let root = CodeHighlighter.resourceRoot else { return XCTFail("no grammars") }
        var patterns: [String] = []
        func walk(_ value: JsonValue) {
            switch value {
            case .object(let object):
                for (key, child) in object {
                    if ["match", "begin", "end", "while"].contains(key), let text = child.stringValue { patterns.append(text) } else { walk(child) }
                }
            case .array(let items): items.forEach(walk)
            default: break
            }
        }
        for grammar in CodeGrammar.allCases {
            walk(try JsonValue.parse(Data(contentsOf: URL(fileURLWithPath: root + "/" + grammar.rawValue + ".json"))))
        }
        var refused: [String] = []
        // An end with back-references is compiled once the begin has said what they are.
        for pattern in Set(patterns) where !hasBackReferences(pattern) {
            for (allowA, gAt) in [(false, nil), (true, 0), (false, 7)] as [(Bool, Int?)] {
                let source = TextMateGrammar.variant(pattern, allowA: allowA, gAt: gAt)
                if TextMateRegex(source).regex == nil { refused.append(source) }
            }
        }
        XCTAssertGreaterThan(patterns.count, 5000)
        XCTAssertEqual(refused, [], "ICU refused \(refused.count) patterns")
    }

    func testALongBlockIsColouredQuickly() throws {
        let samples = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: Fixtures.url("highlight", "samples.json")))
        let code = Array(repeating: samples["typescript"]!, count: 40).joined(separator: "\n")
        let highlighter = CodeHighlighter(root: CodeHighlighter.resourceRoot)
        _ = highlighter.highlight("const a = 1;", .typescript)
        let start = Date()
        let lines = highlighter.highlight(code, .typescript)
        XCTAssertEqual(lines.count, code.components(separatedBy: "\n").count)
        XCTAssertLessThan(Date().timeIntervalSince(start), 10)
        print("highlight: \(lines.count) lines of TypeScript in \(Date().timeIntervalSince(start))s")
    }
}

final class TextMateTraceTests: XCTestCase {
    func testTrace() {
        guard let spec = ProcessInfo.processInfo.environment["TRACE"] else { return }
        let parts = spec.split(separator: ":", maxSplits: 1).map(String.init)
        let highlighter = CodeHighlighter(root: CodeHighlighter.resourceRoot)
        TextMateDebug.on = true
        let lines = highlighter.tokenize(parts[1].replacingOccurrences(of: "\\n", with: "\n"), CodeGrammar(rawValue: parts[0])!)
        TextMateDebug.on = false
        for line in lines { print("TOKENS", line.map { "\($0.text.debugDescription)=\($0.scopes.joined(separator: " "))" }.joined(separator: " | ")) }
    }
}
