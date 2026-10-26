// Port of apps/desktop/src/main/cli/wait.ts and stdin.ts
//
// `devhub --wait <file>`: not returning until the file has been closed.
//
// This is what makes `EDITOR='devhub --wait'` work. `git commit` runs the
// editor and reads the message back when the editor *exits*, so a command that
// opens a file and returns immediately gives git an empty message. The command
// has to stay alive exactly as long as the person is still typing.
//
// The CLI creates an empty marker file and names it in the open request; the
// editor deletes it once the file is closed (the managed Neovim's buffer
// autocommands, or DevHub itself when that Neovim dies without running them).
// So the CLI's whole job is to notice the marker go away. It polls rather than
// watching the directory: one question, asked on a timer, cannot disagree with
// itself.
//
// The other way a wait can end is that DevHub is no longer there to close
// anything, so DevHub is *asked* (a ping, not a connect — see
// `ControlClient.socketAnswers`) on the same timer, and a DevHub that does not
// answer ends the wait with a sentence and a failing status. The marker is
// checked first, so a DevHub that deletes the marker and quits in the same
// instant still counts as having finished the job.
//
// `devhub -`: what is piped into the command, as an editor. The bytes are
// spooled to a file first, and then the ordinary open runs on that file —
// nothing downstream knows the path came from a pipe. The bytes are written
// through unchanged, all of stdin is read before the app is asked (so the
// editor opens once, complete), and the spool is left behind as `code -`
// leaves its own: the editor is looking at it.

import Foundation

/// How often the marker and DevHub are asked about: under what anyone
/// notices between closing the file and getting the prompt back.
public let waitPollMs = 250

/// The two questions a wait is made of, and the clock it asks them on.
public protocol WaitWorld: Sendable {
    /// Whether the marker file is still there.
    func markerExists() async -> Bool
    /// Whether DevHub is still answering its socket.
    func devhubAnswers() async -> Bool
    /// Named in the sentence when it stops answering, so there is a thing to look at.
    var socketPath: String { get }
    func pause(milliseconds: Int) async throws
}

public enum DevhubWait {
    /// Wait until the file is closed, or until there is no DevHub left to
    /// close it. Throws — rather than returning quietly — when DevHub went
    /// away first, because the person's edit did not happen and a zero exit
    /// status would tell `git commit` that it did.
    public static func waitForClose(_ world: any WaitWorld) async throws {
        while true {
            if !(await world.markerExists()) { return }
            if !(await world.devhubAnswers()) {
                throw DevhubFailure(
                    "DevHub is not listening on \(world.socketPath): it stopped while the file was still open, so the file was never closed and nothing was saved by closing it."
                )
            }
            try await world.pause(milliseconds: waitPollMs)
        }
    }

    /// Twelve random hex digits, as `randomBytes(6).toString("hex")` makes.
    static func randomHex() -> String {
        var generator = SystemRandomNumberGenerator()
        return (0..<6).map { _ in
            let byte = UInt8.random(in: 0...255, using: &generator)
            let hex = String(byte, radix: 16)
            return hex.count == 1 ? "0" + hex : hex
        }.joined()
    }

    /// Make the marker, in a directory of this command's own: the marker's
    /// absence is the signal, and something else clearing out `/tmp` mid-edit
    /// must not be able to send it. A directory made per run, 0700.
    public static func createMarker(temporaryDirectory: String) throws -> String {
        let directory = Path.join(temporaryDirectory, "devhub-wait-\(randomHex())")
        try FileManager.default.createDirectory(
            atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let marker = Path.join(directory, "marker")
        let fd = Foundation.open(marker, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { throw UnixStream.Failure(operation: "open", code: errno, path: marker) }
        _ = Foundation.close(fd)
        return marker
    }

    /// Take the marker's directory away again, however the wait ended: a
    /// marker left behind by a *failed* run is litter that looks like an edit
    /// somebody is still in the middle of.
    public static func removeMarker(_ markerPath: String) {
        try? FileManager.default.removeItem(atPath: (markerPath as NSString).deletingLastPathComponent)
    }

    /// A fresh path in `directory` for one run's worth of stdin, named after
    /// the command, because it is what the editor's tab will say.
    public static func stdinSpoolPath(_ directory: String) -> String {
        Path.join(directory, "devhub-stdin-\(randomHex())")
    }

    /// Read `source` to its end into a new file at `path`. Exclusive because
    /// the path is fresh; 0600 because whatever was piped in is the user's.
    public static func spoolStdin(from source: FileHandle, to path: String) throws {
        let fd = Foundation.open(path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { throw UnixStream.Failure(operation: "open", code: errno, path: path) }
        let output = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        while true {
            let chunk = source.availableData
            if chunk.isEmpty { break }
            output.write(chunk)
        }
        try output.close()
    }
}

/// The real thing: a file on disk, a socket, and the clock.
public struct MarkerWaitWorld: WaitWorld {
    public let markerPath: String
    public let socketPath: String

    public init(markerPath: String, socketPath: String) {
        self.markerPath = markerPath
        self.socketPath = socketPath
    }

    public func markerExists() async -> Bool {
        // Not a swallowed failure: whether the file is there is the question,
        // and an error answering it is the answer "no".
        access(markerPath, F_OK) == 0
    }

    public func devhubAnswers() async -> Bool { await ControlClient.socketAnswers(socketPath) }
    public func pause(milliseconds: Int) async throws { try await Task.sleep(for: .milliseconds(milliseconds)) }
}
