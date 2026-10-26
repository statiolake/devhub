// Port of apps/desktop/test/terminal/attachments.test.ts (the attachment
// logic, on a fake PTY and a clock the test moves) and surfaces.test.ts (the
// difference between putting a terminal down and ending it).

import Foundation
import XCTest
@testable import DevHubCore

final class FakePty: PseudoTerminal, @unchecked Sendable {
    let pid: Int32 = 4242
    let launch: PtyLaunch
    private let lock = NSLock()
    private var data: (@Sendable (Data) -> Void)?
    private var exit: (@Sendable (Int32?) -> Void)?
    private var _written: [Data] = []
    private var _resizes: [TerminalSize] = []
    private var _killed = false
    private var _paused = false

    init(_ launch: PtyLaunch) { self.launch = launch }

    var written: [Data] { lock.withLock { _written } }
    var resizes: [TerminalSize] { lock.withLock { _resizes } }
    var killed: Bool { lock.withLock { _killed } }
    var paused: Bool { lock.withLock { _paused } }

    func onData(_ listener: @escaping @Sendable (Data) -> Void) { lock.withLock { data = listener } }
    func onExit(_ listener: @escaping @Sendable (Int32?) -> Void) { lock.withLock { exit = listener } }
    func write(_ bytes: Data) { lock.withLock { _written.append(bytes) } }
    func resize(_ size: TerminalSize) { lock.withLock { _resizes.append(size) } }
    func kill() { lock.withLock { _killed = true } }
    func pause() { lock.withLock { _paused = true } }
    func resume() { lock.withLock { _paused = false } }

    /// Whatever the child printed.
    func emit(_ text: String) { emit(Data(text.utf8)) }
    func emit(_ bytes: Data) { lock.withLock { data }?(bytes) }
    func end() { lock.withLock { exit }?(0) }
}

/// A clock the test moves by hand, for the attachments' timers.
final class ManualScheduler: AttachmentScheduler, @unchecked Sendable {
    final class Timer: AttachmentTimer, @unchecked Sendable {
        let due: Double
        let work: @Sendable () -> Void
        var cancelled = false
        init(due: Double, work: @escaping @Sendable () -> Void) {
            self.due = due
            self.work = work
        }
        func cancel() { cancelled = true }
    }

    private let lock = NSLock()
    private var now = 0.0
    private var timers: [Timer] = []

    func after(_ milliseconds: Double, _ work: @escaping @Sendable () -> Void) -> any AttachmentTimer {
        lock.withLock {
            let timer = Timer(due: now + milliseconds, work: work)
            timers.append(timer)
            return timer
        }
    }

    func advance(_ milliseconds: Double) {
        let end = lock.withLock { now + milliseconds }
        while true {
            let next: Timer? = lock.withLock {
                let due = timers.filter { !$0.cancelled && $0.due <= end }.min { $0.due < $1.due }
                if let due {
                    timers.removeAll { $0 === due }
                    now = due.due
                }
                return due
            }
            guard let next else { break }
            next.work()
        }
        lock.withLock { now = end }
    }
}

private let SCRATCH_SURFACE = "workspace-terminal:00000000-0000-4000-8000-00000000005c"
private let WORKSPACE_SURFACE = "workspace-terminal:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
private let OTHER_WORKSPACE_SURFACE = "workspace-terminal:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

private func targetFor(_ surfaceKey: String) -> TerminalTarget {
    if surfaceKey == SCRATCH_SURFACE { return .localScratch }
    if surfaceKey == OTHER_WORKSPACE_SURFACE {
        return .workspace(machine: .local, workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", root: "/other")
    }
    return .workspace(machine: .local, workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", root: "/ws")
}

/// The per-attach factory these tests never reach.
private let unusedSpawn: PtyFactory = { _ in throw Said("the manager's injected spawn should have been used") }

final class Frames: @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [TerminalFrame] = []
    func append(_ frame: TerminalFrame) { lock.withLock { frames.append(frame) } }
    var all: [TerminalFrame] { lock.withLock { frames } }
    var types: [String] { all.map(\.type) }
    var last: TerminalFrame? { all.last }
    var outputs: [TerminalFrame] { all.filter { $0.type == "output" } }
    var text: String {
        outputs.map { frame in
            if case .output(_, _, let bytes) = frame { return String(decoding: bytes, as: UTF8.self) }
            return ""
        }.joined()
    }
    var outputBytes: Int {
        outputs.reduce(0) { total, frame in
            if case .output(_, _, let bytes) = frame { return total + bytes.count }
            return total
        }
    }
}

private final class PtyList: @unchecked Sendable {
    private let lock = NSLock()
    private var list: [FakePty] = []
    func add(_ pty: FakePty) { lock.withLock { list.append(pty) } }
    var all: [FakePty] { lock.withLock { list } }
}

private final class Harness {
    let scheduler = ManualScheduler()
    let ptys = PtyList()
    let manager: AttachmentManager

    init(failSpawn: Bool = false) {
        let counter = Counter()
        let ptys = self.ptys
        manager = AttachmentManager(
            spawn: { launch in
                if failSpawn { throw Said("no pty for you") }
                let pty = FakePty(launch)
                ptys.add(pty)
                return pty
            },
            randomBytes: { count in (0..<count).map { _ in UInt8(truncatingIfNeeded: counter.bump() * 7) } },
            scheduler: scheduler
        )
    }

    func context(surfaceKey: String, viewLabel: String, target: TerminalTarget, frames: Frames, sink: TerminalFrameSink? = nil) -> AttachContext {
        AttachContext(
            surfaceKey: surfaceKey, viewLabel: viewLabel, target: target, spawn: unusedSpawn,
            file: "/usr/bin/tmux", args: ["-L", "devhub", "attach-session", "-t", "scratch"], cwd: ".",
            environment: ["TERM": "xterm-256color"], size: TerminalSize(cols: 80, rows: 24),
            sink: sink ?? { frames.append($0); return true }
        )
    }

    /// Two phases, as in production: claim the ledger, resolve the session,
    /// then publish. The test does the resolving instantly.
    func attach(surfaceKey: String = SCRATCH_SURFACE, viewLabel: String = "shell:1") throws -> (receipt: TerminalAttachReceipt, frames: Frames, pty: FakePty) {
        let frames = Frames()
        let before = ptys.all.count
        let target = targetFor(surfaceKey)
        let permit = try manager.beginAttach(target: target, surfaceKey: surfaceKey, viewLabel: viewLabel, cancel: CancellationToken())
        let receipt = try manager.attach(permit, context(surfaceKey: surfaceKey, viewLabel: viewLabel, target: target, frames: frames))
        permit.release()
        return (receipt, frames, ptys.all[before])
    }

    /// Let the output coalescer's window pass.
    func flushOutput() { scheduler.advance(TerminalTransport.outputCoalesceMs) }
}

final class FlowControlTests: XCTestCase {
    func testHoldsOutputAtTheWindowUntilACumulativeAck() throws {
        let flow = FlowControl()
        for sequence in 1...8 { XCTAssertTrue(try flow.reserve(sequence, bytes: 1)) }
        XCTAssertFalse(try flow.reserve(9, bytes: 1))
        XCTAssertTrue(try flow.acknowledge(8))
        XCTAssertTrue(try flow.reserve(9, bytes: 1))
    }

    func testRefusesAFutureAckAndAnUnboundedFrame() throws {
        let flow = FlowControl()
        _ = try flow.reserve(1, bytes: 1)
        XCTAssertThrowsError(try flow.acknowledge(2))
        XCTAssertThrowsError(try flow.reserve(2, bytes: TerminalTransport.maxOutputFrameBytes + 1))
    }
}

final class AttachmentAttachTests: XCTestCase {
    func testGivesTheViewAStartedFrameBeforeAnyOutputAndAReceiptToMatch() throws {
        let test = Harness()
        let (receipt, frames, pty) = try test.attach()
        XCTAssertEqual(receipt.surfaceKey, SCRATCH_SURFACE)
        XCTAssertEqual(receipt.attachmentId.count, 32)
        XCTAssertTrue(receipt.attachmentId.allSatisfy { $0.isHexDigit && !$0.isUppercase })
        XCTAssertGreaterThan(receipt.targetGeneration, 0)
        XCTAssertEqual(frames.all, [.started(attachmentId: receipt.attachmentId, surfaceKey: SCRATCH_SURFACE, targetGeneration: receipt.targetGeneration, cols: 80, rows: 24)])
        pty.emit("hello")
        test.flushOutput()
        XCTAssertEqual(frames.all[1].type, "output")
        XCTAssertEqual(frames.all[1].sequence, 1)
        XCTAssertEqual(pty.launch.cwd, ".")
        // The client is tmux, never a shell: the shell lives in the session.
        XCTAssertEqual(pty.launch.file, "/usr/bin/tmux")
        XCTAssertTrue(pty.launch.args.contains("attach-session"))
    }

    func testAllocatesAMonotonicGenerationPerAttachment() throws {
        let test = Harness()
        let first = try test.attach(viewLabel: "shell:a").receipt
        let second = try test.attach(surfaceKey: WORKSPACE_SURFACE, viewLabel: "shell:b").receipt
        XCTAssertEqual(second.targetGeneration, first.targetGeneration + 1)
        XCTAssertNotEqual(second.attachmentId, first.attachmentId)
    }

    func testReplacesTheAttachmentTheSameSurfaceAlreadyHad() throws {
        let test = Harness()
        let first = try test.attach()
        let second = try test.attach()
        XCTAssertTrue(first.pty.killed)
        if case .exited(_, _, let reason)? = first.frames.last { XCTAssertEqual(reason, .detached) } else { XCTFail("not exited") }
        XCTAssertFalse(second.pty.killed)
        XCTAssertEqual(test.manager.count, 1)
    }

    func testSupersedesAnOlderInFlightAttachBeforeEitherCanPublish() throws {
        let test = Harness()
        let first = try test.manager.beginAttach(target: .localScratch, surfaceKey: SCRATCH_SURFACE, viewLabel: "shell:1", cancel: CancellationToken())
        let second = try test.manager.beginAttach(target: .localScratch, surfaceKey: SCRATCH_SURFACE, viewLabel: "shell:1", cancel: CancellationToken())
        XCTAssertTrue(first.cancel.isCancelled)
        XCTAssertFalse(second.cancel.isCancelled)
        let context = test.context(surfaceKey: SCRATCH_SURFACE, viewLabel: "shell:1", target: .localScratch, frames: Frames())
        XCTAssertThrowsError(try test.manager.attach(first, context)) { error in
            XCTAssertEqual((error as? TerminalFailure)?.code, .staleTarget)
        }
        XCTAssertEqual(test.ptys.all.count, 0)
        // Releasing the stale permit must not unregister the replacement.
        first.release()
        XCTAssertEqual(try test.manager.attach(second, context).surfaceKey, SCRATCH_SURFACE)
        second.release()
    }

    func testTellsTheViewWhenNoPtyCouldBeOpenedThenRefusesTheRequest() throws {
        let test = Harness(failSpawn: true)
        let frames = Frames()
        let permit = try test.manager.beginAttach(target: .localScratch, surfaceKey: SCRATCH_SURFACE, viewLabel: "shell:1", cancel: CancellationToken())
        XCTAssertThrowsError(try test.manager.attach(permit, test.context(surfaceKey: SCRATCH_SURFACE, viewLabel: "shell:1", target: .localScratch, frames: frames))) { error in
            let failure = error as? TerminalFailure
            XCTAssertEqual(failure?.code, .ptyUnavailable)
            // The reason the PTY could not open must not be lost on the way out.
            XCTAssertEqual(failure?.cause, "no pty for you")
        }
        XCTAssertEqual(frames.types, ["error", "exited"])
        if case .error(_, let sequence, let error)? = frames.all.first {
            XCTAssertEqual(error.code, .ptyUnavailable)
            XCTAssertEqual(sequence, 0)
        } else {
            XCTFail("no error frame")
        }
    }
}

final class OutputCoalescingTests: XCTestCase {
    func testMakesOneFrameOfTheReadsInsideOneWindowInOrder() throws {
        let test = Harness()
        let (_, frames, pty) = try test.attach()
        pty.emit("\u{1b}[H")
        pty.emit("row one")
        pty.emit("\u{1b}[2;1H")
        pty.emit("row two")
        // Nothing has been sent yet: the redraw is still arriving.
        XCTAssertEqual(frames.outputs.count, 0)
        test.flushOutput()
        XCTAssertEqual(frames.outputs.count, 1)
        XCTAssertEqual(frames.outputs[0].sequence, 1)
        XCTAssertEqual(frames.text, "\u{1b}[Hrow one\u{1b}[2;1Hrow two")
    }

    func testStartsANewWindowForTheNextRead() throws {
        let test = Harness()
        let (_, frames, pty) = try test.attach()
        pty.emit("a")
        test.flushOutput()
        pty.emit("b")
        test.flushOutput()
        XCTAssertEqual(frames.outputs.map(\.sequence), [1, 2])
        XCTAssertEqual(frames.text, "ab")
    }

    func testDoesNotWaitOnceThePendingBytesFillAFrame() throws {
        let test = Harness()
        let (_, frames, pty) = try test.attach()
        pty.emit(Data(repeating: 0x41, count: TerminalTransport.maxOutputFrameBytes - 1))
        XCTAssertEqual(frames.outputs.count, 0)
        // The read that crosses the bound flushes what is pending immediately.
        pty.emit("BB")
        XCTAssertEqual(frames.outputs.map(\.sequence), [1, 2])
        XCTAssertEqual(frames.outputBytes, TerminalTransport.maxOutputFrameBytes + 1)
        XCTAssertTrue(frames.text.hasSuffix("ABB"))
        test.flushOutput()
        XCTAssertEqual(frames.outputs.count, 2)
    }

    func testSendsWhatIsPendingBeforeTheExitFrame() throws {
        let test = Harness()
        let (_, frames, pty) = try test.attach()
        pty.emit("last words")
        pty.end()
        XCTAssertEqual(frames.types, ["started", "output", "exited"])
        XCTAssertEqual(frames.text, "last words")
        if case .exited(_, _, let reason)? = frames.last { XCTAssertEqual(reason, .eof) } else { XCTFail() }
    }

    func testSendsWhatIsPendingBeforeAFailureFrame() throws {
        let test = Harness()
        let (_, frames, pty) = try test.attach()
        for _ in 0..<9 {
            pty.emit("x")
            test.flushOutput()
        }
        pty.emit("pending")
        test.scheduler.advance(2_000)
        let types = frames.types
        XCTAssertEqual(Array(types.suffix(2)), ["error", "exited"])
        XCTAssertEqual(types.firstIndex(of: "error"), types.count - 2)
        if case .error(_, _, let error) = frames.all[types.count - 2] { XCTAssertEqual(error.code, .backpressure) } else { XCTFail() }
    }

    func testSendsWhatIsPendingBeforeADetachsExitFrame() throws {
        let test = Harness()
        let (receipt, frames, pty) = try test.attach()
        pty.emit("half a redraw")
        try test.manager.detach(receipt.identity(viewLabel: "shell:1"))
        XCTAssertEqual(frames.types, ["started", "output", "exited"])
        XCTAssertEqual(frames.text, "half a redraw")
        XCTAssertTrue(pty.killed)
    }

    func testEmitsNothingMoreOnceTheAttachmentHasStopped() throws {
        let test = Harness()
        let (_, frames, pty) = try test.attach()
        pty.emit("before")
        pty.end()
        let settled = frames.all.count
        pty.emit("after")
        test.flushOutput()
        XCTAssertEqual(frames.all.count, settled)
        XCTAssertEqual(frames.text, "before")
    }

    func testMetersCoalescedFramesThroughTheSameWindow() throws {
        let test = Harness()
        let (receipt, frames, pty) = try test.attach()
        for _ in 0..<9 {
            pty.emit("aa")
            pty.emit("bb")
            test.flushOutput()
        }
        XCTAssertEqual(frames.outputs.count, 8)
        XCTAssertTrue(pty.paused)
        try test.manager.acknowledge(receipt.identity(viewLabel: "shell:1"), sequence: 8)
        XCTAssertEqual(frames.outputs.count, 9)
        XCTAssertFalse(pty.paused)
        XCTAssertEqual(frames.text, String(repeating: "aabb", count: 9))
    }
}

final class AttachmentOutputTests: XCTestCase {
    func testSplitsAtTheFrameBoundAndKeepsTheSequenceContiguous() throws {
        let test = Harness()
        let (_, frames, pty) = try test.attach()
        pty.emit(Data(repeating: 0x41, count: TerminalTransport.maxOutputFrameBytes + 10))
        XCTAssertEqual(frames.outputs.map(\.sequence), [1, 2])
        XCTAssertEqual(frames.outputBytes, TerminalTransport.maxOutputFrameBytes + 10)
    }

    func testPausesTheChildOnceTheViewStopsConsumingAndResumesOnAck() throws {
        let test = Harness()
        let (receipt, frames, pty) = try test.attach()
        for _ in 0..<9 {
            pty.emit("x")
            test.flushOutput()
        }
        XCTAssertEqual(frames.outputs.count, 8)
        XCTAssertTrue(pty.paused)
        try test.manager.acknowledge(receipt.identity(viewLabel: "shell:1"), sequence: 8)
        XCTAssertEqual(frames.outputs.count, 9)
        XCTAssertFalse(pty.paused)
    }

    func testDisconnectsAViewThatNeverAcknowledges() throws {
        let test = Harness()
        let (_, frames, pty) = try test.attach()
        for _ in 0..<9 {
            pty.emit("x")
            test.flushOutput()
        }
        test.scheduler.advance(2_000)
        let all = frames.all
        if case .error(_, _, let error) = all[all.count - 2] { XCTAssertEqual(error.code, .backpressure) } else { XCTFail() }
        if case .exited(_, _, let reason) = all[all.count - 1] { XCTAssertEqual(reason, .detached) } else { XCTFail() }
        XCTAssertTrue(pty.killed)
    }

    func testEndsTheAttachmentWhenTheChildExits() throws {
        let test = Harness()
        let (_, frames, pty) = try test.attach()
        pty.emit("done\n")
        pty.end()
        if case .exited(_, _, let reason)? = frames.last { XCTAssertEqual(reason, .eof) } else { XCTFail() }
        XCTAssertEqual(test.manager.count, 0)
    }

    func testStopsProducingForAViewThatHasGoneAway() throws {
        let test = Harness()
        let permit = try test.manager.beginAttach(target: .localScratch, surfaceKey: SCRATCH_SURFACE, viewLabel: "shell:1", cancel: CancellationToken())
        XCTAssertThrowsError(try test.manager.attach(permit, test.context(surfaceKey: SCRATCH_SURFACE, viewLabel: "shell:1", target: .localScratch, frames: Frames(), sink: { _ in false }))) { error in
            XCTAssertEqual((error as? TerminalFailure)?.code, .channelClosed)
        }
        XCTAssertTrue(test.ptys.all[0].killed)
        XCTAssertEqual(test.manager.count, 0)
    }
}

final class AttachmentInputTests: XCTestCase {
    func testAcceptsAStrictSequenceAndRefusesReplaysAndGaps() throws {
        let test = Harness()
        let (receipt, _, pty) = try test.attach()
        let identity = receipt.identity(viewLabel: "shell:1")
        try test.manager.input(identity, sequence: 1, Data("first\n".utf8))
        XCTAssertThrowsError(try test.manager.input(identity, sequence: 3, Data("gap".utf8))) { error in
            XCTAssertEqual((error as? TerminalFailure)?.code, .invalidRequest)
        }
        try test.manager.input(identity, sequence: 2, Data("second\n".utf8))
        XCTAssertThrowsError(try test.manager.input(identity, sequence: 2, Data("replay".utf8)))
        XCTAssertEqual(String(decoding: pty.written.reduce(Data(), +), as: UTF8.self), "first\nsecond\n")
    }

    func testRefusesARequestThatDoesNotOwnTheAttachment() throws {
        let test = Harness()
        let identity = try test.attach().receipt.identity(viewLabel: "shell:1")
        var wrongs: [TerminalRequestIdentity] = []
        var one = identity
        one.viewLabel = "shell:2"
        wrongs.append(one)
        one = identity
        one.targetGeneration += 1
        wrongs.append(one)
        one = identity
        one.attachmentId = String(repeating: "f", count: 32)
        wrongs.append(one)
        one = identity
        one.surfaceKey = WORKSPACE_SURFACE
        wrongs.append(one)
        for wrong in wrongs {
            XCTAssertThrowsError(try test.manager.input(wrong, sequence: 1, Data([65]))) { error in
                XCTAssertEqual((error as? TerminalFailure)?.code, .wrongAttachment)
            }
        }
    }
}

final class AttachmentResizeTests: XCTestCase {
    func testIsLatestWinsAndReachesThePtyOncePerInterval() throws {
        let test = Harness()
        let (receipt, _, pty) = try test.attach()
        let identity = receipt.identity(viewLabel: "shell:1")
        try test.manager.resize(identity, TerminalSize(cols: 80, rows: 24))
        try test.manager.resize(identity, TerminalSize(cols: 100, rows: 30))
        try test.manager.resize(identity, TerminalSize(cols: 120, rows: 40))
        XCTAssertEqual(pty.resizes.count, 0)
        test.scheduler.advance(16)
        XCTAssertEqual(pty.resizes, [TerminalSize(cols: 120, rows: 40)])
    }

    func testRefusesASizeOutsideTheBounds() throws {
        let test = Harness()
        let identity = try test.attach().receipt.identity(viewLabel: "shell:1")
        XCTAssertThrowsError(try test.manager.resize(identity, TerminalSize(cols: 0, rows: 24))) { error in
            XCTAssertEqual((error as? TerminalFailure)?.code, .invalidResize)
        }
    }
}

final class AttachmentDetachTests: XCTestCase {
    func testIsIdempotentForTheExactHandleAndRefusesADifferentOne() throws {
        let test = Harness()
        let (receipt, frames, pty) = try test.attach()
        let identity = receipt.identity(viewLabel: "shell:1")
        var other = identity
        other.viewLabel = "shell:2"
        XCTAssertThrowsError(try test.manager.detach(other)) { error in
            XCTAssertEqual((error as? TerminalFailure)?.code, .wrongAttachment)
        }
        try test.manager.detach(identity)
        XCTAssertTrue(pty.killed)
        if case .exited(_, _, let reason)? = frames.last { XCTAssertEqual(reason, .detached) } else { XCTFail() }
        // The handle is gone, and a second release of it is not an error.
        XCTAssertNoThrow(try test.manager.detach(identity))
        XCTAssertEqual(test.manager.count, 0)
    }

    func testTakesAClosedViewsAndTheWholeAppsAttachmentsWithIt() throws {
        let test = Harness()
        let first = try test.attach(viewLabel: "shell:a")
        let second = try test.attach(surfaceKey: WORKSPACE_SURFACE, viewLabel: "shell:b")
        test.manager.detachView("shell:a")
        XCTAssertTrue(first.pty.killed)
        XCTAssertFalse(second.pty.killed)
        test.manager.detachAll()
        XCTAssertTrue(second.pty.killed)
        XCTAssertEqual(test.manager.count, 0)
    }

    func testRefusesEveryRequestOnceTheAttachmentHasEnded() throws {
        let test = Harness()
        let (receipt, _, pty) = try test.attach()
        pty.end()
        XCTAssertThrowsError(try test.manager.input(receipt.identity(viewLabel: "shell:1"), sequence: 1, Data([65]))) { error in
            XCTAssertTrue(error is TerminalFailure)
        }
    }

    func testDetachesEveryClientOfOneTerminalAndNoOther() throws {
        let test = Harness()
        let one = try test.attach(surfaceKey: WORKSPACE_SURFACE, viewLabel: "shell:a")
        let other = try test.attach(surfaceKey: OTHER_WORKSPACE_SURFACE, viewLabel: "shell:a")
        test.manager.detachTarget(targetFor(WORKSPACE_SURFACE))
        XCTAssertTrue(one.pty.killed)
        XCTAssertFalse(other.pty.killed)
    }
}

/// Who owns an attachment: the (window, surface) pair.
final class AttachmentOwnershipTests: XCTestCase {
    let page = "7"
    let otherPage = "9"

    func testLetsEveryTerminalSurfaceOfOnePageHoldItsOwnAttachment() throws {
        let test = Harness()
        let scratch = try test.attach(viewLabel: page)
        let workspace = try test.attach(surfaceKey: WORKSPACE_SURFACE, viewLabel: page)
        let other = try test.attach(surfaceKey: OTHER_WORKSPACE_SURFACE, viewLabel: page)
        XCTAssertEqual(test.manager.count, 3)
        for surface in [scratch, workspace, other] {
            XCTAssertFalse(surface.pty.killed)
            XCTAssertEqual(surface.frames.last?.type, "started")
        }
        try test.manager.input(scratch.receipt.identity(viewLabel: page), sequence: 1, Data("a".utf8))
        try test.manager.input(workspace.receipt.identity(viewLabel: page), sequence: 1, Data("b".utf8))
        try test.manager.input(other.receipt.identity(viewLabel: page), sequence: 1, Data("c".utf8))
        XCTAssertEqual(scratch.pty.written.map { $0.first }, [0x61])
        XCTAssertEqual(workspace.pty.written.map { $0.first }, [0x62])
        XCTAssertEqual(other.pty.written.map { $0.first }, [0x63])
    }

    func testKeepsTwoAttachesOfOnePageInFlightTogether() throws {
        let test = Harness()
        let scratch = try test.manager.beginAttach(target: .localScratch, surfaceKey: SCRATCH_SURFACE, viewLabel: page, cancel: CancellationToken())
        let workspace = try test.manager.beginAttach(target: targetFor(WORKSPACE_SURFACE), surfaceKey: WORKSPACE_SURFACE, viewLabel: page, cancel: CancellationToken())
        XCTAssertFalse(scratch.cancel.isCancelled)
        XCTAssertFalse(workspace.cancel.isCancelled)
        scratch.release()
        workspace.release()
    }

    func testSupersedesTheSurfaceThatRemountedAndOnlyThatOne() throws {
        let test = Harness()
        let scratch = try test.attach(viewLabel: page)
        let workspace = try test.attach(surfaceKey: WORKSPACE_SURFACE, viewLabel: page)
        let remounted = try test.attach(surfaceKey: WORKSPACE_SURFACE, viewLabel: page)
        XCTAssertTrue(workspace.pty.killed)
        if case .exited(_, _, let reason)? = workspace.frames.last { XCTAssertEqual(reason, .detached) } else { XCTFail() }
        XCTAssertFalse(remounted.pty.killed)
        XCTAssertFalse(scratch.pty.killed)
        XCTAssertEqual(test.manager.count, 2)
    }

    func testRefusesAReceiptOnlyOnceItIsGenuinelyStale() throws {
        let test = Harness()
        let scratch = try test.attach(viewLabel: page)
        let workspace = try test.attach(surfaceKey: WORKSPACE_SURFACE, viewLabel: page)
        let remounted = try test.attach(surfaceKey: WORKSPACE_SURFACE, viewLabel: page)
        XCTAssertThrowsError(try test.manager.input(workspace.receipt.identity(viewLabel: page), sequence: 1, Data([65]))) { error in
            XCTAssertEqual((error as? TerminalFailure)?.code, .wrongAttachment)
        }
        XCTAssertNoThrow(try test.manager.input(scratch.receipt.identity(viewLabel: page), sequence: 1, Data([65])))
        XCTAssertNoThrow(try test.manager.input(remounted.receipt.identity(viewLabel: page), sequence: 1, Data([65])))
        // A live handle presented by another window is still foreign.
        XCTAssertThrowsError(try test.manager.input(scratch.receipt.identity(viewLabel: otherPage), sequence: 2, Data([65]))) { error in
            XCTAssertEqual((error as? TerminalFailure)?.code, .wrongAttachment)
        }
    }

    func testReleasesEverySurfaceOfAPageThatGoesAwayAndNoOtherPages() throws {
        let test = Harness()
        let scratch = try test.attach(viewLabel: page)
        let workspace = try test.attach(surfaceKey: WORKSPACE_SURFACE, viewLabel: page)
        let elsewhere = try test.attach(surfaceKey: OTHER_WORKSPACE_SURFACE, viewLabel: otherPage)
        test.manager.detachView(page)
        XCTAssertTrue(scratch.pty.killed)
        XCTAssertTrue(workspace.pty.killed)
        XCTAssertFalse(elsewhere.pty.killed)
        XCTAssertEqual(test.manager.count, 1)
    }
}

/// The difference between putting a terminal down and ending it: a detach
/// touches clients and nothing else, so there is no route from it to a
/// `kill-session`.
final class TerminalSurfacesTests: XCTestCase {
    let scratch = ScratchDirectories()
    override func tearDown() { scratch.removeAll() }

    /// A tmux that writes down every time it is asked anything, and answers
    /// as an absent server would.
    func loggingTmux() -> (runtime: TmuxTerminalRuntime, log: String) {
        let dir = scratch.make("surfaces")
        let log = Path.join(dir, "calls")
        let path = Path.join(dir, "tmux")
        try! Data("#!/bin/sh\necho \"$*\" >>'\(log)'\n[ \"$3\" = \"-V\" ] && { echo 'tmux 3.4'; exit 0; }\necho 'no server running on /tmp/x' >&2\nexit 1\n".utf8)
            .write(to: URL(fileURLWithPath: path))
        chmod(path, 0o755)
        let runtime = unitRuntime(home: dir, tmux: ResolvedExecutable(path: path, basename: "tmux"), timeoutMs: 5_000)
        return (runtime, log)
    }

    func calls(_ log: String) -> [String] { loggedCalls(log) }

    let target = WorkspaceTerminalTarget(machine: .local, workspaceId: "00000000-0000-4000-8000-0000000000aa", root: "/projects/widget")

    func testDetachesEveryClientAndAsksTheRuntimeForNothing() throws {
        let (runtime, log) = loggingTmux()
        let test = Harness()
        let surfaces = TerminalSurfaces(runtimeFor: { machine in
            XCTAssertEqual(machine, .local)
            return runtime
        }, attachments: test.manager)
        let attached = try test.attach(surfaceKey: WORKSPACE_SURFACE)
        surfaces.detachAll()
        XCTAssertTrue(attached.pty.killed)
        XCTAssertEqual(calls(log), [])
    }

    func testLetsGoOfOnePagesSurfacesWithoutEndingAnything() throws {
        let (runtime, log) = loggingTmux()
        let test = Harness()
        let surfaces = TerminalSurfaces(runtimeFor: { _ in runtime }, attachments: test.manager)
        let attached = try test.attach(viewLabel: "overlay")
        surfaces.detachView("overlay")
        XCTAssertTrue(attached.pty.killed)
        XCTAssertEqual(calls(log), [])
    }

    func testLetsGoOfItsClientsFirstThenKillsTheSession() async throws {
        let (runtime, log) = loggingTmux()
        let test = Harness()
        let surfaces = TerminalSurfaces(runtimeFor: { _ in runtime }, attachments: test.manager)
        let frames = Frames()
        let seenWhenDetached = Counter()
        let workspace = TerminalTarget.workspace(target)
        let permit = try test.manager.beginAttach(target: workspace, surfaceKey: "workspace-terminal:\(target.workspaceId)", viewLabel: "shell:1", cancel: CancellationToken())
        _ = try test.manager.attach(permit, test.context(
            surfaceKey: "workspace-terminal:\(target.workspaceId)", viewLabel: "shell:1", target: workspace, frames: frames,
            sink: { frame in
                if frame.type == "exited" { for _ in loggedCalls(log) { _ = seenWhenDetached.bump() } }
                frames.append(frame)
                return true
            }
        ))
        permit.release()
        try await surfaces.closeWorkspace(target)
        XCTAssertEqual(frames.last?.type, "exited")
        // Nothing had asked tmux anything when the client was let go of.
        XCTAssertEqual(seenWhenDetached.value(), 0)
        XCTAssertFalse(self.calls(log).isEmpty)
    }
}

func loggedCalls(_ log: String) -> [String] {
    ((try? String(contentsOfFile: log, encoding: .utf8)) ?? "").components(separatedBy: "\n").filter { !$0.isEmpty }
}
