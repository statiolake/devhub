// Port of apps/desktop/src/main/terminal/launcher.test.ts and the
// argument half of devhubTerminal.test.ts (the control-socket half is the
// `terminal-profile` request, WP7's).

import Foundation
import XCTest
@testable import DevHubCore

/// Runs a program to its end, synchronously, for the script tests.
func runSync(_ path: String, _ args: [String] = []) -> (status: Int32, stdout: String, stderr: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = args
    let out = Pipe(), err = Pipe()
    process.standardOutput = out
    process.standardError = err
    try! process.run()
    let stdout = out.fileHandleForReading.readDataToEndOfFile()
    let stderr = err.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, String(decoding: stdout, as: UTF8.self), String(decoding: stderr, as: UTF8.self))
}

final class TerminalLauncherScriptTests: XCTestCase {
    let scratch = ScratchDirectories()
    var root = ""
    var execPath = ""
    var entryScript = ""
    var socketPath = ""

    override func setUp() {
        root = scratch.make("terminal-launcher")
        execPath = Path.join(root, "DevHub")
        entryScript = Path.join(root, "out", "main", "terminal", "devhubTerminal.js")
        socketPath = Path.join(root, "user-data", "devhub", "control.sock")
    }

    override func tearDown() { scratch.removeAll() }

    func install(execPath: String? = nil) throws -> String {
        try TerminalLauncher.install(
            at: TerminalLauncher.launcherPath(userDataPath: Path.join(root, "user-data")),
            execPath: execPath ?? self.execPath, entryScript: entryScript, socketPath: socketPath, machine: "local"
        )
    }

    func script(machine: String = "local") -> String {
        TerminalLauncher.script(execPath: execPath, entryScript: entryScript, socketPath: socketPath, machine: machine)
    }

    func testIsWrittenExecutableNextToTheSocketItTalksTo() throws {
        let path = try install()
        XCTAssertEqual(path, Path.join(root, "user-data", "devhub", "devhub-terminal"))
        let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int
        XCTAssertEqual(mode.map { $0 & 0o777 }, 0o755)
    }

    func testCarriesTheSocketAndRunsTheEntryPointAsNode() {
        let script = script()
        XCTAssertTrue(script.contains("DEVHUB_CONTROL_SOCKET='\(socketPath)'"))
        XCTAssertTrue(script.contains("DEVHUB_TERMINAL_MACHINE='local'"))
        XCTAssertTrue(script.contains("ELECTRON_RUN_AS_NODE=1"))
        XCTAssertTrue(script.contains("'\(execPath)' '\(entryScript)' \"$@\")"))
    }

    func testBecomesTheCommandDevHubAnswersWithRatherThanRunningIt() {
        XCTAssertTrue(script().contains("eval \"exec $devhub_argv\""))
        XCTAssertTrue(script().contains("devhub_argv=$("))
    }

    func testRefusesToExecNothingWhenTheAnswerIsEmpty() {
        XCTAssertTrue(script().contains("if [ -z \"$devhub_argv\""))
    }

    func testQuotesTheArgvItHandsTheShellOneWordPerArgument() {
        XCTAssertEqual(
            TerminalLauncher.commandLine(file: "/opt/tmux", args: ["-L", "devhub", "attach-session", "-t", "ws with space"]),
            "'/opt/tmux' '-L' 'devhub' 'attach-session' '-t' 'ws with space'"
        )
    }

    func testCarriesTheEnvironmentTheCommandNeedsThroughEnv() {
        XCTAssertEqual(
            TerminalLauncher.commandLine(
                file: "/opt/tmux", args: ["-L", "devhub", "attach-session", "-t", "ws"],
                env: ["TERMINFO": "/home/dev/.devhub-server/tmux/3.7c/terminfo"]
            ),
            "'env' 'TERMINFO=/home/dev/.devhub-server/tmux/3.7c/terminfo' '/opt/tmux' '-L' 'devhub' 'attach-session' '-t' 'ws'"
        )
    }

    func testAddsNothingWhenTheCommandNeedsNothingAdded() {
        XCTAssertEqual(TerminalLauncher.commandLine(file: "/opt/tmux", args: ["-L", "devhub"], env: [:]), "'/opt/tmux' '-L' 'devhub'")
    }

    func testLeavesNoProcessOfItsOwnBetweenTheCallerAndTheAnswer() throws {
        // Stands in for Electron-as-Node: it prints one shell-quoted argv, and
        // that argv reports the pid of the process it ends up running as.
        let fakeApp = Path.join(root, "DevHub")
        try Data("#!/bin/sh\necho \"'/bin/sh' '-c' 'echo \\$\\$'\"\n".utf8).write(to: URL(fileURLWithPath: fakeApp))
        chmod(fakeApp, 0o755)
        let path = try install(execPath: fakeApp)
        let result = runSync("/bin/sh", ["-c", "echo \"$$\"; exec \"$1\"", "sh", path])
        let lines = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n")
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(lines.last, lines.first)
    }

    func testStopsWithWhatDevHubSaidWhenDevHubAnswersWithNothing() throws {
        let fakeApp = Path.join(root, "DevHub")
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: URL(fileURLWithPath: fakeApp))
        chmod(fakeApp, 0o755)
        let result = runSync(try install(execPath: fakeApp))
        XCTAssertEqual(result.status, 1)
        XCTAssertTrue(result.stderr.contains("without a command line"))
    }

    func testNamesTheMachineItWasWrittenFor() {
        XCTAssertTrue(script(machine: "ssh:build-box.example.com").contains("DEVHUB_TERMINAL_MACHINE='ssh:build-box.example.com'"))
    }

    func testSaysWhichBinaryIsMissingRatherThanLettingBinShSayIt() throws {
        let missing = Path.join(root, "no-such-node")
        let result = runSync(try install(execPath: missing))
        XCTAssertEqual(result.status, 1)
        XCTAssertTrue(result.stderr.contains(missing))
        XCTAssertTrue(result.stderr.contains("no terminal session to attach to"))
    }

    func testIsRewrittenRatherThanAppendedToSoAMovedAppLeavesNoStalePaths() throws {
        _ = try install()
        let path = try install(execPath: "/elsewhere/DevHub")
        let text = try String(contentsOfFile: path, encoding: .utf8)
        XCTAssertTrue(text.contains("'/elsewhere/DevHub'"))
        XCTAssertFalse(text.contains(execPath))
    }
}

final class RemoteTerminalPathsTests: XCTestCase {
    func paths(controlSocketPath: String = "/data/devhub/devhub/control.sock") -> TerminalLauncher.RemotePaths {
        TerminalLauncher.remotePaths(
            home: "/home/dev", serverDataFolderName: ".devhub-server", serverInstallKey: "abc123",
            controlSocketPath: controlSocketPath, entryName: "devhub-terminal.bundle.js", cliEntryName: "devhub-cli.bundle.js"
        )
    }

    func testRunsOnTheNodeTheConnectionAlreadyInstalledThere() {
        XCTAssertEqual(paths().node, "/home/dev/.devhub-server/bin/abc123/node")
    }

    func testKeepsDevHubsFilesInOneDirectoryOfItsOwn() {
        let remote = paths()
        XCTAssertEqual(remote.directory, "/home/dev/.devhub/terminal")
        XCTAssertTrue(remote.launcher.hasPrefix("\(remote.directory)/"))
        XCTAssertEqual(remote.entry, "/home/dev/.devhub/terminal/js/devhub-terminal.bundle.js")
    }

    func testGivesEachDevHubItsOwnSocketAndLauncherOnTheHost() {
        let other = paths(controlSocketPath: "/data/devhub-second/devhub/control.sock")
        XCTAssertNotEqual(other.socket, paths().socket)
        XCTAssertNotEqual(other.launcher, paths().launcher)
    }

    func testPutsTheDevhubCommandInADirectoryOfItsOwnBesideTheRest() {
        let remote = paths()
        XCTAssertTrue(remote.cliBinDirectory.hasPrefix("\(remote.directory)/"))
        XCTAssertEqual(remote.cli, "\(remote.cliBinDirectory)/devhub")
        XCTAssertEqual(remote.cliEntry, "/home/dev/.devhub/terminal/js/devhub-cli.bundle.js")
    }

    func testGivesEachDevHubItsOwnBinDirectoryNotJustItsOwnFile() {
        let other = paths(controlSocketPath: "/data/devhub-second/devhub/control.sock")
        XCTAssertNotEqual(other.cliBinDirectory, paths().cliBinDirectory)
        XCTAssertEqual(TerminalLauncher.remoteCliBinDirectory(home: "/home/dev", controlSocketPath: "/data/devhub/devhub/control.sock"), paths().cliBinDirectory)
    }

    func testTheProfileTagIsTheSocketsDigest() {
        XCTAssertEqual(TerminalLauncher.remoteProfileTag(controlSocketPath: "x"), String(SHA256.hex("x").prefix(12)))
    }
}

final class RemoteCliScriptTests: XCTestCase {
    let script = TerminalLauncher.remoteCliScript(
        execPath: "/home/dev/.devhub-server/bin/abc123/node",
        cliScript: "/home/dev/.devhub/terminal/js/devhub-cli.bundle.js",
        socketPath: "/home/dev/.devhub/terminal/control-abcdef.sock",
        machine: "ssh:build-host"
    )

    func testRunsTheRehsOwnNodeOnTheForwardedSocket() {
        XCTAssertTrue(script.contains("exec '/home/dev/.devhub-server/bin/abc123/node' '/home/dev/.devhub/terminal/js/devhub-cli.bundle.js' \"$@\""))
        XCTAssertTrue(script.contains("DEVHUB_CONTROL_SOCKET='/home/dev/.devhub/terminal/control-abcdef.sock'"))
    }

    func testSaysWhichMachineThePathsTypedIntoItArePathsOn() {
        XCTAssertTrue(script.contains("DEVHUB_MACHINE='ssh:build-host'"))
    }

    func testRecordsNoWayToStartDevHubBecauseThereIsNoneFromThere() {
        XCTAssertFalse(script.contains("DEVHUB_LAUNCH_COMMAND"))
    }

    func testNamesTheNodeItCannotFindRatherThanFailingAsAShell() {
        XCTAssertTrue(script.contains("if [ ! -x '/home/dev/.devhub-server/bin/abc123/node' ]; then"))
    }

    func testIsAPosixShellScriptBecauseAHostMayHaveNoBash() {
        XCTAssertTrue(script.hasPrefix("#!/bin/sh\n"))
    }
}

final class TerminalDirectoryTests: XCTestCase {
    func testIsTheCwdVSCodeGaveTheTerminal() { XCTAssertEqual(TerminalLauncher.terminalRoot("/work/project"), "/work/project") }
    func testIsScratchWhenThereIsNoCwdToSpeakOf() { XCTAssertNil(TerminalLauncher.terminalRoot(nil)) }
    func testIsScratchRatherThanAGuessWhenThePathIsRelative() { XCTAssertNil(TerminalLauncher.terminalRoot("project")) }

    let roots = ["/work/app", "/work/app/packages/ui", "/work/app-old"]

    func testIsTheWorkspaceRootedExactlyThere() { XCTAssertEqual(TerminalLauncher.enclosingRoot(roots, "/work/app"), "/work/app") }
    func testIsTheWorkspaceASubdirectoryIsInside() { XCTAssertEqual(TerminalLauncher.enclosingRoot(roots, "/work/app/src/main"), "/work/app") }
    func testIsTheInnermostWorkspaceWhenTheyNest() {
        XCTAssertEqual(TerminalLauncher.enclosingRoot(roots, "/work/app/packages/ui/src"), "/work/app/packages/ui")
    }
    func testDoesNotTakeASiblingWhoseNameMerelyStartsTheSame() {
        XCTAssertEqual(TerminalLauncher.enclosingRoot(roots, "/work/app-old/src"), "/work/app-old")
    }
    func testIsScratchWhenNoWorkspaceContainsTheDirectory() { XCTAssertNil(TerminalLauncher.enclosingRoot(roots, "/home/testuser")) }
    func testIsScratchWhenThereIsNoDirectoryAtAll() { XCTAssertNil(TerminalLauncher.enclosingRoot(roots, nil)) }
}

final class LauncherArgumentTests: XCTestCase {
    func testAreNothingOrWorkspaceAndAKey() throws {
        XCTAssertNil(try TerminalLauncher.workspaceArgument([]))
        XCTAssertEqual(try TerminalLauncher.workspaceArgument(["--workspace", "ws-key"]), "ws-key")
    }

    func testRefuseAnythingElseRatherThanIgnoreIt() {
        XCTAssertThrowsError(try TerminalLauncher.workspaceArgument(["--other"])) { error in
            XCTAssertTrue("\(error)".contains("takes --workspace <key> and nothing else"))
        }
        XCTAssertThrowsError(try TerminalLauncher.workspaceArgument(["--workspace"]))
        XCTAssertThrowsError(try TerminalLauncher.workspaceArgument(["--workspace", ""]))
        XCTAssertThrowsError(try TerminalLauncher.workspaceArgument(["--workspace", "a", "b"])) { error in
            XCTAssertTrue("\(error)".contains("takes one --workspace"))
        }
    }
}
