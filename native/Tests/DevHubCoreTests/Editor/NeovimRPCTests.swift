// Port of apps/desktop/src/main/editor/neovimRpc.test.ts
//
// The RPC client against a server speaking msgpack-rpc on a real unix
// socket: a stand-in for Neovim, so the client's half of the protocol —
// requests, responses split across reads, errors, and a closed connection
// being the server's exit — is checked on every machine, Neovim installed or
// not. `RealNeovimTests` runs the same client against a real Neovim.

import Foundation
import XCTest
@testable import DevHubCore

/// A fake Neovim: answers each request with `answer(method, params)`, a thrown
/// error becoming an RPC error and `nil` leaving it unanswered. `split` sends
/// every response a byte at a time, which is what a reader that assumes one
/// message per read gets wrong.
final class FakeNeovimServer: @unchecked Sendable {
    let path: String
    let directory: String
    private let listener: Int32
    private let lock = NSLock()
    private var connections: [Int32] = []
    private var stopped = false

    struct Refusal: Error { let message: String }

    init(
        split: Bool = false,
        answer: @escaping @Sendable (String, [MsgpackValue]) throws -> MsgpackValue?
    ) throws {
        directory = try wp7SocketDirectory("rpc")
        path = directory + "/fake.sock"
        listener = try UnixStream.listen(path)
        let listener = self.listener
        Thread { [self] in
            while let fd = try? UnixStream.accept(listener) {
                lock.lock()
                if stopped {
                    lock.unlock()
                    UnixStream.close(fd)
                    break
                }
                connections.append(fd)
                lock.unlock()
                Thread { FakeNeovimServer.serve(fd, split: split, answer: answer) }.start()
            }
        }.start()
    }

    static func serve(_ fd: Int32, split: Bool, answer: @escaping (String, [MsgpackValue]) throws -> MsgpackValue?) {
        var buffered: [UInt8] = []
        while let chunk = try? UnixStream.read(fd), !chunk.isEmpty {
            buffered += chunk
            while let message = try? Msgpack.decode(buffered) {
                buffered.removeFirst(message.length)
                guard case let .array(parts) = message.value, parts.count == 4, let method = parts[2].stringValue
                else { continue }
                let response: MsgpackValue
                do {
                    guard let result = try answer(method, parts[3].arrayValue ?? []) else { continue }
                    response = [1, parts[1], nil, result]
                } catch let refusal as Refusal {
                    response = [1, parts[1], [0, .string(refusal.message)], nil]
                } catch {
                    continue
                }
                let bytes = try! Msgpack.encode(response)
                if split {
                    for byte in bytes { try? UnixStream.write(fd, [byte]) }
                } else {
                    try? UnixStream.write(fd, bytes)
                }
            }
        }
    }

    /// The server is gone: every connection closed from its side.
    func dropConnections() {
        lock.lock()
        let open = connections
        connections.removeAll()
        lock.unlock()
        for fd in open { UnixStream.shutdownBoth(fd) }
    }

    func stop() {
        lock.lock()
        stopped = true
        lock.unlock()
        dropConnections()
        if let wake = try? UnixStream.connect(path) { UnixStream.close(wake) }
        wp7RemoveDirectory(directory)
    }
}

final class NeovimRPCTests: XCTestCase {
    func testSendsARequestAndReadsItsAnswerHoweverTheBytesArrive() async throws {
        let server = try FakeNeovimServer(split: true) { method, params in
            ["method": .string(method), "params": .array(params)]
        }
        defer { server.stop() }
        let client = try await NeovimClient.connect(server.path)
        async let one = client.request("nvim_get_mode", [])
        async let two = client.request("nvim_exec_lua", ["return ...", ["/a b", 3]])
        let (first, second) = try await (one, two)
        XCTAssertEqual(first, ["method": "nvim_get_mode", "params": []])
        XCTAssertEqual(second, ["method": "nvim_exec_lua", "params": ["return ...", ["/a b", 3]]])
        await client.close()
    }

    func testRejectsWithNeovimsOwnWordsWhenItRefusesARequest() async throws {
        let server = try FakeNeovimServer { _, _ in
            throw FakeNeovimServer.Refusal(message: "Vim:E492: Not an editor command")
        }
        defer { server.stop() }
        let client = try await NeovimClient.connect(server.path)
        let error = await wp7Caught { try await client.request("nvim_command", ["nonsense"]) }
        let refusal = try XCTUnwrap(error as? NeovimRPCError)
        XCTAssertEqual(refusal.method, "nvim_command")
        XCTAssertTrue(refusal.description.contains("E492"), refusal.description)
        await client.close()
    }

    func testHearsTheServerGoAwayAndFailsWhatWasWaitingOnIt() async throws {
        let server = try FakeNeovimServer { _, _ in nil }
        defer { server.stop() }
        let client = try await NeovimClient.connect(server.path)
        let heard = WP7Counter()
        await client.onClose { heard.increment() }
        let waiting = Task { try await client.request("nvim_get_mode", []) }
        // Received and left unanswered, then the server is gone.
        try await Task.sleep(for: .milliseconds(30))
        server.dropConnections()
        let error = await wp7Caught { try await waiting.value }
        XCTAssertTrue("\(error!)".contains("closed"), "\(error!)")
        let closed = await client.isClosed
        XCTAssertTrue(closed)
        XCTAssertEqual(heard.value, 1)
        // Too late to register is not too late to hear it.
        let late = WP7Counter()
        await client.onClose { late.increment() }
        XCTAssertEqual(late.value, 1)
        let again = await wp7Caught { try await client.request("nvim_get_mode", []) }
        XCTAssertTrue("\(again!)".contains("closed"))
    }

    func testTellsAStaleSocketFileFromALiveServerByTheErrno() async throws {
        let directory = try wp7SocketDirectory("stale")
        defer { wp7RemoveDirectory(directory) }
        let missing = directory + "/missing.sock"
        let gone = await wp7Caught { try await NeovimClient.connect(missing) }
        XCTAssertEqual((gone as? UnixStream.Failure)?.code, ENOENT)
        XCTAssertEqual((gone as? UnixStream.Failure)?.isRefused, true)
        // A plain file where the socket should be is refused too, not hung on.
        let file = directory + "/file.sock"
        _ = FileManager.default.createFile(atPath: file, contents: Data())
        let plain = await wp7Caught { try await NeovimClient.connect(file) }
        XCTAssertEqual((plain as? UnixStream.Failure)?.isRefused, true, "\(String(describing: plain))")
        // A socket file nobody is accepting on.
        let dead = directory + "/dead.sock"
        let listener = try UnixStream.listen(dead)
        UnixStream.close(listener)
        let refused = await wp7Caught { try await NeovimClient.connect(dead) }
        XCTAssertEqual((refused as? UnixStream.Failure)?.code, ECONNREFUSED)
    }

    func testGivesUpOnARequestNeovimNeverAnswers() async throws {
        let server = try FakeNeovimServer { _, _ in nil }
        defer { server.stop() }
        let client = try await NeovimClient.connect(server.path, timeout: .milliseconds(50))
        let error = await wp7Caught { try await client.request("nvim_get_mode", []) }
        XCTAssertEqual("\(error!)", "Neovim did not answer nvim_get_mode in time")
        // The connection itself is still good.
        let closed = await client.isClosed
        XCTAssertFalse(closed)
        await client.close()
    }

    func testClosingByDevHubFailsWhatIsWaitingAndIsHeard() async throws {
        let server = try FakeNeovimServer { _, _ in nil }
        defer { server.stop() }
        let client = try await NeovimClient.connect(server.path)
        let heard = WP7Counter()
        await client.onClose { heard.increment() }
        let waiting = Task { try await client.request("nvim_get_mode", []) }
        try await Task.sleep(for: .milliseconds(20))
        await client.close()
        let error = await wp7Caught { try await waiting.value }
        XCTAssertEqual("\(error!)", "the connection to Neovim was closed by DevHub")
        XCTAssertEqual(heard.value, 1)
    }
}

/// A count bumped from any thread.
final class WP7Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func increment() {
        lock.lock()
        count += 1
        lock.unlock()
    }
    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
}
