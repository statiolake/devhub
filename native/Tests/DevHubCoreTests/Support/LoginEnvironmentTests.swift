// Port of apps/desktop/src/main/shell/loginEnvironment.test.ts (the
// window-terminal-launcher and dev-container cases are VS Code mode only and
// have no native counterpart).
import XCTest
@testable import DevHubCore

/// The environment a Finder-launched macOS app inherits from launchd, and the
/// whole of the production defect: nothing a developer installed is on it.
let LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"

final class LoginEnvironmentTests: ScratchDirectoryTestCase {
    /// A stand-in login shell: a script that honours the contract DevHub asks
    /// for — run one command, print the environment between the marker.
    func fakeShell(_ body: String) throws -> String {
        let path = Path.join(directory, "fakeshell-\(UUID().uuidString.prefix(8))")
        try write(path, "#!/bin/sh\n\(body)\n", mode: 0o755)
        return path
    }

    /// Finds the marker in the printer command and prints NUL-separated
    /// variables between two copies of it, as `env -0` would.
    let printsEnvironment = #"""
        last=""
        for arg in "$@"; do last="$arg"; done
        mark=$(printf '%s' "$last" | sed -e "s/^printf '%s' '\([0-9a-f]*\)'.*/\1/")
        printf '%sPATH=/opt/tools/bin:/usr/bin\000EXTRA=yes\000%s\n' "$mark" "$mark"
        """#

    func testImportsTheLoginShellsEnvironmentWhenTheOptionIsOn() async throws {
        let shell = try fakeShell(printsEnvironment)
        let login = await LoginEnvironment.resolve(enabled: true, processEnvironment: ["PATH": LAUNCHD_PATH, "SHELL": shell])
        XCTAssertEqual(login, .imported(shell: shell, variables: ["PATH": "/opt/tools/bin:/usr/bin", "EXTRA": "yes"]))
    }

    func testAsksTheShellFromAnEnvironmentWithNoneOfDevHubsOwnInIt() async throws {
        let shell = try fakeShell(#"""
            last=""
            for arg in "$@"; do last="$arg"; done
            mark=$(printf '%s' "$last" | sed -e "s/^printf '%s' '\([0-9a-f]*\)'.*/\1/")
            printf '%sSAW_VSCODE_DEV=%s\000SAW_NODE_ENV=%s\000PATH=/opt/tools/bin\000%s' "$mark" "${VSCODE_DEV:-no}" "${NODE_ENV:-no}" "$mark"
            """#)
        let login = await LoginEnvironment.resolve(enabled: true, processEnvironment: [
            "PATH": LAUNCHD_PATH, "SHELL": shell, "VSCODE_DEV": "1", "NODE_ENV": "development",
        ])
        guard case .imported(_, let variables) = login else { return XCTFail("\(login)") }
        XCTAssertEqual(variables["SAW_VSCODE_DEV"], "no")
        XCTAssertEqual(variables["SAW_NODE_ENV"], "no")
    }

    func testDoesNotGoOutToAShellAtAllWhenTheOptionIsOff() async {
        let login = await LoginEnvironment.resolve(enabled: false, processEnvironment: ["SHELL": "/nonexistent/shell"])
        XCTAssertEqual(login, .disabled)
    }

    func testReportsAShellThatExitsWithAFailure() async throws {
        let shell = try fakeShell("exit 3")
        let login = await LoginEnvironment.resolve(enabled: true, processEnvironment: ["PATH": LAUNCHD_PATH, "SHELL": shell])
        guard case .failed = login else { return XCTFail("\(login)") }
        XCTAssertTrue(login.summary.contains("exited with code 3"))
        XCTAssertTrue(login.summary.contains(shell))
    }

    func testReportsAShellThatPrintsNothingRecognisable() async throws {
        let shell = try fakeShell("echo hello")
        let login = await LoginEnvironment.resolve(enabled: true, processEnvironment: ["PATH": LAUNCHD_PATH, "SHELL": shell])
        guard case .failed = login else { return XCTFail("\(login)") }
        XCTAssertTrue(login.summary.contains("printed no environment"))
    }

    func testGivesUpOnAShellThatNeverAnswersAndSaysSo() async throws {
        let shell = try fakeShell("sleep 30")
        let started = Date()
        let login = await LoginEnvironment.resolve(enabled: true, processEnvironment: ["PATH": LAUNCHD_PATH, "SHELL": shell], timeoutMs: 200)
        guard case .failed = login else { return XCTFail("\(login)") }
        XCTAssertTrue(login.summary.contains("did not answer"))
        XCTAssertLessThan(Date().timeIntervalSince(started), 10)
    }

    func testReportsASHELLThatNamesNothingRunnable() async {
        let login = await LoginEnvironment.resolve(enabled: true, processEnvironment: ["PATH": LAUNCHD_PATH, "SHELL": "/nonexistent/shell"])
        guard case .failed = login else { return XCTFail("\(login)") }
        XCTAssertTrue(login.summary.contains("could not be started"))
    }

    func testReportsAMissingSHELL() async {
        let login = await LoginEnvironment.resolve(enabled: true, processEnvironment: ["PATH": LAUNCHD_PATH])
        XCTAssertEqual(login, .failed(shell: "your login shell", reason: "SHELL is not set in the environment DevHub was started with."))
    }

    func testIsUnsupportedWhereThereIsNoLoginShell() async {
        let login = await LoginEnvironment.resolve(enabled: true, processEnvironment: ["SHELL": "/bin/sh"], supported: false)
        XCTAssertEqual(login, .unsupported)
        XCTAssertEqual(login.summary, "Not imported: this platform has no login shell to read.")
    }

    /// The real thing: `/bin/sh` as a login shell, running the printer DevHub
    /// ships with (`env -0`).
    func testReadsARealPOSIXShell() async throws {
        guard FileManager.default.isExecutableFile(atPath: "/bin/sh"), FileManager.default.isExecutableFile(atPath: "/usr/bin/env") else {
            throw XCTSkip("no /bin/sh or /usr/bin/env")
        }
        let login = await LoginEnvironment.resolve(enabled: true, processEnvironment: [
            "PATH": LAUNCHD_PATH, "SHELL": "/bin/sh", "HOME": directory, "DEVHUB_TEST_VALUE": "dropped",
            "MY_VALUE": "two\nlines", "VSCODE_DEV": "1",
        ])
        guard case .imported(let shell, let variables) = login else { return XCTFail("\(login)") }
        XCTAssertEqual(shell, "/bin/sh")
        XCTAssertEqual(variables["MY_VALUE"], "two\nlines")
        XCTAssertNotNil(variables["PATH"])
        XCTAssertNil(variables["DEVHUB_TEST_VALUE"])
        XCTAssertNil(variables["DEVHUB_RESOLVING_ENVIRONMENT"])
        XCTAssertNil(variables["VSCODE_DEV"])
    }

    func testReadsTheThreeOutputShapes() throws {
        XCTAssertEqual(try LoginEnvironment.variables(of: Array("A=1\0B=x=y\0".utf8)), ["A": "1", "B": "x=y"])
        XCTAssertEqual(try LoginEnvironment.variables(of: Array("A=1\nB=two\nlines\nDEVHUB_RESOLVING_ENVIRONMENT=1\n".utf8)), ["A": "1", "B": "two\nlines"])
        XCTAssertEqual(try LoginEnvironment.variables(of: Array(#" {"A":"1","N":2,"PATH":["/a","/b"]} "#.utf8)), ["A": "1", "PATH": "/a:/b"])
        XCTAssertThrowsError(try LoginEnvironment.variables(of: Array("{nope".utf8)))
    }
}

/// The environment a `dev.sh` run of the TypeScript app has — every one of
/// these is a true statement about that process and a false one about the
/// shell the user is about to type into.
let POISONED_PARENT: [String: String] = [
    "PATH": LAUNCHD_PATH,
    "HOME": "/home/testuser",
    "SHELL": "/bin/zsh",
    "LANG": "en_US.UTF-8",
    "VSCODE_DEV": "1",
    "VSCODE_CLI": "1",
    "VSCODE_NLS_CONFIG": "{}",
    "VSCODE_IPC_HOOK": "/run/vscode.sock",
    "NODE_ENV": "development",
    "ELECTRON_RUN_AS_NODE": "1",
    "ELECTRON_ENABLE_LOGGING": "1",
    "ELECTRON_ENABLE_STACK_DUMPING": "1",
    "CHROME_DESKTOP": "code-oss.desktop",
    "DEVHUB_CONTROL_SOCKET": "/run/devhub/control.sock",
]

final class AdoptLoginEnvironmentTests: XCTestCase {
    func testPutsTheLoginShellsValuesOnTheEnvironmentEveryChildDescendsFrom() {
        var environment = ["PATH": LAUNCHD_PATH, "XDG_CONFIG_HOME": "/config"]
        LoginEnvironment.adopt(.imported(shell: "/bin/zsh", variables: ["PATH": "/opt/tools/bin:/usr/bin", "EXTRA": "yes"]), into: &environment)
        XCTAssertEqual(environment["PATH"], "/opt/tools/bin:/usr/bin")
        XCTAssertEqual(environment["EXTRA"], "yes")
        XCTAssertEqual(environment["XDG_CONFIG_HOME"], "/config")
    }

    func testLeavesTheProcessAloneWhenThereWasNothingToImport() {
        var environment = ["PATH": LAUNCHD_PATH]
        LoginEnvironment.adopt(.disabled, into: &environment)
        LoginEnvironment.adopt(.failed(shell: "/bin/zsh", reason: "it exited with code 3."), into: &environment)
        XCTAssertEqual(environment, ["PATH": LAUNCHD_PATH])
    }

    func testNeverWritesOverWhatDescribesDevHubsOwnProcess() {
        var environment = POISONED_PARENT
        LoginEnvironment.adopt(.imported(shell: "/bin/zsh", variables: [
            "PATH": "/opt/tools/bin", "NODE_ENV": "production", "VSCODE_PORTABLE": "/opt/vscode", "VSCODE_IPC_HOOK": "/somewhere/else.sock",
        ]), into: &environment)
        XCTAssertEqual(environment["PATH"], "/opt/tools/bin")
        XCTAssertEqual(environment["NODE_ENV"], "development")
        XCTAssertEqual(environment["VSCODE_IPC_HOOK"], "/run/vscode.sock")
        XCTAssertNil(environment["VSCODE_PORTABLE"])
    }

    func testHandsAChildNoneOfDevHubsOwnRuntimeVariables() {
        let environment = LoginEnvironment.launchEnvironment(POISONED_PARENT)
        for name in environment.keys {
            XCTAssertFalse(["VSCODE_", "ELECTRON_", "CHROME_", "DEVHUB_"].contains { name.hasPrefix($0) }, name)
        }
        XCTAssertNil(environment["NODE_ENV"])
        XCTAssertEqual(environment, ["PATH": LAUNCHD_PATH, "HOME": "/home/testuser", "SHELL": "/bin/zsh", "LANG": "en_US.UTF-8"])
    }

    func testReadsTheImportFromTheProcessSoATerminalAndTheEditorAgree() {
        var environment = POISONED_PARENT
        LoginEnvironment.adopt(.imported(shell: "/bin/zsh", variables: ["PATH": "/opt/tools/bin:/usr/bin", "EXTRA": "yes"]), into: &environment)
        let child = LoginEnvironment.launchEnvironment(environment)
        XCTAssertEqual(child["PATH"], "/opt/tools/bin:/usr/bin")
        XCTAssertEqual(child["EXTRA"], "yes")
        XCTAssertEqual(child["HOME"], "/home/testuser")
        XCTAssertNil(child["VSCODE_DEV"])
        XCTAssertNil(child["NODE_ENV"])
    }

    func testStripsTheSameVariablesWhetherOrNotTheImportRan() {
        XCTAssertEqual(LoginEnvironment.launchEnvironment(POISONED_PARENT).keys.sorted(), ["HOME", "LANG", "PATH", "SHELL"])
    }

    func testSaysWhatBecameOfTheImport() {
        XCTAssertEqual(LoginEnvironment.imported(shell: "/bin/zsh", variables: [:]).summary, "Imported from /bin/zsh.")
        XCTAssertEqual(LoginEnvironment.disabled.summary, "Not imported. Everything DevHub runs, including the editor and its extensions, uses the environment DevHub was started with.")
        XCTAssertEqual(
            LoginEnvironment.failed(shell: "/bin/zsh", reason: "it exited with code 3.").summary,
            "DevHub could not read the environment from /bin/zsh: it exited with code 3. Everything DevHub runs, including the editor and its extensions, falls back to the environment DevHub was started with, which may not have your tools on PATH."
        )
    }
}

final class RuntimeResolutionTests: ScratchDirectoryTestCase {
    let runtimes = RuntimeConfig(shell: "/bin/sh", git: "git", tmux: "tmux", tmuxSocketName: "devhub", tmuxArgs: [])

    func testNamesTheExecutableAndTheDirectoriesItLookedIn() throws {
        let missing = Path.join(directory, "missing")
        let resolved = Runtimes.resolve(runtimes, searchPath: "\(missing):/x/bin")
        XCTAssertEqual(resolved.tmux.unavailableMessage, "DevHub could not find 'tmux' on PATH (looked in: \(missing), /x/bin).")
    }

    func testNamesThePathAConfiguredPathPointedAt() {
        var config = runtimes
        config.tmux = "/opt/nothing/bin/tmux"
        XCTAssertEqual(Runtimes.resolve(config, searchPath: LAUNCHD_PATH).tmux.unavailableMessage, "DevHub could not find /opt/nothing/bin/tmux.")
    }

    func testSaysSoWhenThereIsNoPATHToSearchAtAll() {
        XCTAssertEqual(Runtimes.resolve(runtimes, searchPath: "").tmux.unavailableMessage, "DevHub could not find 'tmux' on PATH (PATH is empty).")
    }

    func testFindsAnExecutableTheLoginShellsPATHReachesAndLaunchdsDoesNot() throws {
        let bin = Path.join(directory, "bin")
        try FileSystem.makeDirectories(bin)
        let tool = Path.join(bin, "tmux")
        try write(tool, "#!/bin/sh\nexit 0\n", mode: 0o755)
        let missing = Path.join(directory, "missing")
        XCTAssertNotNil(Runtimes.resolve(runtimes, searchPath: missing).tmux.unavailableMessage)
        XCTAssertEqual(Runtimes.resolve(runtimes, searchPath: "\(bin):\(missing)").tmux, .absolutePath(tool))
    }

    func testExpandsTildeAgainstHome() throws {
        let bin = Path.join(directory, "bin")
        try FileSystem.makeDirectories(bin)
        try write(Path.join(bin, "agent"), "#!/bin/sh\n", mode: 0o755)
        XCTAssertEqual(Runtimes.resolveExecutable("~/bin/agent", searchPath: "", home: directory), .absolutePath(Path.join(bin, "agent")))
        XCTAssertEqual(
            Runtimes.resolveExecutable("~/bin/nothing", searchPath: "", home: directory).unavailableMessage,
            "DevHub could not find '~/bin/nothing' (\(Path.join(bin, "nothing")))."
        )
    }

    func testHealthIsUnavailableExactlyWhereTheLookupFailed() throws {
        let health = Runtimes.health(Runtimes.resolve(runtimes, searchPath: ""))
        XCTAssertEqual(health, RuntimeHealth(shell: FileSystem.isRegularFile("/bin/sh") ? .healthy : .unavailable, git: .unavailable, tmux: .unavailable, inspectionAvailable: true))
    }

    func testNamesTheFailedImportAsTheReasonThePATHWasShort() {
        let resolved = Runtimes.resolve(runtimes, searchPath: "/nonexistent")
        let timedOut = LoginEnvironment.failed(shell: "/bin/zsh", reason: "it did not answer within 10 seconds.").summary
        let message = Runtimes.executableMissingMessage(resolved.tmux, loginFailure: timedOut) ?? ""
        XCTAssertTrue(message.contains("could not find 'tmux' on PATH"))
        XCTAssertTrue(message.contains("/bin/zsh"))
        XCTAssertTrue(message.contains("did not answer within 10 seconds"))
        XCTAssertEqual(Runtimes.loginFailure(.failed(shell: "/bin/zsh", reason: "x")), LoginEnvironment.failed(shell: "/bin/zsh", reason: "x").summary)
        XCTAssertNil(Runtimes.loginFailure(.disabled))
    }

    func testNamesTheMachineASearchRanOnAndLeavesThisMacsImportOutOfIt() {
        let onHost = ProgramResolution.unavailable(configured: "claude", lookup: .path(directories: ["/usr/bin", "/bin"]), where: " on build-box.example.com")
        XCTAssertEqual(onHost.unavailableMessage, "DevHub could not find 'claude' on PATH on build-box.example.com (looked in: /usr/bin, /bin).")
        XCTAssertEqual(Runtimes.executableMissingMessage(onHost, loginFailure: "DevHub could not read the login environment from /bin/zsh."), onHost.unavailableMessage)
    }

    func testSaysOnlyWhatItKnowsWhenTheImportIsNotTheReason() {
        let resolved = Runtimes.resolve(runtimes, searchPath: "/nonexistent")
        XCTAssertEqual(Runtimes.executableMissingMessage(resolved.tmux, loginFailure: nil), resolved.tmux.unavailableMessage)
        XCTAssertNil(Runtimes.executableMissingMessage(.absolutePath("/bin/sh"), loginFailure: "x"))
    }
}
