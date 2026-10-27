// Port of apps/desktop/src/shell/conversation/textLinks.test.ts and the
// reading half of issueLinks.test.tsx.

import XCTest
@testable import DevHubCore

final class TextLinksTests: XCTestCase {
    func found(_ text: String) -> [(text: String, path: String, range: FileRange?)] {
        let ns = text as NSString
        return TextLinks.spans(text).compactMap { span in
            guard case let .path(candidate, start, end) = span else { return nil }
            return (ns.substring(with: NSRange(location: start, length: end - start)), candidate.path, candidate.range)
        }
    }

    func spans(_ text: String) -> [String] {
        let ns = text as NSString
        return TextLinks.spans(text).map { span in
            let shown = ns.substring(with: NSRange(location: span.start, length: span.end - span.start))
            switch span {
            case .path: return "path:\(shown)"
            case let .issue(reference, _, _):
                let repo = reference.owner.map { "\($0)/\(reference.repository!)" } ?? ""
                return "issue:\(repo)#\(reference.number)=\(shown)"
            }
        }
    }

    func testFindsABareAndAQualifiedReference() {
        XCTAssertEqual(spans("Fixes #12, see example/widget#345."), ["issue:#12=#12", "issue:example/widget#345=example/widget#345"])
    }

    func testFindsReferencesInBracketsAndAgainstCJK() {
        XCTAssertEqual(
            spans("(#1) [#2] 「#3」を直しました。これは#4です Merge pull request #5 from x"),
            ["issue:#1=#1", "issue:#2=#2", "issue:#3=#3", "issue:#4=#4", "issue:#5=#5"])
    }

    func testALineAnchorIsThePathsLine() {
        XCTAssertEqual(spans("src/a.ts#L12 and #L12 alone"), ["path:src/a.ts#L12"])
    }

    func testLeavesURLsAlone() {
        XCTAssertEqual(spans("https://github.com/example/widget/issues/12 https://example.com/#12 https://example.com/a#12"), [])
    }

    func testDoesNotRunOnFromAWord() {
        XCTAssertEqual(spans("PR#12 a.ts#12 &#12; ##12 #12a #0 #1.5x x@#9"), ["issue:#1=#1"])
    }

    func testLeavesHeadingsAlone() {
        XCTAssertEqual(spans("# Title\n## 2. Steps\n### 12"), [])
    }

    func testAReferenceIsNeverAlsoAPath() {
        XCTAssertEqual(spans("example/widget#12 src/a.ts"), ["issue:example/widget#12=example/widget#12", "path:src/a.ts"])
    }

    func testRepositoryWithDotsAndHyphens() {
        XCTAssertEqual(spans("my-org/widget.js#7"), ["issue:my-org/widget.js#7=my-org/widget.js#7"])
    }

    func testFindsAbsoluteHomeAndRelativePaths() {
        let got = found("See /work/app/src/main.ts, ~/notes/todo.md and src/b.ts.")
        XCTAssertEqual(got.map(\.text), ["/work/app/src/main.ts", "~/notes/todo.md", "src/b.ts"])
        XCTAssertEqual(got.map(\.path), ["/work/app/src/main.ts", "~/notes/todo.md", "src/b.ts"])
        XCTAssertTrue(got.allSatisfy { $0.range == nil })
    }

    func testReadsLinesColumnsAndRanges() {
        let got = found("a.ts:12 b.ts:12:5 c.ts:12-20")
        XCTAssertEqual(got.map(\.text), ["a.ts:12", "b.ts:12:5", "c.ts:12-20"])
        XCTAssertEqual(got.map(\.range), [.line(line: 12, column: 1), .line(line: 12, column: 5), .lines(from: 12, to: 20)])
    }

    func testReadsGitHubAnchors() {
        let got = found("src/a.ts#L12 src/b.ts#L12-L20")
        XCTAssertEqual(got.map(\.path), ["src/a.ts", "src/b.ts"])
        XCTAssertEqual(got.map(\.range), [.line(line: 12, column: 1), .lines(from: 12, to: 20)])
    }

    func testGrepsPathLine() {
        XCTAssertEqual(found("src/a.ts:3:const a = 1;\nsrc/b.ts:14:  return b;").map(\.text), ["src/a.ts:3", "src/b.ts:14"])
    }

    func testEndedByQuotesBracketsAndCJK() {
        XCTAssertEqual(
            found("(\"src/a.ts\") [src/b.ts] `src/c.ts` 「src/d.ts」を読みました、src/e.ts。").map(\.path),
            ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"])
    }

    func testAPathWithASpaceIsTwoWords() {
        XCTAssertEqual(found("/work/my notes/a.md").map(\.path), ["/work/my", "notes/a.md"])
    }

    func testLeavesURLsFlagsAndFolders() {
        XCTAssertTrue(found("https://example.com/a/b.ts --out=dist Note: // and 1.5 then src/").isEmpty)
    }

    func testABareFileNameWithAnExtension() {
        XCTAssertEqual(found("Edit README.md and .gitignore").map(\.path), ["README.md"])
    }

    func testIgnoresLineZeroAndBackwardsRanges() {
        let got = found("a.ts:0 b.ts:20-12")
        XCTAssertEqual(got.map(\.text), ["a.ts", "b.ts:20-12"])
        XCTAssertEqual(got.map(\.range), [nil, .line(line: 20, column: 1)])
    }

    func testPathOfHref() {
        XCTAssertEqual(TextLinks.pathOfHref("src/a.ts"), PathCandidate(path: "src/a.ts", range: nil))
        XCTAssertEqual(TextLinks.pathOfHref("/abs/a.ts:12"), PathCandidate(path: "/abs/a.ts", range: .line(line: 12, column: 1)))
        XCTAssertEqual(TextLinks.pathOfHref("a.ts#L3-L5"), PathCandidate(path: "a.ts", range: .lines(from: 3, to: 5)))
        XCTAssertEqual(TextLinks.pathOfHref("file:///abs/my%20file.ts#L2"), PathCandidate(path: "/abs/my file.ts", range: .line(line: 2, column: 1)))
        XCTAssertEqual(TextLinks.pathOfHref("README"), PathCandidate(path: "README", range: nil))
        XCTAssertNil(TextLinks.pathOfHref("https://example.com/a.ts"))
        XCTAssertNil(TextLinks.pathOfHref("mailto:a@example.com"))
        XCTAssertNil(TextLinks.pathOfHref("#usage"))
        XCTAssertNil(TextLinks.pathOfHref(""))
    }

    func testRangeSuffix() {
        XCTAssertEqual(TextLinks.rangeSuffix(nil), "")
        XCTAssertEqual(TextLinks.rangeSuffix(.line(line: 3, column: 1)), ":3")
        XCTAssertEqual(TextLinks.rangeSuffix(.line(line: 3, column: 4)), ":3:4")
        XCTAssertEqual(TextLinks.rangeSuffix(.lines(from: 3, to: 9)), ":3-9")
    }

    func testIssueURLsAndTitles() {
        let here = IssueRepository(owner: "Example", repository: "Widget", titles: [12: "Fix it"])
        let bare = TextIssueReference(owner: nil, repository: nil, number: 12)
        XCTAssertEqual(IssueRepository.url(bare, here), "https://github.com/Example/Widget/issues/12")
        XCTAssertNil(IssueRepository.url(bare, nil))
        XCTAssertEqual(IssueRepository.tooltip(bare, here), "#12 Fix it")
        let named = TextIssueReference(owner: "example", repository: "widget", number: 12)
        XCTAssertEqual(IssueRepository.title(named, here), "Fix it")
        let other = TextIssueReference(owner: "other", repository: "widget", number: 12)
        XCTAssertNil(IssueRepository.title(other, here))
        XCTAssertEqual(IssueRepository.tooltip(other, here), "https://github.com/other/widget/issues/12")
    }
}
