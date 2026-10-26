// Tests of the WP1 Support additions: ChildProcess, AsyncLineReader,
// UnixSocket and FileWatcher.
import XCTest
@testable import DevHubCore

final class ChildProcessTests: XCTestCase {
    func testStreamsStdoutWritesStdinAndReportsTheExit() async throws {
        let child = try ChildProcess.spawn(executable: "/bin/sh", arguments: ["-c", "read line; echo \"got $line\"; echo err >&2; exit 7"], environment: ["PATH": "/usr/bin:/bin"], stdin: .pipe)
        try child.write(Data("hello\n".utf8))
        child.closeStdin()
        async let out = child.stdout.collect()
        async let err = child.stderr.collect()
        let exit = await child.wait()
        XCTAssertEqual(exit, .exited(7))
        let outText = String(decoding: await out, as: UTF8.self)
        let errText = String(decoding: await err, as: UTF8.self)
        XCTAssertEqual(outText, "got hello\n")
        XCTAssertEqual(errText, "err\n")
    }

    func testRunsInItsOwnDirectoryAndEnvironmentOnly() async throws {
        let child = try ChildProcess.spawn(executable: "/bin/sh", arguments: ["-c", "pwd; echo \"$ONLY:$HOME\""], environment: ["ONLY": "yes"], currentDirectory: "/")
        let output = await child.stdout.collect()
        _ = await child.wait()
        XCTAssertEqual(String(decoding: output, as: UTF8.self), "/\nyes:\n")
    }

    func testTerminatesEvenAChildThatIgnoresSIGTERM() async throws {
        let child = try ChildProcess.spawn(executable: "/bin/sh", arguments: ["-c", "trap '' TERM; sleep 30"], environment: [:], newSession: true)
        try await Task.sleep(nanoseconds: 100_000_000)
        let started = Date()
        child.terminate(grace: 0.3)
        let exit = await child.wait()
        XCTAssertEqual(exit.signal, SIGKILL)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        XCTAssertFalse(child.isRunning)
    }

    func testSaysWhenTheExecutableCannotBeStarted() {
        XCTAssertThrowsError(try ChildProcess.spawn(executable: "/nonexistent/program", environment: [:])) { error in
            guard case .spawnFailed(_, let code)? = error as? ChildProcessError else { return XCTFail("\(error)") }
            XCTAssertEqual(code, ENOENT)
        }
    }
}

final class AsyncLineReaderTests: XCTestCase {
    func testJoinsAndSplitsChunksIntoLines() async throws {
        let chunks: [Data] = [Data("one\ntw".utf8), Data("o\r\nthr".utf8), Data([0xE3, 0x81]), Data([0x82, 0x0A]), Data("last".utf8)]
        let stream = AsyncStream<Data> { continuation in
            for chunk in chunks { continuation.yield(chunk) }
            continuation.finish()
        }
        var lines: [String] = []
        for try await line in stream.textLines { lines.append(line) }
        XCTAssertEqual(lines, ["one", "two", "thrあ", "last"])
    }

    func testDeliversAnEmptyLineAndNothingAfterAFinalNewline() {
        var splitter = LineSplitter()
        XCTAssertEqual(splitter.push(Data("a\n\nb\n".utf8)), ["a", "", "b"])
        XCTAssertNil(splitter.finish())
    }
}

final class UnixSocketTests: ScratchDirectoryTestCase {
    /// macOS's temporary directory is too deep for `sun_path`, so the sockets
    /// go in a short directory of their own.
    override func setUpWithError() throws {
        directory = "/tmp/dh-\(UUID().uuidString.prefix(8))"
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
    }

    func testOneLineRequestAndOneLineAnswer() async throws {
        let path = Path.join(directory, "control.sock")
        let listener = try UnixSocket.listen(path)
        defer { listener.close() }
        XCTAssertEqual(FileSystem.permissions(path), 0o600)
        let server = Task {
            for await connection in listener.connections {
                for try await line in connection.lines {
                    try connection.send(line: "{\"echo\":\(line)}")
                    connection.shutdownWrite()
                }
                return
            }
        }
        let client = try UnixSocket.connect(path)
        try client.send(line: "{\"kind\":\"ping\"}")
        var answers: [String] = []
        for try await line in client.lines { answers.append(line) }
        XCTAssertEqual(answers, ["{\"echo\":{\"kind\":\"ping\"}}"])
        client.close()
        try await server.value
    }

    func testRefusesASecondListenerAndTakesOverAStaleSocket() throws {
        let path = Path.join(directory, "control.sock")
        let first = try UnixSocket.listen(path)
        XCTAssertThrowsError(try UnixSocket.listen(path)) { XCTAssertEqual($0 as? UnixSocketError, .inUse(path: path)) }
        first.close(unlinking: false)
        // The file is still there, and nobody answers on it.
        XCTAssertTrue(FileSystem.exists(path))
        XCTAssertFalse(UnixSocket.isLive(path))
        let second = try UnixSocket.listen(path)
        XCTAssertTrue(UnixSocket.isLive(path))
        second.close()
        XCTAssertFalse(FileSystem.exists(path))
    }

    func testRefusesAPathThatDoesNotFitSunPath() {
        let path = "/" + String(repeating: "x", count: UnixSocket.maxPathBytes + 1)
        XCTAssertThrowsError(try UnixSocket.listen(path)) { error in
            guard case .pathTooLong? = error as? UnixSocketError else { return XCTFail("\(error)") }
        }
        #if os(macOS)
        XCTAssertEqual(UnixSocket.maxPathBytes, 103)
        #else
        XCTAssertEqual(UnixSocket.maxPathBytes, 107)
        #endif
    }
}

final class FileWatcherTests: ScratchDirectoryTestCase {
    actor Count {
        var value = 0
        func bump() { value += 1 }
    }

    func testHearsAnEditARenameOverAndADeletion() async throws {
        let path = Path.join(directory, "settings.toml")
        try write(path, "a = 1\n")
        let count = Count()
        let watcher = FileWatcher(path: path, interval: 0.05) { Task { await count.bump() } }
        watcher.start()
        defer { watcher.stop() }
        func waitFor(_ wanted: Int) async throws {
            for _ in 0..<100 where await count.value < wanted { try await Task.sleep(nanoseconds: 20_000_000) }
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        try write(path, "a = 22\n")
        try await waitFor(1)
        let before = await count.value
        XCTAssertGreaterThanOrEqual(before, 1)
        try FileSystem.atomicWrite(path, "a = 3\n")
        try await waitFor(before + 1)
        let again = await count.value
        XCTAssertGreaterThan(again, before)
        try FileSystem.unlink(path)
        try await waitFor(again + 1)
        let deleted = await count.value
        XCTAssertGreaterThan(deleted, again)
        // A deletion can be heard on more than one tick (macOS reports the
        // unlink and then the missing file); let it settle before counting.
        try await Task.sleep(nanoseconds: 300_000_000)
        let settled = await count.value
        // Nothing moved: nothing heard.
        try await Task.sleep(nanoseconds: 300_000_000)
        let final = await count.value
        XCTAssertEqual(final, settled)
    }
}
