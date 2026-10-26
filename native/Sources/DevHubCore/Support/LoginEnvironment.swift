// Port of apps/desktop/src/main/shell/loginEnvironment.ts
//
// The user's login-shell environment, resolved once at startup.
//
// A DevHub launched from Finder, the Dock or `open` is a child of `launchd`,
// and `launchd` hands it a PATH of `/usr/bin:/bin:/usr/sbin:/sbin` and nothing
// else. Everything a developer actually installed — Homebrew's
// `/opt/homebrew/bin`, a version manager's shims, `~/.local/bin` — lives only in
// the environment their login shell builds, and the app never sees it. A run
// started from a terminal inherits that environment for free, which is exactly
// why the gap is invisible in development and total in a packaged build.
//
// So DevHub asks the login shell what its environment is: spawn the shell as a
// login shell running one command, have that command print the environment
// between a random marker, and parse what comes back.
//
// Native deviation: the TypeScript app's printer is its own Electron binary
// run as Node (`process.env` as JSON). The native app has no Node, so a POSIX
// shell is asked to run `/usr/bin/env -0` (NUL-separated, so a value with a
// newline in it survives), falling back to plain `/usr/bin/env` where `-0` is
// not known; PowerShell, nushell and xonsh print JSON from their own runtime,
// as they do in the TypeScript app.
//
// Two deliberate differences from VS Code, kept from the TypeScript app:
//
//  - The import does not depend on how the app was started. Whether to import
//    is the user's setting (`import_login_environment`).
//  - A failure is a *value*, not a silent empty result: "your terminals have no
//    Homebrew on PATH because your shell profile errors out" is a sentence
//    somebody must be able to read.
//
// The answer lands in the process environment (`adopt`), which every child
// DevHub spawns descends from, so what DevHub can find and what a shell inside
// it can find cannot disagree.

import Foundation

/// What became of the import, kept so it can be shown rather than guessed at.
///
/// `failed` is the case that matters: DevHub carries on with the environment
/// it was started with, which is a working app with a crippled PATH, and the
/// only thing standing between that and an unexplainable bug report is that
/// this state is recorded and displayed.
public enum LoginEnvironment: Equatable, Sendable {
    case imported(shell: String, variables: [String: String])
    case disabled
    /// A platform with no login shell to ask; the process environment is the truth.
    case unsupported
    case failed(shell: String, reason: String)

    /// How long the login shell gets before DevHub stops waiting for it.
    public static let timeoutMs = 10_000

    /// The families that describe *DevHub's own process*, never the user's
    /// session. Every one of those is a true statement about this process and a
    /// false statement about the shell the user is about to type into — a
    /// `.zshrc` that sees `VSCODE_DEV` concludes it is inside VS Code's
    /// terminal. Removed by prefix rather than by name, so the next
    /// `VSCODE_`-something does not have to break something first:
    ///
    ///  - `VSCODE_*`, `ELECTRON_*`, `CHROME_*` — the TypeScript app's runtime,
    ///    which a DevHub started from it (or beside it) can inherit;
    ///  - `DEVHUB_*` — DevHub's own, the control socket among them;
    ///  - `NODE_ENV` — `development` is a fact about a build, not about the
    ///    user's tools.
    static let runtimePrefixes = ["VSCODE_", "ELECTRON_", "CHROME_", "DEVHUB_"]
    static let runtimeNames: Set<String> = ["NODE_ENV"]

    public static func isDevHubRuntimeVariable(_ name: String) -> Bool {
        runtimeNames.contains(name) || runtimePrefixes.contains { name.jsStartsWith($0) }
    }

    /// The environment with DevHub's own runtime taken out of it.
    ///
    /// Asking the shell and launching a child both go through here, and they
    /// must: the login shell is a *child of DevHub*, so asking it from DevHub's
    /// own environment gets DevHub's own environment back. Asked from a clean
    /// one, the shell answers the question that was actually meant.
    public static func withoutDevHubRuntime(_ environment: [String: String]) -> [String: String] {
        environment.filter { !isDevHubRuntimeVariable($0.key) }
    }

    /// Put the login shell's environment into `target` (the process
    /// environment). DevHub's own runtime layer is never written over: in this
    /// process those families stay as they are, in a child they go.
    public static func adopt(_ login: LoginEnvironment, into target: inout [String: String]) {
        guard case .imported(_, let variables) = login else { return }
        for (name, value) in variables where !isDevHubRuntimeVariable(name) {
            target[name] = value
        }
    }

    /// `adopt` into this process's own environment (`setenv`), which is what
    /// `ProcessInfo.processInfo.environment` reads from then on.
    public static func adoptIntoProcess(_ login: LoginEnvironment) {
        guard case .imported(_, let variables) = login else { return }
        for (name, value) in variables where !isDevHubRuntimeVariable(name) {
            setenv(name, value, 1)
        }
    }

    /// The environment the children DevHub spawns are launched with: the
    /// process environment (which already holds the import) without the
    /// variables that describe DevHub's own process.
    public static func launchEnvironment(_ processEnvironment: [String: String]) -> [String: String] {
        withoutDevHubRuntime(processEnvironment)
    }

    /// What became of the import, in a sentence: the status line under the
    /// Settings option, and — when the import failed — folded into the message
    /// a runtime lookup fails with, because a short PATH and an import that did
    /// not happen are the same fact twice.
    public var summary: String {
        switch self {
        case .imported(let shell, _):
            return "Imported from \(shell)."
        case .disabled:
            return "Not imported. Everything DevHub runs, including the editor and its extensions, uses the environment DevHub was started with."
        case .unsupported:
            return "Not imported: this platform has no login shell to read."
        case .failed(let shell, let reason):
            return "DevHub could not read the environment from \(shell): \(reason) Everything DevHub runs, including the editor and its extensions, falls back to the environment DevHub was started with, which may not have your tools on PATH."
        }
    }

    /// The login shell to ask. `SHELL` is what the user's account is
    /// configured with; there is no second guess, because a wrong guess would
    /// import somebody else's environment and be worse than importing none.
    static func loginShell(_ environment: [String: String]) -> String? {
        guard let shell = environment["SHELL"], !shell.isEmpty else { return nil }
        return shell
    }

    /// The command line that prints the environment, per shell family (the
    /// non-POSIX cases learned from VS Code's `doResolveUnixShellEnv`).
    static func printerCommand(shell: String, mark: String) -> (command: String, args: [String]) {
        let name = (shell as NSString).lastPathComponent
        if ["pwsh", "powershell", "pwsh-preview", "powershell-preview"].contains(name) {
            return (
                "$e = @{}; foreach ($v in Get-ChildItem env:) { $e[$v.Name] = $v.Value }; [Console]::Write('\(mark)' + ($e | ConvertTo-Json -Compress) + '\(mark)')",
                ["-Login", "-Command"]
            )
        }
        if name == "nu" {
            return ("print -n ('\(mark)' + ($env | to json -r) + '\(mark)')", ["-i", "-l", "-c"])
        }
        if name == "xonsh" {
            return ("import os, json; print(\"\(mark)\", json.dumps(dict(os.environ)), \"\(mark)\")", ["-i", "-l", "-c"])
        }
        let command = "printf '%s' '\(mark)'; /usr/bin/env -0 2>/dev/null || /usr/bin/env; printf '%s' '\(mark)'"
        // csh and tcsh have no `-l -c`; `-ic` is the whole of what they accept.
        return (command, name == "tcsh" || name == "csh" ? ["-ic"] : ["-i", "-l", "-c"])
    }

    /// The import, or why there is none.
    ///
    /// - Parameters:
    ///   - enabled: the `[general] import_login_environment` setting.
    ///   - processEnvironment: the environment DevHub was started with.
    ///   - supported: false on a platform with no login shell.
    public static func resolve(
        enabled: Bool,
        processEnvironment: [String: String] = ProcessInfo.processInfo.environment,
        supported: Bool = true,
        timeoutMs: Int = LoginEnvironment.timeoutMs
    ) async -> LoginEnvironment {
        if !enabled { return .disabled }
        if !supported { return .unsupported }
        guard let shell = loginShell(processEnvironment) else {
            return .failed(shell: "your login shell", reason: "SHELL is not set in the environment DevHub was started with.")
        }
        return await readShellEnvironment(shell: shell, timeoutMs: timeoutMs, processEnvironment: processEnvironment)
    }

    static func readShellEnvironment(shell: String, timeoutMs: Int, processEnvironment: [String: String]) async -> LoginEnvironment {
        let mark = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(12))
        let (command, args) = printerCommand(shell: shell, mark: mark)
        // Clean first, then the one marker the printer itself needs, which
        // `variables(of:)` drops again on the way back.
        var environment = withoutDevHubRuntime(processEnvironment)
        environment["DEVHUB_RESOLVING_ENVIRONMENT"] = "1"
        let child: ChildProcess
        do {
            child = try ChildProcess.spawn(
                executable: shell,
                arguments: args + [command],
                environment: environment,
                newSession: true,
                stdin: .null,
                stdout: .pipe,
                stderr: .pipe
            )
        } catch let error as ChildProcessError {
            // The shell named by SHELL is not something this machine can run.
            // There is no second shell to try.
            if case .spawnFailed(_, let code) = error {
                // Node's own words for it: `spawn /bin/nope ENOENT`.
                return .failed(shell: shell, reason: "\(shell) could not be started (spawn \(shell) \(FileSystemError(operation: "spawn", path: shell, errno: code).code)).")
            }
            return .failed(shell: shell, reason: "\(shell) could not be started (\(error)).")
        } catch {
            return .failed(shell: shell, reason: "\(shell) could not be started (\(error)).")
        }

        // stderr is drained rather than read: a profile that prints warnings is
        // normal, and its text is the user's, not a diagnostic DevHub may keep.
        let drain = Task { _ = await child.stderr.collect() }
        let output = Task { await child.stdout.collect() }
        let timedOut = Flag()
        let watchdog = Task {
            try await Task.sleep(nanoseconds: UInt64(timeoutMs) * 1_000_000)
            timedOut.set()
            child.terminate(grace: 1)
        }
        let exit = await child.wait()
        watchdog.cancel()
        if timedOut.isSet {
            drain.cancel()
            output.cancel()
            let seconds = Int((Double(timeoutMs) / 1000).rounded())
            return .failed(shell: shell, reason: "it did not answer within \(seconds) seconds. Check your shell profile for a prompt or a slow command.")
        }
        let raw = await output.value
        _ = await drain.value
        switch exit {
        case .exited(let code) where code != 0:
            return .failed(shell: shell, reason: "it exited with code \(code).")
        case .signaled(let signal):
            return .failed(shell: shell, reason: "it exited with code null on \(ChildExit.signalName(signal)).")
        default:
            break
        }
        guard let payload = between(mark, in: raw) else {
            return .failed(shell: shell, reason: "it printed no environment. Check your shell profile for a command that exits or replaces the shell.")
        }
        do {
            return .imported(shell: shell, variables: try variables(of: payload))
        } catch {
            return .failed(shell: shell, reason: "its environment could not be read (\(error)).")
        }
    }

    /// The bytes between the first and the last occurrence of `mark`.
    static func between(_ mark: String, in raw: Data) -> [UInt8]? {
        let bytes = [UInt8](raw)
        let needle = Array(mark.utf8)
        func occurrences() -> [Int] {
            guard bytes.count >= needle.count, !needle.isEmpty else { return [] }
            var found: [Int] = []
            for start in 0...(bytes.count - needle.count) where bytes[start] == needle[0] {
                if Array(bytes[start..<(start + needle.count)]) == needle { found.append(start) }
            }
            return found
        }
        let all = occurrences()
        guard let first = all.first, let last = all.last, last > first else { return nil }
        return Array(bytes[(first + needle.count)..<last])
    }

    struct Unreadable: Error, CustomStringConvertible {
        let description: String
    }

    /// The variables DevHub keeps, from the printer's output: a JSON object
    /// (PowerShell, nushell, xonsh), NUL-separated `NAME=value` entries
    /// (`env -0`), or newline-separated ones (`env` without `-0`, where a line
    /// with no `=` continues the value before it). The marker the printer was
    /// run with is dropped: it describes how the environment was read.
    static func variables(of payload: [UInt8]) throws -> [String: String] {
        var variables: [String: String] = [:]
        let text = String(decoding: payload, as: UTF8.self)
        let trimmed = JSString.trim(text)
        if trimmed.jsStartsWith("{") {
            let parsed: JsonValue
            do {
                parsed = try JsonValue.parse(trimmed)
            } catch {
                throw Unreadable(description: "\(error)")
            }
            guard let object = parsed.objectValue else { return [:] }
            for (name, value) in object {
                if let string = value.stringValue {
                    variables[name] = string
                } else if let list = value.arrayValue, list.allSatisfy({ $0.stringValue != nil }) {
                    // nushell keeps PATH as a list.
                    variables[name] = list.compactMap(\.stringValue).joined(separator: ":")
                }
            }
        } else if payload.contains(0) {
            for entry in payload.split(separator: 0, omittingEmptySubsequences: true) {
                let string = String(decoding: entry, as: UTF8.self)
                guard let equals = string.firstIndex(of: "=") else { continue }
                variables[String(string[..<equals])] = String(string[string.index(after: equals)...])
            }
        } else {
            var last: String?
            for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                if let equals = line.firstIndex(of: "="), !line[..<equals].isEmpty, !line[..<equals].contains(" ") {
                    let name = String(line[..<equals])
                    variables[name] = String(line[line.index(after: equals)...])
                    last = name
                } else if let name = last, !line.isEmpty {
                    variables[name, default: ""] += "\n" + line
                }
            }
        }
        variables["DEVHUB_RESOLVING_ENVIRONMENT"] = nil
        return variables
    }
}

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.lock(); value = true; lock.unlock() }
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
}
