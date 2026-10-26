// Port of apps/desktop/src/model/sshConfig.test.ts and
// apps/desktop/src/main/shell/settingsRefusal.test.ts
import XCTest
@testable import DevHubCore

final class SshConfigTests: XCTestCase {
    func aliases(_ contents: SshConfigContents) -> [String] { contents.hosts.map(\.alias) }

    func testReadsAPlainBlock() {
        let contents = SshConfig.parse("\nHost build\n  HostName build.example.com\n  User deploy\n  IdentityFile ~/.ssh/id_ed25519\n")
        XCTAssertEqual(contents.hosts, [SshConfigHost(alias: "build", hostName: "build.example.com", user: "deploy")])
    }

    func testGivesEveryAliasOnOneHostLineTheBlocksSettings() {
        let contents = SshConfig.parse("\nHost build staging\n  HostName shared.example.com\n")
        XCTAssertEqual(contents.hosts, [
            SshConfigHost(alias: "build", hostName: "shared.example.com"),
            SshConfigHost(alias: "staging", hostName: "shared.example.com"),
        ])
    }

    func testLeavesOutPatterns() {
        XCTAssertEqual(aliases(SshConfig.parse("""

            Host *
              ServerAliveInterval 60
            Host *.example.com
              User deploy
            Host !build *.internal
              User root
            Host api.example.com

            """)), ["api.example.com"])
    }

    func testAcceptsTheThreeSpellingsOpenSSHAcceptsAndAnyCase() {
        XCTAssertEqual(aliases(SshConfig.parse("\nhost one\nHOST=two\n  hostname two.example.com\nHost   =   three\n")), ["one", "two", "three"])
    }

    func testStepsOverCommentsAndBlankLinesAndOnlyWholeLineComments() {
        let contents = SshConfig.parse("\n# the build machine\n   # indented comment\n\nHost build\n  HostName build.example.com # this is not a comment to OpenSSH\n")
        XCTAssertEqual(contents.hosts, [SshConfigHost(alias: "build", hostName: "build.example.com")])
    }

    func testKeepsTheFirstValueBecauseOpenSSHDoes() {
        let contents = SshConfig.parse("\nHost build\n  HostName first.example.com\n  HostName second.example.com\n")
        XCTAssertEqual(contents.hosts.first?.hostName, "first.example.com")
    }

    func testDoesNotAttributeALaterBlocksSettingsToAnEarlierOne() {
        let contents = SshConfig.parse("\nHost build\n  HostName build.example.com\nHost staging\n  HostName staging.example.com\n")
        XCTAssertEqual(contents.hosts, [
            SshConfigHost(alias: "build", hostName: "build.example.com"),
            SshConfigHost(alias: "staging", hostName: "staging.example.com"),
        ])
    }

    func testCollectsIncludePatternsWithoutLookingForThem() {
        let contents = SshConfig.parse("\nInclude ~/.ssh/config.d/*.conf work/hosts\nInclude \"~/.ssh/my configs/*\"\nHost build\n")
        XCTAssertEqual(contents.includes, [
            SshConfigInclude(pattern: "~/.ssh/config.d/*.conf"),
            SshConfigInclude(pattern: "work/hosts"),
            SshConfigInclude(pattern: "~/.ssh/my configs/*"),
        ])
    }

    func testIgnoresEveryKeywordItDoesNotNeed() {
        let contents = SshConfig.parse("\nMatch host build exec \"true\"\n  User root\nHost api\n  ProxyJump bastion.example.com\n")
        XCTAssertEqual(aliases(contents), ["api"])
    }

    func testSaysNothingAboutAnEmptyFile() {
        XCTAssertEqual(SshConfig.parse(""), SshConfigContents(hosts: [], includes: []))
    }

    func testReadsCRLFFiles() {
        XCTAssertEqual(SshConfig.parse("Host a\r\n  HostName a.example.com\r\n").hosts, [SshConfigHost(alias: "a", hostName: "a.example.com")])
    }

    func testReadsInOrderAndTheFirstMentionOfAnAliasWins() {
        let included = SshConfig.parse("\nHost build\n  HostName included.example.com\n")
        let main = SshConfig.parse("\nHost build\n  HostName main.example.com\nHost api\n  HostName api.example.com\n")
        XCTAssertEqual(SshConfig.collectHosts([included, main]), [
            SshConfigHost(alias: "build", hostName: "included.example.com"),
            SshConfigHost(alias: "api", hostName: "api.example.com"),
        ])
    }

    func testIsEmptyWhenThereIsNothingToRead() {
        XCTAssertEqual(SshConfig.collectHosts([]), [])
    }
}

final class SettingsRefusalTests: XCTestCase {
    let file = "/scratch-test/devhub/settings.toml"

    func testIsOneNoticeNamingTheFileTheKeyAndTheReason() throws {
        let refusal = SettingsRefusal(file: file)
        let launch = refusal.atLaunch(ConfigError(code: .unsupportedVersion, path: "version", location: SourceLocation(line: 1, column: 1)))
        XCTAssertEqual(launch.code, "settings_refused")
        XCTAssertEqual(launch.summary, "DevHub could not use its settings file.")
        XCTAssertEqual(launch.detail, "\(file): version was refused (line 1, column 1): unsupported_version. DevHub is running on its defaults until the file is fixed.")
        XCTAssertEqual(launch.actions, ["open_settings"])
        XCTAssertEqual(launch.module, "config")
        XCTAssertEqual(try refusal.required(), launch)
    }

    func testIsTheSameNoticeWhenTheWatcherSeesTheFileRefusedBeforeAnyWasAccepted() throws {
        let atLaunch = SettingsRefusal(file: file).atLaunch(ConfigError(code: .unknownKey, path: "bogus"))
        let refusal = SettingsRefusal(file: file)
        let reload = refusal.onReload(ConfigDiagnostic(code: .unknownKey, path: "bogus"), running: false)
        XCTAssertTrue(reload.sameNotice(as: atLaunch))
        XCTAssertEqual(try refusal.required(), reload)
    }

    func testSaysTheLastAcceptedSettingsStayInEffectWhenTheFileIsRefusedLater() {
        let reload = SettingsRefusal(file: file).onReload(ConfigDiagnostic(code: .unknownKey, path: "bogus"), running: true)
        XCTAssertEqual(reload.code, "settings_refused")
        XCTAssertEqual(reload.detail, "\(file): bogus was refused: unknown_key. DevHub is still running on the last settings it accepted.")
    }

    func testNamesTheFileWhenTheLoadFailedForAReasonTheStoreDidNotName() {
        struct Denied: Error {}
        let launch = SettingsRefusal(file: file).atLaunch(Denied())
        XCTAssertEqual(launch.detail, "\(file): the file was refused: io. DevHub is running on its defaults until the file is fixed.")
    }

    func testIsOverOnceSettingsAreAccepted() {
        let refusal = SettingsRefusal(file: file)
        _ = refusal.atLaunch(ConfigError(code: .unknownKey, path: "bogus"))
        refusal.accepted()
        XCTAssertThrowsError(try refusal.required()) { error in
            XCTAssertTrue("\(error)".contains("no refusal"))
        }
    }

    func testKeepsTheFileAndTheKeyWhenItEndsAsText() {
        let launch = SettingsRefusal(file: file).atLaunch(ConfigError(code: .unknownKey, path: "bogus"))
        XCTAssertEqual(launch.text, "DevHub could not use its settings file. \(launch.detail)")
    }
}

final class MainLogTests: ScratchDirectoryTestCase {
    final class Printed: @unchecked Sendable {
        let lock = NSLock()
        var lines: [String] = []
        func add(_ line: String) { lock.lock(); lines.append(line); lock.unlock() }
        var all: [String] { lock.lock(); defer { lock.unlock() }; return lines }
    }

    func testLivesInTheLogFolderSettingsOpens() {
        XCTAssertEqual(MainLogLocation.mainLogPath(userData: "/u/DevHub"), "/u/DevHub/logs/\(MainLogLocation.fileName)")
        XCTAssertEqual(MainLogLocation.fileName, "devhub-main.log")
        let profile = ProfileLocations(profile: "default", home: "/Users/me", environment: [:])
        XCTAssertEqual(MainLogLocation.mainLogPath(userData: profile.userDataDirectory), profile.mainLogPath)
    }

    func testGetsEveryConsoleLineTimestampedAndLevelledAndTheConsoleStillGetsIt() throws {
        let printed = Printed()
        let file = Path.join(directory, "logs", MainLogLocation.fileName)
        let when = Date(timeIntervalSince1970: 1_792_921_267.123) // 2026-10-25T09:41:07.123Z
        let log = MainLog()
        log.install(path: file, console: { level, message in printed.add("\(level.rawValue) \(message)") }, now: { when })
        log.log(utilFormat(["[devhub] workbench '%s' awake", "/a"]))
        log.info("info")
        log.warn("careful")
        log.error("Error: broke")
        log.debug("detail")
        log.uninstall()
        log.log("after")

        XCTAssertEqual(Array(printed.all.prefix(5)), ["log [devhub] workbench '/a' awake", "info info", "warn careful", "error Error: broke", "debug detail"])
        let lines = try read(file).components(separatedBy: "\n")
        XCTAssertEqual(lines[0], "2026-10-25T09:41:07.123Z INFO  [devhub] workbench '/a' awake")
        XCTAssertEqual(lines[1], "2026-10-25T09:41:07.123Z INFO  info")
        XCTAssertEqual(lines[2], "2026-10-25T09:41:07.123Z WARN  careful")
        XCTAssertEqual(lines[3], "2026-10-25T09:41:07.123Z ERROR Error: broke")
        XCTAssertTrue(try read(file).contains("DEBUG detail"))
        XCTAssertFalse(try read(file).contains("after"))
    }

    func testAppendsToWhatAnEarlierRunWrote() throws {
        let file = Path.join(directory, MainLogLocation.fileName)
        try write(file, "earlier\n")
        let log = RotatingLog(path: file)
        log.write("now\n")
        log.close()
        XCTAssertEqual(try read(file), "earlier\nnow\n")
    }

    func testMovesTheFileAsidePastTheLimitKeepingOneOldOne() throws {
        let file = Path.join(directory, MainLogLocation.fileName)
        let log = RotatingLog(path: file, maxBytes: 20)
        log.write("0123456789\n")
        log.write("abcdefghi\n")
        log.write("ABCDEFGHI\n")
        log.write("second\n")
        log.close()
        XCTAssertEqual(try read(file + ".1"), "abcdefghi\nABCDEFGHI\n")
        XCTAssertEqual(try read(file), "second\n")
    }

    func testStartsAfreshOnAFileAnEarlierRunLeftPastTheLimit() throws {
        let file = Path.join(directory, MainLogLocation.fileName)
        try write(file, String(repeating: "x", count: 30))
        let log = RotatingLog(path: file, maxBytes: 20)
        log.write("new\n")
        log.close()
        XCTAssertEqual(FileSystem.size(file + ".1"), 30)
        XCTAssertEqual(try read(file), "new\n")
    }

    func testCarriesOnWhenTheFileWasDeletedFromUnderIt() throws {
        let file = Path.join(directory, MainLogLocation.fileName)
        let log = RotatingLog(path: file, maxBytes: 10)
        log.write("12345\n")
        try FileSystem.unlink(file)
        XCTAssertTrue(log.write("678901\n"))
        log.close()
        XCTAssertEqual(try read(file), "678901\n")
    }

    func testSaysOnceOnTheRealConsoleThatAFileCannotBeWritten() {
        let printed = Printed()
        let log = MainLog()
        // A directory where the file should be.
        log.install(path: directory, console: { level, message in printed.add("\(level.rawValue) \(message)") })
        log.log("one")
        log.log("two")
        log.uninstall()
        XCTAssertEqual(printed.all.filter { $0.contains("cannot be written") }.count, 1)
        XCTAssertTrue(printed.all.contains("log one"))
        XCTAssertTrue(printed.all.contains("log two"))
    }

    func testFormatsLikeTheConsoleOneLinePerCall() {
        XCTAssertEqual(logLine(.warn, Date(timeIntervalSince1970: 0), ["%d workbenches", 3, "awake"]), "1970-01-01T00:00:00.000Z WARN  3 workbenches awake\n")
        XCTAssertEqual(utilFormat(["100%% %s", "done", 1.5]), "100% done 1.5")
    }
}
