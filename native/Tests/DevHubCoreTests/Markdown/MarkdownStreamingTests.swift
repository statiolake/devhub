// Port of apps/desktop/src/shell/conversation/markdownBlocks.test.ts and the
// `normalizeMath` cases of math.test.tsx.

import XCTest
@testable import DevHubCore

final class MarkdownStreamingTests: XCTestCase {
    func settled(_ markdown: String) -> String { String(MarkdownStreaming.settledPrefix(markdown)) }

    func testSettlesNothingBeforeTheFirstBlockHasEnded() {
        XCTAssertEqual(settled("A paragraph still being writ"), "")
        XCTAssertEqual(settled("A paragraph\nwith two lines\n"), "")
    }

    func testSettlesEveryBlockABlankLineHasEnded() {
        XCTAssertEqual(settled("One.\n\nTwo.\n\nThr"), "One.\n\nTwo.\n\n")
    }

    func testDoesNotSettleAnOpenFence() {
        XCTAssertEqual(settled("Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n"), "Intro.\n\n")
    }

    func testSettlesAFenceOnItsClosingLine() {
        XCTAssertEqual(settled("Intro.\n\n```ts\nconst a = 1;\n```\nMore"), "Intro.\n\n```ts\nconst a = 1;\n```\n")
    }

    func testAnUnterminatedLastLineClosesNothing() {
        XCTAssertEqual(settled("```ts\nconst a = 1;\n```"), "")
    }

    func testClosesOnlyWithTheSameMarkerAtLeastAsLong() {
        let text = "````md\n```\ninner\n```\n````\n"
        XCTAssertEqual(settled(text), text)
        XCTAssertEqual(settled("~~~\ncode\n```\n"), "")
    }

    func testTextAfterTheMarkerIsNoClose() {
        XCTAssertEqual(settled("```\ncode\n``` not a close\n"), "")
    }

    func testLeavesCurrencyAsText() {
        XCTAssertEqual(MarkdownStreaming.normalizeMath("$5 and $10"), "\\$5 and \\$10")
    }

    func testKeepsRealInlineMath() {
        XCTAssertEqual(MarkdownStreaming.normalizeMath("let $x$ be"), "let $x$ be")
    }

    func testConvertsBracketDelimiters() {
        XCTAssertEqual(MarkdownStreaming.normalizeMath("a \\(x+1\\) b"), "a $x+1$ b")
        XCTAssertEqual(MarkdownStreaming.normalizeMath("\\[ x^2 \\]"), "$$\nx^2\n$$")
    }

    func testLeavesCodeAlone() {
        XCTAssertEqual(MarkdownStreaming.normalizeMath("`$a$ \\(b\\)`"), "`$a$ \\(b\\)`")
        XCTAssertEqual(MarkdownStreaming.normalizeMath("```\n$5 \\(x\\)\n```"), "```\n$5 \\(x\\)\n```")
    }

    func testDisplayParagraphBecomesAMathBlock() {
        let parsed = MarkdownParser.parse(MarkdownStreaming.normalizeMath("$$x^2$$"))
        XCTAssertEqual(parsed.blocks, [.math("x^2")])
        let currency = MarkdownParser.parse(MarkdownStreaming.normalizeMath("costs $5 and $10 total"))
        XCTAssertEqual(currency.blocks, [.paragraph([.text("costs $5 and $10 total")])])
    }

    func testKeepIndentation() {
        XCTAssertEqual(MarkdownStreaming.keepIndentation("a\n  b\n```\n  c\n```"), "a\n\u{a0}\u{a0}b\n```\n  c\n```")
    }

    func testParsesWhateverItIsGiven() {
        // Nothing a model writes makes the parser trap or loop.
        var generator = SystemRandomNumberGenerator()
        let alphabet = Array("ab *_~`$[]()!<>&#\\|-+:.\n\t 1x@w/^\"'")
        for _ in 0..<3000 {
            let length = Int.random(in: 0..<60, using: &generator)
            let text = String((0..<length).map { _ in alphabet.randomElement(using: &generator)! })
            _ = MarkdownParser.parse(text)
        }
    }
}
