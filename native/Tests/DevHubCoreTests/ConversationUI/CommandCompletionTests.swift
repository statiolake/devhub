// Port of commandCompletion.test.ts and skillTokens.test.tsx.

import XCTest
@testable import DevHubCore

final class CommandCompletionTests: XCTestCase {
    func command(_ name: String, _ route: SlashRoute = .message, _ trigger: SlashTrigger = .slash) -> SlashCommand {
        SlashCommand(trigger: trigger, name: name, description: "", argumentHint: nil, route: route)
    }

    func testStartOfMessage() {
        let query = CommandCompletion.query("/re")
        XCTAssertEqual(query?.trigger, .slash)
        XCTAssertEqual(query?.name, "re")
        XCTAssertEqual(query?.start, 0)
        XCTAssertEqual(query?.leading, true)
        XCTAssertEqual(CommandCompletion.query("/")?.name, "")
    }

    func testASlashAfterWhitespace() {
        XCTAssertEqual(CommandCompletion.query("please /re")?.start, 7)
        XCTAssertEqual(CommandCompletion.query("please /re")?.leading, false)
        XCTAssertEqual(CommandCompletion.query("a\n/re")?.start, 2)
        let mid = CommandCompletion.query("go /re and more", caret: 6)
        XCTAssertEqual(mid?.name, "re")
        XCTAssertEqual(mid?.start, 3)
        XCTAssertEqual(mid?.end, 6)
    }

    func testASlashAfterJapaneseOrABracket() {
        XCTAssertEqual(CommandCompletion.query("これを/re")?.start, 3)
        XCTAssertEqual(CommandCompletion.query("これは　/re")?.name, "re")
        XCTAssertEqual(CommandCompletion.query("(/re")?.name, "re")
    }

    func testIgnoresPathsAndURLs() {
        for text in ["src/foo", "a/b", "~/x", "./x", "../x", "see https://x.dev/re", "foo //re", "/usr/bin", "word1/re"] {
            XCTAssertNil(CommandCompletion.query(text), text)
        }
    }

    func testADollarAfterWhitespaceOnly() {
        XCTAssertEqual(CommandCompletion.query("use $re")?.trigger, .dollar)
        XCTAssertEqual(CommandCompletion.query("use $re")?.start, 4)
        XCTAssertNil(CommandCompletion.query("a$re"))
    }

    func testACaretNotAtAName() {
        XCTAssertNil(CommandCompletion.query("/re x", caret: 5))
    }

    func testCompletedReplacesOnlyTheToken() {
        let text = "please /re and more"
        let done = CommandCompletion.completed(text, CommandCompletion.query(text, caret: 10)!, command("review"))
        XCTAssertEqual(done.text, "please /review and more")
        XCTAssertEqual(done.caret, 15)
        let end = CommandCompletion.completed("do /re", CommandCompletion.query("do /re")!, command("review"))
        XCTAssertEqual(end.text, "do /review ")
        XCTAssertEqual(end.caret, 11)
    }

    func testCompletions() {
        let all = [command("review"), command("clear"), command("model", .model), command("compact"), command("release", .message, .dollar)]
        XCTAssertEqual(CommandCompletion.completions(all, CommandCompletion.query("/")!).map(\.name), ["review", "clear", "model", "compact"])
        XCTAssertEqual(CommandCompletion.completions(all, CommandCompletion.query("so /")!).map(\.name), ["review"])
    }

    func testInputHistory() {
        let transcript = TranscriptFixtures.transcript([
            TranscriptFixtures.put(TranscriptFixtures.user("1", "a")),
            TranscriptFixtures.put(TranscriptFixtures.user("2", "a")),
            TranscriptFixtures.put(TranscriptFixtures.user("3", "t", origin: .injection)),
            TranscriptFixtures.put(TranscriptFixtures.user("4", "b")),
        ])
        XCTAssertEqual(CommandCompletion.inputHistory(transcript), ["b", "a"])
    }

    // MARK: skillTokens.test.tsx

    lazy var words = SkillTokens.words([command("review"), command("plugin:skill"), command("release-notes", .message, .dollar)])

    func skills(_ text: String) -> [String] { SkillTokens.tokenize(text, words).filter(\.skill).map(\.text) }

    func testMarksAKnownCommand() {
        XCTAssertEqual(skills("/review src/a.ts"), ["/review"])
        XCTAssertEqual(skills("/plugin:skill go"), ["/plugin:skill"])
        XCTAssertEqual(skills("/foo bar"), [])
    }

    func testMarksAKnownSkillMidSentence() {
        XCTAssertEqual(skills("please /review"), ["/review"])
        XCTAssertEqual(skills("これを/reviewして"), ["/review"])
        XCTAssertEqual(skills("(/review)"), ["/review"])
    }

    func testABuiltInMidSentenceIsPlain() {
        let builtIn = SkillTokens.words([command("clear"), command("review")])
        XCTAssertEqual(SkillTokens.tokenize("/clear", builtIn).filter(\.skill).map(\.text), ["/clear"])
        XCTAssertEqual(SkillTokens.tokenize("then /clear", builtIn).filter(\.skill).map(\.text), [])
    }

    func testPathsAndURLsArePlain() {
        for text in ["src/review", "a/review", "~/review", "./review", "see https://x.dev/review", "x //review"] {
            XCTAssertEqual(skills(text), [], text)
        }
    }

    func testDollarSkills() {
        XCTAssertEqual(skills("use $release-notes\nthen $release-notes"), ["$release-notes", "$release-notes"])
        XCTAssertEqual(skills("a$release-notes"), [])
        XCTAssertEqual(skills("$review"), [])
    }

    func testTrailingPunctuationAndRoundTrip() {
        XCTAssertEqual(SkillTokens.tokenize("/review.", words), [TextSegment(text: "/review", skill: true), TextSegment(text: ".", skill: false)])
        let text = "/review a $release-notes, \n$nope é"
        XCTAssertEqual(SkillTokens.tokenize(text, words).map(\.text).joined(), text)
        XCTAssertEqual(SkillTokens.tokenize("/review", []), [TextSegment(text: "/review", skill: false)])
    }
}
