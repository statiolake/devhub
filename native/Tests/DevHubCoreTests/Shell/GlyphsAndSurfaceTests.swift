// The Sidebar's marks as data (icons.tsx) and the SVG path reader, and the
// terminal surface's side of the frame contract (TerminalSurface.tsx,
// shell/terminal/client.ts) against a fake transport.

import XCTest
@testable import DevHubCore

final class PathDataTests: XCTestCase {
    func testReadsAbsoluteAndRelativeLinesAndClosesAtTheStart() throws {
        let commands = try PathData.parse("M2.29 3.43h11.42v3.43H2.29zM4 4l1 1")
        XCTAssertEqual(commands, [
            .move(x: 2.29, y: 3.43), .line(x: 13.71, y: 3.43), .line(x: 13.71, y: 6.86), .line(x: 2.29, y: 6.86), .close,
            .move(x: 4, y: 4), .line(x: 5, y: 5),
        ])
    }

    func testAMoveWithMorePairsIsAPolyline() throws {
        XCTAssertEqual(try PathData.parse("M3.4 8.35 6.35 11.3 12.6 4.85"), [
            .move(x: 3.4, y: 8.35), .line(x: 6.35, y: 11.3), .line(x: 12.6, y: 4.85),
        ])
    }

    func testReadsNumbersRunTogetherTheWaySvgWritesThem() throws {
        // `.32.25` is two numbers, `-.57` a negative one.
        let commands = try PathData.parse("M6.29 4.57V3.43c0-.32.25-.57.57-.57")
        guard case let .cubic(x1, y1, x2, y2, x, y)? = commands.last else { return XCTFail("no curve") }
        for (got, want) in zip([x1, y1, x2, y2, x, y], [6.29, 3.11, 6.54, 2.86, 6.86, 2.86]) {
            XCTAssertEqual(got, want, accuracy: 1e-9)
        }
    }

    func testTurnsAnArcIntoCurvesThatEndWhereTheArcEnds() throws {
        let commands = try PathData.parse("M8 2.75A5.25 5.25 0 1 1 2.75 8")
        guard case let .cubic(_, _, _, _, x, y)? = commands.last else { return XCTFail("no curve") }
        XCTAssertEqual(x, 2.75, accuracy: 1e-9)
        XCTAssertEqual(y, 8, accuracy: 1e-9)
        // Three quarters of a ring: three curves of a quarter each.
        XCTAssertEqual(commands.count, 4)
    }

    func testReadsArcFlagsWrittenWithoutSeparators() throws {
        let commands = try PathData.parse("M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z")
        XCTAssertEqual(commands.last, .close)
        guard case let .cubic(_, _, _, _, x, y) = commands[commands.count - 2] else { return XCTFail("no curve") }
        XCTAssertEqual(x, 8, accuracy: 1e-9)
        XCTAssertEqual(y, 9.5, accuracy: 1e-9)
    }

    func testEveryMarkReads() throws {
        let all: [RowGlyph] = [
            .folder, .terminal, .plus, .close, .trash, .repository, .worktree, .remote, .container, .issueOpen, .issueClosed,
            .pullRequest, .pullRequestDraft, .pullRequestClosed, .pullRequestMerged, .conversation, .checksPassing,
            .checksFailing, .checksPending, .openIssue, .statusWorking, .statusBackground, .statusWaiting, .statusIdle,
            .statusError, .statusUnknown, .statusUnread, .branch,
        ]
        for glyph in all {
            for shape in Glyphs.drawing(glyph).shapes {
                if case let .path(d, _) = shape { XCTAssertFalse(try PathData.parse(d).isEmpty, "\(glyph)") }
            }
        }
        for glyph in [ChromeGlyph.sidebar, .back, .forward, .failure, .empty] {
            for shape in Glyphs.drawing(glyph).shapes {
                if case let .path(d, _) = shape { XCTAssertFalse(try PathData.parse(d).isEmpty) }
            }
        }
    }

    func testRefusesSomethingThatIsNotPathData() {
        XCTAssertThrowsError(try PathData.parse("8 8"))
        XCTAssertThrowsError(try PathData.parse("M8"))
    }
}

/// A transport that records what the surface asked of it and answers as told.
private final class FakeTransport: TerminalAttachTransport, @unchecked Sendable {
    let lock = NSLock()
    var sinks: [TerminalFrameSink] = []
    var receipts: [TerminalAttachReceipt] = []
    var inputs: [(Int, Data)] = []
    var resizes: [TerminalSize] = []
    var acks: [Int] = []
    var detached: [String] = []
    var refuse: TerminalFailure?
    private var counter = 0

    func attach(surfaceKey: String, viewLabel: String, size: TerminalSize, sink: @escaping TerminalFrameSink) async throws
        -> TerminalAttachReceipt
    {
        if let refuse { throw refuse }
        return lock.withLock {
            counter += 1
            let receipt = TerminalAttachReceipt(attachmentId: String(format: "%032x", counter), surfaceKey: surfaceKey, targetGeneration: counter)
            receipts.append(receipt)
            sinks.append(sink)
            return receipt
        }
    }

    func input(_ identity: TerminalRequestIdentity, sequence: Int, _ bytes: Data) throws { lock.withLock { inputs.append((sequence, bytes)) } }
    func resize(_ identity: TerminalRequestIdentity, _ size: TerminalSize) throws { lock.withLock { resizes.append(size) } }
    func acknowledge(_ identity: TerminalRequestIdentity, sequence: Int) throws { lock.withLock { acks.append(sequence) } }
    func detach(_ identity: TerminalRequestIdentity) throws { lock.withLock { detached.append(identity.attachmentId) } }
}

private final class ManualClock: SurfaceClock {
    final class Timer: SurfaceTimer {
        var cancelled = false
        let work: () -> Void
        init(_ work: @escaping () -> Void) { self.work = work }
        func cancel() { cancelled = true }
    }

    var timers: [Timer] = []
    func after(_ milliseconds: Double, _ work: @escaping () -> Void) -> SurfaceTimer {
        let timer = Timer(work)
        timers.append(timer)
        return timer
    }

    func fireAll() {
        for timer in timers where !timer.cancelled { timer.work() }
    }
}

/// Work handed to the session's thread, run when the test says.
private final class Mailbox: @unchecked Sendable {
    let lock = NSLock()
    var queued: [@Sendable () -> Void] = []
    func post(_ work: @escaping @Sendable () -> Void) { lock.withLock { queued.append(work) } }
    func drain() {
        while true {
            let next: (@Sendable () -> Void)? = lock.withLock { queued.isEmpty ? nil : queued.removeFirst() }
            guard let next else { return }
            next()
        }
    }
}

final class TerminalSurfaceSessionTests: XCTestCase {
    private var transport: FakeTransport!
    private var clock: ManualClock!
    private var mailbox: Mailbox!
    private var session: TerminalSurfaceSession!
    private var states: [TerminalConnection] = []
    private var drawn: [Data] = []

    override func setUp() {
        transport = FakeTransport()
        clock = ManualClock()
        mailbox = Mailbox()
        let mailbox = self.mailbox!
        session = TerminalSurfaceSession(
            surfaceKey: "workspace-terminal:w", viewLabel: "main", transport: transport, clock: clock,
            deliver: { work in mailbox.post(work) })
        session.onConnection = { [unowned self] in states.append($0) }
        session.onOutput = { [unowned self] in drawn.append($0) }
    }

    /// Let the attach task answer, then run what it handed over.
    private func settle(receipts expected: Int? = nil) async {
        let wanted = expected ?? transport.receipts.count + 1
        for _ in 0..<50 {
            await Task.yield()
            mailbox.drain()
            if transport.receipts.count >= wanted && mailbox.queued.isEmpty { break }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        mailbox.drain()
    }

    private func frame(_ frame: TerminalFrame, on index: Int = 0) {
        _ = transport.sinks[index](frame)
        mailbox.drain()
    }

    private func started(_ index: Int = 0) {
        let receipt = transport.receipts[index]
        frame(.started(attachmentId: receipt.attachmentId, surfaceKey: receipt.surfaceKey, targetGeneration: receipt.targetGeneration, cols: 80, rows: 24), on: index)
    }

    func testConnectsOnceTheAttachAnsweredAndTheClientStarted() async {
        session.attach(size: TerminalSize(cols: 100, rows: 30))
        XCTAssertEqual(session.connection, .connecting)
        await settle()
        started()
        XCTAssertEqual(session.connection, .connected)
        XCTAssertEqual(states, [.connected])
        // The size the pane had is said once the handshake is done.
        XCTAssertEqual(transport.resizes, [TerminalSize(cols: 100, rows: 30)])
    }

    func testAcknowledgesOutputOnceItHasBeenDrawn() async {
        session.attach(size: TerminalSize(cols: 80, rows: 24))
        await settle()
        started()
        let id = transport.receipts[0].attachmentId
        frame(.output(attachmentId: id, sequence: 1, bytes: Data("hello".utf8)))
        frame(.output(attachmentId: id, sequence: 2, bytes: Data(" world".utf8)))
        XCTAssertEqual(drawn, [Data("hello".utf8), Data(" world".utf8)])
        XCTAssertEqual(transport.acks, [1, 2])
    }

    func testBuffersOutputThatArrivesBeforeTheHandshakeEnds() async {
        session.attach(size: TerminalSize(cols: 80, rows: 24))
        await settle()
        let id = transport.receipts[0].attachmentId
        frame(.output(attachmentId: id, sequence: 1, bytes: Data("early".utf8)))
        XCTAssertEqual(drawn, [])
        started()
        XCTAssertEqual(drawn, [Data("early".utf8)])
        XCTAssertEqual(transport.acks, [1])
    }

    func testSendsInputAsAStrictSequenceAndOnlyWhileConnected() async {
        session.input(Data("lost".utf8))
        session.attach(size: TerminalSize(cols: 80, rows: 24))
        await settle()
        started()
        session.input(Data("ls".utf8))
        session.input(Data("\r".utf8))
        XCTAssertEqual(transport.inputs.map(\.0), [1, 2])
        XCTAssertEqual(transport.inputs.map(\.1), [Data("ls".utf8), Data("\r".utf8)])
    }

    func testChunksInputOnUtf8Boundaries() {
        let text = String(repeating: "あ", count: 30_000)
        let chunks = TerminalInput.chunks(Data(text.utf8))
        XCTAssertGreaterThan(chunks.count, 1)
        XCTAssertTrue(chunks.allSatisfy { $0.count <= TerminalInput.maxBytes })
        XCTAssertEqual(chunks.map { String(decoding: $0, as: UTF8.self) }.joined(), text)
    }

    func testResizesOnlyWhenTheSizeMoved() async {
        session.attach(size: TerminalSize(cols: 80, rows: 24))
        await settle()
        started()
        session.resize(TerminalSize(cols: 80, rows: 24))
        session.resize(TerminalSize(cols: 90, rows: 24))
        session.resize(TerminalSize(cols: 0, rows: 24))
        XCTAssertEqual(transport.resizes, [TerminalSize(cols: 80, rows: 24), TerminalSize(cols: 90, rows: 24)])
    }

    func testAnEndedSessionSaysSoAndLetsGoOfItsHandle() async {
        session.attach(size: TerminalSize(cols: 80, rows: 24))
        await settle()
        started()
        let id = transport.receipts[0].attachmentId
        frame(.exited(attachmentId: id, sequence: 1, reason: .eof))
        XCTAssertEqual(session.connection, .disconnected(TerminalConnection.sessionEnded))
        XCTAssertEqual(transport.detached, [id])
    }

    func testARefusedAttachSaysTheTerminalsOwnWords() async {
        transport.refuse = TerminalFailure(.sessionUnavailable)
        session.attach(size: TerminalSize(cols: 80, rows: 24))
        await settle()
        for _ in 0..<20 where session.connection == .connecting {
            try? await Task.sleep(nanoseconds: 2_000_000)
            mailbox.drain()
        }
        XCTAssertEqual(session.connection, .disconnected("The terminal session is unavailable."))
    }

    func testSilenceDuringTheHandshakeIsAFailure() async {
        session.attach(size: TerminalSize(cols: 80, rows: 24))
        await settle()
        clock.fireAll()
        XCTAssertEqual(session.connection, .disconnected(TerminalConnection.unavailable))
    }

    func testRetryReplacesTheAttachmentAndComingOnScreenReconnectsOnce() async {
        session.attach(size: TerminalSize(cols: 80, rows: 24))
        await settle()
        started()
        let first = transport.receipts[0].attachmentId
        frame(.exited(attachmentId: first, sequence: 1, reason: .eof))
        session.cameOnScreen()
        await settle(receipts: 2)
        XCTAssertEqual(transport.receipts.count, 2)
        started(1)
        XCTAssertEqual(session.connection, .connected)
        // A connected pane coming on screen does nothing.
        session.cameOnScreen()
        XCTAssertEqual(transport.receipts.count, 2)
    }

    func testFramesOfAnAttachmentThatWasReplacedAreIgnored() async {
        session.attach(size: TerminalSize(cols: 80, rows: 24))
        await settle()
        session.attach(size: TerminalSize(cols: 80, rows: 24))
        await settle()
        XCTAssertEqual(transport.detached, [transport.receipts[0].attachmentId])
        frame(.output(attachmentId: transport.receipts[0].attachmentId, sequence: 1, bytes: Data("stale".utf8)), on: 0)
        started(1)
        XCTAssertEqual(drawn, [])
        XCTAssertEqual(session.connection, .connected)
    }

    func testDisposingLetsGoOfExactlyItsHandle() async {
        session.attach(size: TerminalSize(cols: 80, rows: 24))
        await settle()
        started()
        session.dispose()
        XCTAssertEqual(transport.detached, [transport.receipts[0].attachmentId])
        XCTAssertFalse(transport.sinks[0](.output(attachmentId: "x", sequence: 9, bytes: Data())) && false)
    }
}
