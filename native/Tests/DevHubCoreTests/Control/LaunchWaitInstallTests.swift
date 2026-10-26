// Port of apps/desktop/src/main/cli/launch.test.ts, wait.test.ts,
// stdin.test.ts and install.test.ts.

import Foundation
import XCTest
@testable import DevHubCore

private let testSocket = "/tmp/devhub-test/control.sock"
private let launchDescription = "/usr/bin/open -a /Applications/DevHub.app --background"

/// A DevHub that answers after `answersAfter` probes, or never. Time moves
/// only when the code under test waits.
private final class LaunchFakeLauncher: DevhubLauncher, @unchecked Sendable {
    let answersAfter: Int?
    let opens: Bool
    private let lock = NSLock()
    private var _opened: [String] = []
    private var _probes = 0
    private var clock = 0.0

    init(answersAfter: Int?, opens: Bool = true) {
        self.answersAfter = answersAfter
        self.opens = opens
    }

    var opened: [String] { lock.withLock { _opened } }
    var probes: Int { lock.withLock { _probes } }
    var description: String { launchDescription }
    var socketPath: String { testSocket }

    func cannotStart(_ reason: String) -> String {
        "DevHub is not running, and it could not be started: \(reason)\nThe 'devhub' launcher starts DevHub with \(launchDescription). If DevHub has moved, run \"DevHub: Install 'devhub' command in PATH\" from DevHub's command palette again."
    }

    func open() async throws -> Never {
        lock.withLock { _opened.append(launchDescription) }
        if !opens { throw DevhubFailure("spawn ENOENT") }
        while true { try await Task.sleep(for: .seconds(3600)) }
    }

    func answers() async -> Bool {
        lock.withLock {
            _probes += 1
            return answersAfter.map { _probes >= $0 } ?? false
        }
    }

    func pause(milliseconds: Int) async throws { lock.withLock { clock += Double(milliseconds) } }
    func now() -> Double { lock.withLock { clock } }
}

private let answer = ControlResponse(ok: true, message: "Opened README.md.")

final class LaunchTests: XCTestCase {
    func testAsksTheDevHubThatIsAlreadyRunningAndStartsNothing() async throws {
        let launcher = LaunchFakeLauncher(answersAfter: 1)
        let response = try await DevhubLaunch.sendOrLaunch({ answer }, launcher: launcher)
        XCTAssertEqual(response, answer)
        XCTAssertEqual(launcher.opened, [])
    }

    func testStartsDevHubWaitsForItsSocketAndSendsTheRequestAgain() async throws {
        let launcher = LaunchFakeLauncher(answersAfter: 4)
        let sends = WP7Counter()
        let response = try await DevhubLaunch.sendOrLaunch(
            {
                sends.increment()
                if launcher.opened.isEmpty { throw DevHubNotRunning() }
                return answer
            }, launcher: launcher)
        XCTAssertEqual(launcher.opened, [launchDescription])
        XCTAssertEqual(launcher.probes, 4)
        XCTAssertEqual(sends.value, 2)
        XCTAssertEqual(response, answer)
    }

    func testSaysThatItTriedToStartDevHubAndCouldNot() async {
        let launcher = LaunchFakeLauncher(answersAfter: nil, opens: false)
        let error = await wp7Caught { try await DevhubLaunch.launchAndWait(launcher) }
        let text = "\(error!)"
        XCTAssertTrue(text.contains("could not be started: spawn ENOENT"), text)
        XCTAssertTrue(text.contains("starts DevHub with /usr/bin/open -a"), text)
    }

    func testGivesUpOnADevHubThatNeverAnswersNamingTheSocketAndTheApp() async {
        let launcher = LaunchFakeLauncher(answersAfter: nil)
        let error = await wp7Caught { try await DevhubLaunch.launchAndWait(launcher) }
        XCTAssertEqual(
            "\(error!)",
            "DevHub was started with \(launchDescription), but nothing was listening on \(testSocket) within 30 seconds.")
        XCTAssertEqual(launcher.opened, [launchDescription])
        XCTAssertGreaterThanOrEqual(launcher.now(), Double(launchTimeoutMs))
        XCTAssertGreaterThan(launcher.probes, 1)
    }

    func testDoesNotStartDevHubBecauseSomeOtherRequestFailed() async {
        let launcher = LaunchFakeLauncher(answersAfter: 1)
        let error = await wp7Caught {
            try await DevhubLaunch.sendOrLaunch({ throw DevhubFailure("DevHub closed the connection") }, launcher: launcher)
        }
        XCTAssertTrue("\(error!)".contains("closed the connection"))
        XCTAssertEqual(launcher.opened, [])
    }

    func testOpensTheRunningBundleInTheBackgroundOrRunsTheExecutableItself() {
        XCTAssertEqual(
            DevhubLaunch.launchCommand(forAppExecutable: "/Applications/DevHub.app/Contents/MacOS/DevHub"),
            ["/usr/bin/open", "-a", "/Applications/DevHub.app", "--background"])
        XCTAssertEqual(
            DevhubLaunch.launchCommand(forAppExecutable: "/src/native/.build/debug/DevHubApp"),
            ["/src/native/.build/debug/DevHubApp"])
    }

    func testReadsTheRecordedCommandBackAndRefusesALauncherThatHasNone() throws {
        XCTAssertEqual(try DevhubLaunch.parseLaunchCommand(#"["/usr/bin/open","-a","/x.app"]"#), ["/usr/bin/open", "-a", "/x.app"])
        XCTAssertThrowsError(try DevhubLaunch.parseLaunchCommand(nil)) { error in
            XCTAssertTrue("\(error)".contains("DEVHUB_LAUNCH_COMMAND is not set"))
            XCTAssertTrue("\(error)".contains("Install 'devhub' command in PATH"))
        }
        XCTAssertThrowsError(try DevhubLaunch.parseLaunchCommand("[]")) { XCTAssertTrue("\($0)".contains("is not a command")) }
        XCTAssertThrowsError(try DevhubLaunch.parseLaunchCommand(#""open""#)) { XCTAssertTrue("\($0)".contains("is not a command")) }
    }

    func testReportsALaunchCommandThatCannotBeStartedOrExitsNonZero() async {
        let missing = await wp7Caught { try await CommandLauncher(socketPath: testSocket, command: ["/no/such/devhub-launcher"]).open() }
        XCTAssertTrue("\(missing!)".contains("ENOENT"), "\(missing!)")
        let failing = await wp7Caught { try await CommandLauncher(socketPath: testSocket, command: ["/bin/sh", "-c", "exit 3"]).open() }
        XCTAssertTrue("\(failing!)".contains("exited with status 3"), "\(failing!)")
    }

    func testSaysNothingAboutALaunchCommandThatStarted() async throws {
        let task = Task { try await CommandLauncher(socketPath: testSocket, command: ["/bin/sh", "-c", "exit 0"]).open() }
        try await Task.sleep(for: .milliseconds(300))
        // Still waiting: neither outcome. Cancelled, it ends quietly.
        task.cancel()
        let result = await task.result
        if case let .failure(error) = result {
            XCTAssertTrue(error is CancellationError, "\(error)")
        }
    }

    func testTheLauncherForAMachineDevHubDoesNotRunOn() async {
        let remote = "/home/dev/.devhub/terminal/control-abcdef.sock"
        let launcher = ForwardedSocketLauncher(socketPath: remote, machine: "ssh:build-host")
        let error = await wp7Caught { try await launcher.open() }
        XCTAssertEqual("\(error!)", "DevHub is not listening on \(remote).")
        let said = launcher.cannotStart("ignored")
        XCTAssertTrue(said.contains("DevHub is not listening on \(remote)."))
        XCTAssertTrue(said.contains("ssh:build-host"))
        XCTAssertFalse(said.contains("Install 'devhub' command in PATH"))
        XCTAssertEqual(launcher.socketPath, remote)
        let answers = await launcher.answers()
        XCTAssertFalse(answers)
    }
}

/// A DevHub that closes the editor after `closesAfter` looks, and may have
/// stopped by then. Nothing sleeps: `pause` only counts.
private final class LaunchFakeWaitWorld: WaitWorld, @unchecked Sendable {
    let closesAfter: Int?
    let stopsAfter: Int?
    private let lock = NSLock()
    private var looks = 0
    private(set) var pauses = 0

    init(closesAfter: Int?, stopsAfter: Int? = nil) {
        self.closesAfter = closesAfter
        self.stopsAfter = stopsAfter
    }

    var socketPath: String { "/nowhere/control.sock" }

    func markerExists() async -> Bool {
        lock.withLock {
            looks += 1
            return closesAfter.map { looks < $0 } ?? true
        }
    }

    func devhubAnswers() async -> Bool { lock.withLock { stopsAfter.map { looks < $0 } ?? true } }
    func pause(milliseconds: Int) async throws { lock.withLock { pauses += 1 } }
}

/// A listener that accepts, reads, and either answers a ping or never says a word.
private final class LaunchPingListener: @unchecked Sendable {
    let path: String
    private let listener: Int32
    private let held = NSLock()
    private var connections: [Int32] = []

    init(path: String, answers: Bool) throws {
        self.path = path
        listener = try UnixStream.listen(path)
        let listener = self.listener
        Thread { [self] in
            while let fd = try? UnixStream.accept(listener) {
                held.withLock { connections.append(fd) }
                if answers {
                    _ = try? UnixStream.read(fd)
                    try? UnixStream.write(fd, ControlResponse(ok: true, message: "DevHub is running.").line)
                    UnixStream.shutdownWrite(fd)
                }
            }
        }.start()
    }

    func stop() {
        for fd in held.withLock({ connections }) { UnixStream.shutdownBoth(fd) }
        UnixStream.shutdownBoth(listener)
        if let wake = try? UnixStream.connect(path) { UnixStream.close(wake) }
    }
}

final class WaitTests: XCTestCase {
    func testReturnsAsSoonAsTheMarkerIsGone() async throws {
        let world = LaunchFakeWaitWorld(closesAfter: 3)
        try await DevhubWait.waitForClose(world)
        XCTAssertEqual(world.pauses, 2)
    }

    func testReturnsImmediatelyWhenTheMarkerWasAlreadyGone() async throws {
        let world = LaunchFakeWaitWorld(closesAfter: 1)
        try await DevhubWait.waitForClose(world)
        XCTAssertEqual(world.pauses, 0)
    }

    func testStopsWithASentenceWhenDevHubGoesAwayFirst() async {
        let error = await wp7Caught { try await DevhubWait.waitForClose(LaunchFakeWaitWorld(closesAfter: nil, stopsAfter: 3)) }
        XCTAssertEqual(
            "\(error!)",
            "DevHub is not listening on /nowhere/control.sock: it stopped while the file was still open, so the file was never closed and nothing was saved by closing it."
        )
    }

    func testCountsAMarkerDeletedOnTheWayOutAsTheEditorBeingClosed() async throws {
        try await DevhubWait.waitForClose(LaunchFakeWaitWorld(closesAfter: 2, stopsAfter: 2))
    }

    func testMakesAPrivateMarkerAndTakesTheWholeDirectoryAwayAgain() throws {
        let scratch = try wp7SocketDirectory("wait")
        defer { wp7RemoveDirectory(scratch) }
        let marker = try DevhubWait.createMarker(temporaryDirectory: scratch)
        let directory = (marker as NSString).deletingLastPathComponent
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker))
        XCTAssertEqual(try wp7Permissions(marker), 0o600)
        XCTAssertEqual(try wp7Permissions(directory), 0o700)
        XCTAssertTrue(directory.contains("devhub-wait-"))
        let second = try DevhubWait.createMarker(temporaryDirectory: scratch)
        XCTAssertNotEqual((second as NSString).deletingLastPathComponent, directory)
        DevhubWait.removeMarker(marker)
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker))
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory))
        // Removing one that is already gone is not a failure.
        DevhubWait.removeMarker(marker)
    }

    func testReadsARealMarkerOffTheDiskAndASilentSocketIsNoDevHub() async throws {
        let scratch = try wp7SocketDirectory("wait-real")
        defer { wp7RemoveDirectory(scratch) }
        let marker = try DevhubWait.createMarker(temporaryDirectory: scratch)
        let world = MarkerWaitWorld(markerPath: marker, socketPath: scratch + "/no.sock")
        let there = await world.markerExists()
        XCTAssertTrue(there)
        let answers = await world.devhubAnswers()
        XCTAssertFalse(answers)
        DevhubWait.removeMarker(marker)
        let gone = await world.markerExists()
        XCTAssertFalse(gone)
    }

    /// Over `ssh -R` the listening socket belongs to the host's sshd, so it
    /// accepts after the DevHub behind it has quit: a wait that ended only on
    /// a refused connection waited forever.
    func testEndsTheWaitWhenTheSocketAcceptsAndNeverAnswers() async throws {
        let scratch = try wp7SocketDirectory("wait-silent")
        defer { wp7RemoveDirectory(scratch) }
        let silent = try LaunchPingListener(path: scratch + "/accepts.sock", answers: false)
        defer { silent.stop() }
        let quick = await ControlClient.socketAnswers(silent.path, timeoutMs: 50)
        XCTAssertFalse(quick)
        let marker = try DevhubWait.createMarker(temporaryDirectory: scratch)
        struct Silent: WaitWorld {
            let marker: MarkerWaitWorld
            var socketPath: String { marker.socketPath }
            func markerExists() async -> Bool { await marker.markerExists() }
            func devhubAnswers() async -> Bool { await ControlClient.socketAnswers(socketPath, timeoutMs: 50) }
            func pause(milliseconds: Int) async throws {}
        }
        let error = await wp7Caught {
            try await DevhubWait.waitForClose(Silent(marker: MarkerWaitWorld(markerPath: marker, socketPath: silent.path)))
        }
        XCTAssertTrue("\(error!)".hasPrefix("DevHub is not listening on \(silent.path)"))
    }

    func testKeepsWaitingWhileTheSocketAnswersThePing() async throws {
        let scratch = try wp7SocketDirectory("wait-answers")
        defer { wp7RemoveDirectory(scratch) }
        let listener = try LaunchPingListener(path: scratch + "/answers.sock", answers: true)
        defer { listener.stop() }
        let answers = await ControlClient.socketAnswers(listener.path, timeoutMs: 1_000)
        XCTAssertTrue(answers)
    }

    // MARK: stdin.ts

    func testSpoolsStdinToAPrivateFileByteForByteAndNeverOverAnotherOne() throws {
        let scratch = try wp7SocketDirectory("stdin")
        defer { wp7RemoveDirectory(scratch) }
        let bytes: [UInt8] = [0x00, 0xff, 0xfe, 0x0a, 0x80] + Array(repeating: 0x61, count: 200_000)
        let pipe = Pipe()
        let writer = Thread {
            pipe.fileHandleForWriting.write(Data(bytes))
            try? pipe.fileHandleForWriting.close()
        }
        writer.start()
        let path = DevhubWait.stdinSpoolPath(scratch)
        XCTAssertTrue(path.contains("devhub-stdin-"))
        try DevhubWait.spoolStdin(from: pipe.fileHandleForReading, to: path)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), Data(bytes))
        XCTAssertEqual(try wp7Permissions(path), 0o600)
        // A fresh name each time.
        XCTAssertEqual(Set((0..<50).map { _ in DevhubWait.stdinSpoolPath(scratch) }).count, 50)
        // The name is meant to be fresh: one that is not is refused.
        try "someone else's".write(toFile: path + "x", atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try DevhubWait.spoolStdin(from: FileHandle.nullDevice, to: path + "x")) { error in
            XCTAssertEqual((error as? UnixStream.Failure)?.code, EEXIST)
        }
        XCTAssertEqual(try String(contentsOfFile: path + "x", encoding: .utf8), "someone else's")
    }
}

func wp7Permissions(_ path: String) throws -> Int {
    (try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber)?.intValue ?? -1
}

final class InstallTests: XCTestCase {
    var scratch = ""

    override func setUpWithError() throws {
        scratch = try wp7SocketDirectory("install")
    }

    override func tearDown() {
        wp7RemoveDirectory(scratch)
    }

    func request(_ candidates: [String]? = nil, pathValue: String = "/usr/bin:/bin") -> InstallRequest {
        InstallRequest(
            executable: scratch + "/DevHub.app/Contents/Resources/bin/devhub",
            socketPath: scratch + "/user-data/devhub/control.sock", commandName: "devhub", profile: "default",
            launchCommand: ["/usr/bin/open", "-a", "/Applications/DevHub.app"], home: scratch, pathValue: pathValue,
            candidates: candidates)
    }

    func testWritesAnExecutableLauncherIntoTheFirstWritableCandidate() throws {
        let first = scratch + "/first"
        try FileManager.default.createDirectory(atPath: first, withIntermediateDirectories: true)
        let result = try DevhubInstall.installLauncher(request([first, scratch + "/second"]))
        XCTAssertEqual(result.launcherPath, first + "/devhub")
        XCTAssertEqual(try wp7Permissions(result.launcherPath), 0o755)
        let script = try String(contentsOfFile: result.launcherPath, encoding: .utf8)
        XCTAssertTrue(script.hasPrefix("#!/bin/sh\n# Generated by DevHub — do not edit.\n"))
        XCTAssertTrue(script.contains("exec '\(scratch)/DevHub.app/Contents/Resources/bin/devhub' \"$@\""))
    }

    func testRecordsHowToStartDevHubSoTheCLIDoesNotHaveToGuess() async throws {
        let launcher = scratch + "/bin"
        var install = request([launcher])
        install.launchCommand = ["/usr/bin/open", "-a", "/Applications/My DevHub.app"]
        let result = try DevhubInstall.installLauncher(install)
        let script = try String(contentsOfFile: result.launcherPath, encoding: .utf8)
        let line = try XCTUnwrap(script.split(separator: "\n").first { $0.hasPrefix("DEVHUB_LAUNCH_COMMAND=") })
        let assignment = String(line.dropLast(2))
        // Read back through a shell rather than by unquoting it here.
        let output = try await ProcessRunner().run("/bin/sh", ["-c", "\(assignment); printf %s \"$DEVHUB_LAUNCH_COMMAND\""])
        XCTAssertEqual(try DevhubLaunch.parseLaunchCommand(output.stdoutText), ["/usr/bin/open", "-a", "/Applications/My DevHub.app"])
    }

    func testTheLauncherRunsTheCLIWithItsSocketItsProfileAndItsLaunchCommand() async throws {
        let bin = scratch + "/bin"
        var install = request([bin])
        let fake = scratch + "/fake-devhub"
        try "#!/bin/sh\nprintf '%s|%s|%s|%s' \"$DEVHUB_CONTROL_SOCKET\" \"$DEVHUB_PROFILE\" \"$DEVHUB_LAUNCH_COMMAND\" \"$*\"\n"
            .write(toFile: fake, atomically: true, encoding: .utf8)
        _ = chmod(fake, 0o755)
        install.executable = fake
        install.profile = "it's"
        let result = try DevhubInstall.installLauncher(install)
        let output = try await ProcessRunner().run(result.launcherPath, ["a b", "c"])
        XCTAssertEqual(
            output.stdoutText,
            "\(scratch)/user-data/devhub/control.sock|it's|[\"/usr/bin/open\",\"-a\",\"/Applications/DevHub.app\"]|a b c")
    }

    func testFallsBackToTheNextCandidateAndNeverUsesSudo() throws {
        let fallback = scratch + "/.local/bin"
        let result = try DevhubInstall.installLauncher(request(["/definitely-not-writable-by-a-test", fallback]))
        XCTAssertEqual(result.launcherPath, fallback + "/devhub")
        XCTAssertTrue(result.message.contains("does not use sudo"))
        XCTAssertFalse(result.message.contains("sudo "))
        XCTAssertTrue(result.message.contains("export PATH=\"\(fallback):$PATH\""))
    }

    func testSaysNothingAboutPATHWhenTheDirectoryIsAlreadyOnIt() throws {
        let directory = scratch + "/bin"
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let result = try DevhubInstall.installLauncher(request([directory], pathValue: "/usr/bin:\(directory)"))
        XCTAssertEqual(result.message, "Installed the 'devhub' command at \(directory)/devhub.")
    }

    func testRefusesRatherThanReportingASuccessItDidNotAchieve() {
        XCTAssertThrowsError(try DevhubInstall.installLauncher(request(["/definitely-not-writable"]))) { error in
            XCTAssertEqual("\(error)", "none of these directories would take the launcher: /definitely-not-writable")
        }
    }

    func testQuotesEveryPathItBakesIn() {
        var install = request()
        install.executable = "/Apps/Dev Hub/devhub"
        install.socketPath = "/a b/control.sock"
        let script = DevhubInstall.launcherScript(install)
        XCTAssertTrue(script.contains("exec '/Apps/Dev Hub/devhub'"))
        XCTAssertTrue(script.contains("DEVHUB_CONTROL_SOCKET='/a b/control.sock'"))
        XCTAssertEqual(DevhubInstall.shellQuote("it's"), "'it'\\''s'")
        XCTAssertEqual(DevhubInstall.shellQuoteArgv(["a", "b c"]), "'a' 'b c'")
    }

    func testInstallsAProfilesOwnCommand() throws {
        let directory = scratch + "/bin"
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        var install = request([directory])
        install.commandName = "devhub-dev"
        install.profile = "dev"
        let result = try DevhubInstall.installLauncher(install)
        XCTAssertEqual(result.launcherPath, directory + "/devhub-dev")
        XCTAssertTrue(try String(contentsOfFile: result.launcherPath, encoding: .utf8).contains("DEVHUB_PROFILE='dev'"))
    }
}
