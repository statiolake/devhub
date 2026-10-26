// The conversation view's transport (conversationIpc.ts) and the view's fold
// (`useConversation` in ConversationPane.tsx): attach once, then fold the
// numbered events — nothing between the snapshot and the first event is
// lost, nothing the snapshot holds is folded twice, a gap is reported — and
// every other act of the view is the app's own call, refused in the app's
// own words.

import Foundation
import XCTest
@testable import DevHubCore

/// A transport on a `GuiRig`, with what it was asked to do recorded.
final class TransportRig {
    let gui = GuiRig()
    let drafts: AgentDrafts
    let continued = Recorder<(AgentId, AgentPresentation, String?)>()
    let restarted = Recorder<AgentId>()
    let opened = Recorder<(AgentId, String, FileSelection?)>()
    let directory: String
    var transport: ConversationTransport!

    init() async throws {
        directory = NSTemporaryDirectory() + "devhub-transport-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        drafts = try AgentDrafts.load(directory + "/drafts.json", accounted: { [GUI_AGENT] }).drafts
        let continued = continued, restarted = restarted, opened = opened
        transport = await ConversationTransport.start(ConversationTransportOptions(
            conversations: gui.wiring, drafts: drafts,
            continueIn: { continued.add(($0, $1, $2)) },
            restart: { restarted.add($0) },
            terminalSession: { _ in "the-terminal-session" },
            openFile: { opened.add(($0, $1, $2)) }))
    }

    deinit { try? FileManager.default.removeItem(atPath: directory) }
}

/// Everything the stream has handed out so far, read without waiting for more.
final class UpdatesSeen: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [ConversationUpdate] = []
    private var finished = false
    private var task: Task<Void, Never>?

    init(_ stream: AsyncStream<ConversationUpdate>) {
        task = Task { [weak self] in
            for await update in stream { self?.lock.withLock { self?.items.append(update) } }
            self?.lock.withLock { self?.finished = true }
        }
    }

    deinit { task?.cancel() }

    var all: [ConversationUpdate] { lock.withLock { items } }
    var ended: Bool { lock.withLock { finished } }
}

private func eventually(_ condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
    for _ in 0..<400 {
        if await condition() { return }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    XCTFail("it did not happen", file: file, line: line)
}

final class ConversationTransportTests: XCTestCase {
    func testAttachingHandsOverTheConversationSoFarAndItsDraftThenEveryEventAfter() async throws {
        let rig = try await TransportRig()
        let conversation = try await rig.gui.idle()
        rig.transport.saveDraft(GUI_AGENT, "half a thought")
        let updates = UpdatesSeen(rig.transport.updates())
        let attachment = try await rig.transport.attach(GUI_AGENT)
        XCTAssertEqual(attachment.draft, "half a thought")
        var follower = ConversationFollower(agentId: GUI_AGENT)
        try follower.attached(attachment)

        try await rig.transport.command(GUI_AGENT, .send(text: "Say one", images: []))
        await settle(conversation, rig.gui.host)
        let live = await conversation.snapshot()
        await eventually { updates.all.last?.revision == live.revision }
        for update in updates.all { try follower.take(update) }
        XCTAssertEqual(follower.transcript, live.transcript)
        XCTAssertEqual(follower.revision, live.revision)
        // The person's words, as the person's.
        XCTAssertEqual(live.transcript.entries.compactMap(\.userEntry).first?.origin, .person)
    }

    func testOnlyAttachedConversationsAreSentAndADetachedOneIsLetGo() async throws {
        let rig = try await TransportRig()
        let conversation = try await rig.gui.idle()
        let updates = UpdatesSeen(rig.transport.updates())
        try await conversation.submit("not attached yet", images: [])
        await settle(conversation, rig.gui.host)
        XCTAssertEqual(updates.all, [])

        _ = try await rig.transport.attach(GUI_AGENT)
        XCTAssertEqual(rig.transport.attachedAgents, [GUI_AGENT])
        await rig.transport.detach(GUI_AGENT)
        XCTAssertEqual(rig.transport.attachedAgents, [])
        try await conversation.submit("detached", images: [])
        await settle(conversation, rig.gui.host)
        XCTAssertEqual(updates.all, [])
    }

    func testANewViewTakesTheOldOnesAttachmentsAway() async throws {
        let rig = try await TransportRig()
        _ = try await rig.gui.idle()
        let first = UpdatesSeen(rig.transport.updates())
        _ = try await rig.transport.attach(GUI_AGENT)
        _ = rig.transport.updates()
        XCTAssertEqual(rig.transport.attachedAgents, [])
        await eventually { first.ended }
        rig.transport.viewGone()
        let refused = await rig.transport.attachRefusal(GUI_AGENT)
        XCTAssertEqual(refused, "there is no conversation view to attach")
    }

    func testContinuesInTheTerminalOnTheSessionTheCliNamedAndInTheGuiOnTheTerminals() async throws {
        let rig = try await TransportRig()
        let conversation = try await rig.gui.idle()
        // Before the CLI names a session there is nothing to resume.
        try await rig.transport.continueInTerminal(GUI_AGENT)
        try await conversation.submit("Say one", images: [])
        await settle(conversation, rig.gui.host)
        try await rig.transport.continueInTerminal(GUI_AGENT)
        try await rig.transport.continueInGui(GUI_AGENT)
        try await rig.transport.restartSession(GUI_AGENT)
        XCTAssertEqual(rig.continued.all.map { "\($0.1.rawValue) \($0.2 ?? "none")" }, ["tui none", "tui s-1", "gui the-terminal-session"])
        XCTAssertEqual(rig.restarted.all, [AgentId(unchecked: GUI_AGENT)])
    }

    func testOpensOnlyAnAbsolutePathAndSaysWhereInTheFile() async throws {
        let rig = try await TransportRig()
        try await rig.transport.openFile(GUI_AGENT, path: "/srv/api/a.ts", range: .lines(from: 3, to: 5))
        XCTAssertEqual(rig.opened.all.first?.1, "/srv/api/a.ts")
        XCTAssertEqual(rig.opened.all.first?.2, fileSelection(FileRange.lines(from: 3, to: 5)))
        do {
            try await rig.transport.openFile(GUI_AGENT, path: "a.ts", range: nil)
            XCTFail("a relative path was opened")
        } catch {
            // Refused in the app's own shape.
            XCTAssertTrue(error is NamedFailure)
            XCTAssertTrue(failureText(error).contains("is not a file to open"))
        }
    }

    func testRefusesASignInThroughTheCommandsAndNamesTheRefusal() async throws {
        let rig = try await TransportRig()
        _ = try await rig.gui.idle()
        do {
            try await rig.transport.command(GUI_AGENT, .mcp(.act(action: .signIn, server: "linear")))
            XCTFail("a sign-in went to the CLI")
        } catch {
            XCTAssertTrue(error is NamedFailure)
        }
        do {
            try await rig.transport.mcpSignIn(GUI_AGENT, server: "linear")
            XCTFail("a sign-in nobody offers started")
        } catch {
            XCTAssertEqual(errorWire(error).code, .conversationRefused)
        }
    }

    func testRewindsThroughTheConversation() async throws {
        let rig = try await TransportRig()
        let conversation = try await rig.gui.idle()
        try await conversation.submit("Say one", images: [])
        await settle(conversation, rig.gui.host)
        do {
            _ = try await rig.transport.rewind(GUI_AGENT, to: EntryId("nothing"))
            XCTFail("rewound to nothing")
        } catch {
            XCTAssertTrue(error is NamedFailure)
        }
    }
}

extension ConversationTransport {
    /// The words an attach is refused with.
    func attachRefusal(_ agentId: String) async -> String? {
        do {
            _ = try await attach(agentId)
            return nil
        } catch {
            return errorWire(error).detail
        }
    }
}

final class ConversationFollowerTests: XCTestCase {
    private let notice = ConversationEvent.entry(.notice(NoticeEntry(id: "n1", level: .info, text: "one")))
    private let other = ConversationEvent.entry(.notice(NoticeEntry(id: "n2", level: .info, text: "two")))

    func testHoldsWhatArrivesBeforeTheAttachmentAndDropsWhatItAlreadyHolds() throws {
        var follower = ConversationFollower(agentId: "a")
        XCTAssertFalse(try follower.take(ConversationUpdate(agentId: "a", revision: 4, event: notice)))
        XCTAssertFalse(try follower.take(ConversationUpdate(agentId: "a", revision: 5, event: other)))
        XCTAssertEqual(follower.transcript, EMPTY_TRANSCRIPT)
        // The snapshot was taken after event 4: only 5 is news.
        let held = try applyEvent(EMPTY_TRANSCRIPT, notice)
        try follower.attached(ConversationAttachment(transcript: held, revision: 4, draft: "d"))
        XCTAssertEqual(follower.revision, 5)
        XCTAssertEqual(follower.draft, "d")
        XCTAssertEqual(follower.transcript.entries.count, 2)
        XCTAssertFalse(try follower.take(ConversationUpdate(agentId: "a", revision: 5, event: other)))
        // Another Agent's events are not this one's.
        XCTAssertFalse(try follower.take(ConversationUpdate(agentId: "b", revision: 6, event: other)))
    }

    func testAGapIsReportedAndNothingIsFoldedAfterIt() throws {
        var follower = ConversationFollower(agentId: "a")
        try follower.attached(ConversationAttachment(transcript: EMPTY_TRANSCRIPT, revision: 0, draft: ""))
        XCTAssertThrowsError(try follower.take(ConversationUpdate(agentId: "a", revision: 2, event: notice))) { error in
            XCTAssertEqual("\(error)", "the conversation of Agent a skipped from event 0 to 2")
        }
        XCTAssertNotNil(follower.broken)
        XCTAssertFalse(try follower.take(ConversationUpdate(agentId: "a", revision: 1, event: notice)))
        XCTAssertEqual(follower.transcript, EMPTY_TRANSCRIPT)
    }

    func testAnEventTheFoldRefusesStopsWhatIsDrawnWhereItWasTrue() throws {
        var follower = ConversationFollower(agentId: "a")
        try follower.attached(ConversationAttachment(transcript: EMPTY_TRANSCRIPT, revision: 0, draft: ""))
        // A delta for an entry that is not there.
        XCTAssertThrowsError(try follower.take(ConversationUpdate(
            agentId: "a", revision: 1, event: .textDelta(entry: "missing", block: 0, text: "x"))))
        XCTAssertNotNil(follower.broken)
        XCTAssertEqual(follower.revision, 0)
    }
}
