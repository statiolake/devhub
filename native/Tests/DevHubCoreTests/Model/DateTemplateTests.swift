// Port of apps/desktop/src/model/dateTemplate.test.ts and scratchDay.test.ts
import XCTest
@testable import DevHubCore

final class DateTemplateTests: XCTestCase {
    // A Tuesday afternoon, chosen so every token has a distinguishable value.
    let now = LocalMoment(year: 2026, month: 9, day: 1, hour: 14, minute: 25, second: 36)

    func testExpandsTheTokensADailyFolderIsNamedWith() {
        XCTAssertEqual(DateTemplate.expand("~/workspace/daily/YYYY/MMDD", now: now), "~/workspace/daily/2026/0901")
    }

    func testReadsMMDDAsOneToken() {
        XCTAssertEqual(DateTemplate.expand("MMDD", now: now), "0901")
        XCTAssertEqual(DateTemplate.expand("MM-DD", now: now), "09-01")
    }

    func testKnowsTheRestOfMomentsTokens() {
        XCTAssertEqual(DateTemplate.expand("YY HH:mm:ss", now: now), "26 14:25:36")
    }

    func testPassesBracketedTextThroughVerbatim() {
        XCTAssertEqual(DateTemplate.expand("~/YYYY/MMDD/[DDta]", now: now), "~/2026/0901/DDta")
    }

    func testLeavesAPathWithNoTokensAlone() {
        XCTAssertEqual(DateTemplate.expand("~/workspace/scratch", now: now), "~/workspace/scratch")
    }

    func testTakesTheRestLiterallyAfterAnUnclosedBracket() {
        XCTAssertEqual(DateTemplate.expand("~/YYYY/[DD", now: now), "~/2026/DD")
    }

    func testSaysWhetherTheBracketsBalance() {
        XCTAssertTrue(DateTemplate.bracketsBalance("~/YYYY/[DD]"))
        XCTAssertTrue(DateTemplate.bracketsBalance("~/YYYY/MMDD"))
        XCTAssertFalse(DateTemplate.bracketsBalance("~/YYYY/[DD"))
        XCTAssertFalse(DateTemplate.bracketsBalance("~/YYYY/DD]"))
    }

    func testNamesTheSegmentTheTokenAndTheWayToWriteIt() {
        XCTAssertEqual(DateTemplate.ambiguity("~/Documents/summaries/YYYY"), DateTemplateAmbiguity(segment: "summaries", token: "mm", escaped: "[summaries]"))
    }

    func testTakesABracketedSegmentAtItsWord() {
        XCTAssertNil(DateTemplate.ambiguity("~/Documents/[summaries]/YYYY"))
    }

    func testLeavesASegmentThatIsOnlyADateAlone() {
        XCTAssertNil(DateTemplate.ambiguity("~/YYYY-MM-DD"))
        XCTAssertNil(DateTemplate.ambiguity("~/YYYY/MMDD"))
    }

    func testCatchesAWordTheTokenIsStuckTo() {
        XCTAssertEqual(DateTemplate.ambiguity("~/logsYYYY"), DateTemplateAmbiguity(segment: "logsYYYY", token: "YYYY", escaped: "[logsYYYY]"))
    }

    func testPassesTheDailyFolderDevHubShipsWith() {
        XCTAssertNil(DateTemplate.ambiguity("~/workspace/daily/YYYY/MMDD"))
    }
}

final class ScratchDayTests: XCTestCase {
    func scratchSetting(_ daily: String) -> String {
        "version = 2\n[scratch]\ndaily = \(TomlDocument.renderString(daily))\n"
    }

    func testDefaultsToJunkYYYYMMDD() throws {
        XCTAssertEqual(try ConfigParsing.parse("version = 2\n").scratch.daily, "~/junk/YYYYMMDD")
        XCTAssertEqual(Config.defaults.scratch.daily, ScratchDaily.defaultTemplate)
    }

    func testReadsACustomValueAndWritesItBack() throws {
        let config = try ConfigParsing.parse(scratchSetting("/data/[daily]/YYYY/MM-DD"))
        XCTAssertEqual(config.scratch.daily, "/data/[daily]/YYYY/MM-DD")
        XCTAssertEqual(try ConfigParsing.parse(ConfigParsing.toToml(config)).scratch.daily, "/data/[daily]/YYYY/MM-DD")
    }

    func testRefusesWhatIsNotOneFolderPerDay() {
        for daily in ["~/junk", "~/junk/YYYYMMDD-HH", "~/junk/YYYY/MM", "~/[junk/YYYYMMDD", "~/summaries/YYYYMMDD", "junk/YYYYMMDD"] {
            XCTAssertEqual(configCodeOf { try ConfigParsing.parse(self.scratchSetting(daily)) }, .invalidScratchDaily, daily)
        }
        XCTAssertEqual(ScratchDaily.problem("~/junk/YYYYMMDD-HH"), .notOneDay)
        XCTAssertEqual(ScratchDaily.problem("~/junk"), .notOneDay)
        XCTAssertEqual(ScratchDaily.problem("~/[junk/YYYYMMDD"), .unbalancedBrackets)
        XCTAssertEqual(ScratchDaily.problem("~/summaries/YYYYMMDD"), .ambiguous(segment: "summaries"))
        XCTAssertEqual(ScratchDaily.problem("junk/YYYYMMDD"), .notAPath)
    }

    func testRefusesAnUnknownKeyInTheTable() {
        XCTAssertEqual(configCodeOf { try ConfigParsing.parse("version = 2\n[scratch]\nfolder = \"~/x\"\n") }, .unknownKey)
    }

    func testNamesTheLocalDay() throws {
        let now = LocalMoment(year: 2026, month: 9, day: 3, hour: 23, minute: 59)
        XCTAssertEqual(try ScratchDaily.path("~/junk/YYYYMMDD", now: now), "~/junk/20260903")
        XCTAssertEqual(try ScratchDaily.path("/d/YYYY/MMDD/[DD]", now: now), "/d/2026/0903/DD")
    }

    func testThrowsOnATemplateTheSettingsReaderRefuses() {
        XCTAssertThrowsError(try ScratchDaily.path("~/junk/HH", now: LocalMoment(Date())))
    }

    func testExpandsTildeAgainstTheGivenHome() {
        XCTAssertEqual(ScratchDaily.expandHome("~/junk/20260903", home: "/home/testuser"), "/home/testuser/junk/20260903")
        XCTAssertEqual(ScratchDaily.expandHome("/abs/x", home: "/home/testuser"), "/abs/x")
        XCTAssertEqual(ScratchDaily.expandHome("~", home: "/home/testuser"), "/home/testuser")
        XCTAssertEqual(ScratchDaily.expandHome("~/x", home: "/home/testuser//"), "/home/testuser/x")
    }

    func date(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 0, _ min: Int = 0, _ s: Int = 0, _ zone: TimeZone) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min, second: s))!
    }

    func testNextLocalMidnightIsTheFirstInstantOfTheNextLocalDay() {
        for zone in [TimeZone(identifier: "Asia/Tokyo")!, TimeZone(identifier: "America/New_York")!, TimeZone(identifier: "UTC")!] {
            XCTAssertEqual(ScratchDaily.nextLocalMidnight(date(2026, 9, 22, 13, 5, 0, zone), timeZone: zone), date(2026, 9, 23, 0, 0, 0, zone))
            XCTAssertEqual(ScratchDaily.nextLocalMidnight(date(2026, 12, 31, 23, 59, 59, zone), timeZone: zone), date(2027, 1, 1, 0, 0, 0, zone))
            XCTAssertEqual(ScratchDaily.nextLocalMidnight(date(2026, 9, 23, 0, 0, 0, zone), timeZone: zone), date(2026, 9, 24, 0, 0, 0, zone))
        }
        // A 23-hour day still ends at its own midnight.
        let york = TimeZone(identifier: "America/New_York")!
        XCTAssertEqual(ScratchDaily.nextLocalMidnight(date(2026, 3, 8, 1, 0, 0, york), timeZone: york), date(2026, 3, 9, 0, 0, 0, york))
    }

    func testMakesTodaysFolderAndSaysWhenItCannot() throws {
        let home = NSTemporaryDirectory() + "devhub-wp1-scratch-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: home) }
        let made = try ScratchFolder.make(daily: "~/junk/YYYYMMDD", now: Date(), home: home)
        XCTAssertNil(made.failure)
        XCTAssertTrue(FileSystem.isDirectory(made.path))
        XCTAssertTrue(made.path.hasSuffix(DateTemplate.expand("junk/YYYYMMDD", now: Date())))

        try "x".write(toFile: home + "/file", atomically: false, encoding: .utf8)
        let refused = try ScratchFolder.make(daily: "~/file/YYYYMMDD", now: Date(), home: home)
        XCTAssertNotNil(refused.failure)
        XCTAssertTrue(refused.failure!.hasPrefix("Today's Scratch folder \(home)/file/"))
    }

    /// realpath(3), as every Workspace root: a folder reached through a
    /// symlink (`/tmp` → `/private/tmp` on macOS) is named by where it is,
    /// or tmux refuses its ws- session as a root that canonicalises elsewhere.
    func testNamesTodaysFolderByItsRealPathThroughASymlink() throws {
        let home = try localRealpath(NSTemporaryDirectory()) + "/devhub-scratch-link-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: home) }
        try FileManager.default.createDirectory(atPath: home + "/real", withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(atPath: home + "/link", withDestinationPath: home + "/real")
        let made = try ScratchFolder.make(daily: "~/link/YYYYMMDD", now: Date(), home: home)
        XCTAssertNil(made.failure)
        XCTAssertEqual(made.path, "\(home)/real/\(DateTemplate.expand("YYYYMMDD", now: Date()))")
        XCTAssertEqual(made.path, try localRealpath(made.path))
    }

    func testTheFollowerAdoptsANewDailyAtOnce() async throws {
        let home = NSTemporaryDirectory() + "devhub-wp1-follow-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: home) }
        actor Adopted {
            var paths: [String] = []
            func add(_ path: String) { paths.append(path) }
        }
        let adopted = Adopted()
        let follower = ScratchFollower(daily: "~/a/YYYYMMDD", home: home) { folder in
            await adopted.add(folder.path)
        }
        await follower.start()
        await follower.settingsAccepted(daily: "~/a/YYYYMMDD")
        await follower.settingsAccepted(daily: "~/b/YYYYMMDD")
        await follower.stop()
        let paths = await adopted.paths
        XCTAssertEqual(paths.count, 1)
        XCTAssertTrue(paths[0].contains("/b/"))
    }
}
