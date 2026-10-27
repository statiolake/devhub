// Port of the GUI half of apps/desktop/src/main/shell/agentWiring.ts
// (`wireAgents`: `conversationOn`, `GuiConversations`, `endConversation`, the
// GUI branch of `launch`, of `stopAgent` and of the reconcile round,
// `endingSentence`), and the conversation half of appController.ts that is
// not the window's (`restartAgent`'s GUI branch, the tell port's
// `conversation`, `usageLimitsListener`, `reconsiderCacheKeeping`).
//
// A GUI Agent is a tmux session like a terminal Agent (WP3's `AgentSessions`,
// the same markers and the same Stop); what differs is the session command —
// its CLI in structured mode under the host (`hostSessionCommand`) — and
// where its status is read from: its conversation (WP5's `AgentConversation`
// with WP5's Claude adapter or WP6's Codex adapter), which this file makes on
// first ask and keeps in the one `ConversationRegistry` until its Agent is
// stopped or ends. The terminal half (WP3's `TerminalAgentWiring`) calls in
// here through `GuiAgentRounds` from its round; the controller calls in
// through `GuiAgentControl`.

import Foundation

/// Where a GUI Agent's session is started: WP3's `AgentSessions`, the same
/// one the round asks whether an Agent is still being launched.
public protocol GuiAgentSessions: Sendable {
    func launchGuiSession(_ spec: AgentLaunchSpec) async throws
}

extension AgentSessions: GuiAgentSessions {
    public func launchGuiSession(_ spec: AgentLaunchSpec) async throws { try await launch(spec) }
}

/// A host's files as the GUI half reads them: the conversation's link, and
/// how the CLI ended once its session is gone. `HostLink` is the real one.
public protocol GuiHostLink: HostOnLink {
    func ending() async throws -> HostEnding
}

extension HostLink: GuiHostLink {}

/// What the GUI half of the Agents is built from (`AgentWiringOptions`).
public struct GuiAgentWiringOptions: Sendable {
    public var sessions: any GuiAgentSessions
    /// The live model: the authority on which Agents exist and where they run.
    public var model: any TerminalAgentModel
    /// The machine itself, for a GUI Agent's host files and journal.
    public var machineRuntime: @Sendable (RuntimeId) throws -> any MachineRuntime
    /// Say something app-wide about an Agent that is no longer there to say
    /// it on: how a GUI Agent's CLI ended, once its row is gone.
    public var report: @Sendable (String) -> Void
    /// DevHub's version, which a protocol that asks who the client is is told.
    public var clientVersion: String
    /// This DevHub profile's tag, which keeps its host files apart from another profile's.
    public var profileTag: String
    /// `[agents] resume_after_limit` and its message, as the config says now.
    public var resumeAfterLimit: @Sendable () -> LimitResumeSettings
    /// What each GUI Agent's conversation decided about a usage limit, kept across restarts.
    public var limitResumes: any AgentRecordStore<LimitResumeRecord>
    /// `[agents] auto_compact_*`, as the config says now.
    public var cacheKeeping: @Sendable () -> CacheKeepSettings
    /// The `/devhub` skill for Agents on a machine, or nil where there is none.
    public var devhubSkill: @Sendable (RuntimeId) async -> DevhubSkill?
    /// The clock usage-limit resumes and the cache keeper run on.
    public var clock: ConversationClock
    /// The link to a host's files on a machine (`HostLink`); a test's own.
    public var link: @Sendable (any MachineRuntime, String) -> any GuiHostLink
    public var log: @Sendable (String) -> Void

    public init(
        sessions: any GuiAgentSessions, model: any TerminalAgentModel,
        machineRuntime: @escaping @Sendable (RuntimeId) throws -> any MachineRuntime = { try MachineRuntimes.runtime(for: $0) },
        report: @escaping @Sendable (String) -> Void, clientVersion: String, profileTag: String,
        resumeAfterLimit: @escaping @Sendable () -> LimitResumeSettings,
        limitResumes: any AgentRecordStore<LimitResumeRecord>,
        cacheKeeping: @escaping @Sendable () -> CacheKeepSettings = { CACHE_KEEP_OFF },
        devhubSkill: @escaping @Sendable (RuntimeId) async -> DevhubSkill? = { _ in nil },
        clock: ConversationClock = REAL_CLOCK,
        link: @escaping @Sendable (any MachineRuntime, String) -> any GuiHostLink = { runtime, directory in
            HostLink(machine: RuntimeHostMachine(runtime), stateDirectory: directory)
        },
        log: @escaping @Sendable (String) -> Void = { FileHandle.standardError.write(Data(($0 + "\n").utf8)) }
    ) {
        self.sessions = sessions
        self.model = model
        self.machineRuntime = machineRuntime
        self.report = report
        self.clientVersion = clientVersion
        self.profileTag = profileTag
        self.resumeAfterLimit = resumeAfterLimit
        self.limitResumes = limitResumes
        self.cacheKeeping = cacheKeeping
        self.devhubSkill = devhubSkill
        self.clock = clock
        self.link = link
        self.log = log
    }
}

/// A failure of this file's own lookups (`new Error(...)` in TS): an Agent
/// that is not there, or not a GUI Agent. Said as it is.
public struct GuiAgentMissing: Error, Equatable, Sendable, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}

/// The GUI Agents' conversations, and everything a GUI Agent is besides its
/// session (`GuiConversations` in agentWiring.ts).
public final class GuiAgentWiring: GuiAgentControl, GuiAgentRounds, @unchecked Sendable {
    public let registry = ConversationRegistry()
    /// Names this DevHub in the ids of the control requests its adapters
    /// make, so a restart never reuses one a CLI may still be answering.
    public let bootId = String(UUID().uuidString.lowercased().prefix(8))
    private let options: GuiAgentWiringOptions
    private let lock = NSLock()
    /// Each GUI Agent's MCP sign-in, running or run last.
    private var signIns: [String: McpSignInRun] = [:]

    public init(_ options: GuiAgentWiringOptions) {
        self.options = options
    }

    /// The whole Agent port: WP3's terminal half with this GUI half plugged
    /// into its round and its launch, on one `AgentSessions`.
    public static func wire(
        runtimeFor: @escaping @Sendable (RuntimeId) async throws -> TmuxTerminalRuntime,
        model: any TerminalAgentModel,
        machineRuntime: @escaping @Sendable (RuntimeId) throws -> any MachineRuntime = { try MachineRuntimes.runtime(for: $0) },
        skilled: (@Sendable (RuntimeId, TerminalAgentProfile, [String]) async -> [String])? = nil,
        log: (@Sendable (String) -> Void)? = nil,
        gui: (AgentSessions) -> GuiAgentWiringOptions
    ) -> (port: TerminalAgentPort, terminal: TerminalAgentWiring, gui: GuiAgentWiring) {
        let sessions = AgentSessions(runtimeFor: runtimeFor)
        let conversations = GuiAgentWiring(gui(sessions))
        let terminal = TerminalAgentWiring(
            runtimeFor: runtimeFor, sessions: sessions, model: model, machineRuntime: machineRuntime, gui: conversations,
            skilled: skilled, log: log)
        return (TerminalAgentPort(wiring: terminal, gui: conversations), terminal, conversations)
    }

    // MARK: - Places

    private func stateDirectory(_ machine: RuntimeId, _ agentId: String) async throws -> String {
        try agentStateDirectory(
            home: try await options.machineRuntime(machine).home(), profileTag: options.profileTag, agentId: agentId)
    }

    /// Where an Agent runs and what it runs: what its sessions are read with.
    private func placeOf(_ agentId: String) throws -> (
        agent: TerminalAgentRecord, workspace: TerminalAgentWorkspace, machine: RuntimeId, runtime: any MachineRuntime
    ) {
        guard let place = options.model.place(of: agentId) else {
            throw GuiAgentMissing("there is no running Agent \(agentId)")
        }
        return (place.agent, place.workspace, place.machine, try options.machineRuntime(place.machine))
    }

    static func cliKind(_ kind: AgentProfileKind) throws -> SessionCLIKind {
        guard let cli = SessionCLIKind(rawValue: kind.rawValue) else {
            throw InvariantViolation("a \(kind.rawValue) Agent cannot be a GUI Agent")
        }
        return cli
    }

    static func sessionProfile(_ profile: TerminalAgentProfile) throws -> SessionProfile {
        SessionProfile(kind: try cliKind(profile.kind), command: profile.command, args: profile.args, env: profile.env)
    }

    static func guiProfile(_ profile: TerminalAgentProfile, args: [String]) throws -> GuiAgentProfile {
        GuiAgentProfile(
            kind: try cliKind(profile.kind), command: profile.command, args: args,
            env: profile.env.sorted { $0.key < $1.key }.map { ($0.key, $0.value) })
    }

    // MARK: - The conversation

    /// The Agent's conversation, made on first ask. Nothing here can fail but
    /// DevHub's own invariants: opening the host is the conversation's first
    /// act, so a machine that cannot be asked is that Agent's failure, read on
    /// its pane, rather than a failure of whoever asked.
    func conversationOn(_ machine: RuntimeId, _ agentId: String, _ profile: TerminalAgentProfile, _ root: String) async throws
        -> AgentConversation
    {
        if let existing = await registry.get(agentId) { return existing }
        let kind = try Self.cliKind(profile.kind)
        // Known once the host is opened: on another machine the skill is a
        // file DevHub writes there, which can be after this conversation is
        // made. The adapter asks for its instructions when it opens a thread,
        // which is after that.
        let skill = Guarded<DevhubSkill?>(nil)
        let options = self.options
        let host = openedLater { [self] in
            let found = await options.devhubSkill(machine)
            skill.with { $0 = found }
            let args = DevhubSkill.arguments(kind: profile.kind.rawValue, args: profile.args, skill: found)
            let skilled = try Self.guiProfile(profile, args: args)
            let runtime = try options.machineRuntime(machine)
            return hostOn(options.link(runtime, try await self.stateDirectory(machine, agentId))) { session in
                let cli = guiAgentCli(skilled, session: session)
                return RestartedCLI(file: cli.file, args: cli.args)
            }
        }
        let limits = LimitResumeOptions(
            settings: options.resumeAfterLimit,
            record: LimitResumeRecordSlot(
                get: { options.limitResumes.get(agentId) }, set: { options.limitResumes.set(agentId, $0) }),
            clock: options.clock)
        let bootId = self.bootId
        return try await registry.open(agentId) { publish in
            AgentConversation(
                host: host,
                adapter: guiConversationAdapter(
                    kind, profileArgs: profile.args, bootId: bootId, cwd: root, clientVersion: options.clientVersion,
                    developerInstructions: { skill.with { $0 }?.codexInstructions }),
                publish: publish, limits: limits,
                cacheKeeping: CacheKeeping(settings: options.cacheKeeping, clock: options.clock))
        }
    }

    /// The conversation of a running GUI Agent, attached on first ask — by the
    /// round that finds its session, or by the view that draws it, whichever
    /// is first. The same conversation either way.
    public func of(_ agentId: String) async throws -> AgentConversation {
        guard let place = options.model.place(of: agentId) else {
            if options.model.hasAgent(agentId) {
                throw GuiAgentMissing("the Workspace this Agent belongs to is no longer open")
            }
            throw GuiAgentMissing("there is no Agent \(agentId)")
        }
        if place.agent.presentation != .gui {
            throw GuiAgentMissing("\(place.agent.displayName) is a terminal Agent, so it has no conversation")
        }
        return try await conversationOn(place.machine, agentId, place.agent.profile, place.workspace.root)
    }

    /// The session a GUI Agent's CLI named, for its terminal mode to resume.
    /// None while the CLI has not named one, which it does with its first
    /// turn: there is nothing to resume yet, and a terminal Agent starts afresh.
    public func session(_ agentId: String) async throws -> String? {
        await (try await of(agentId)).reading().transcript.session.sessionId
    }

    /// The earlier sessions of a GUI Agent's CLI, as its `/resume` offers
    /// them: its Workspace's, or every directory's.
    public func pastSessions(_ agentId: String, scope: SessionScope) async throws -> [PastSession] {
        let place = try placeOf(agentId)
        return try await listPastSessions(place.runtime, try Self.sessionProfile(place.agent.profile), root: place.workspace.root, scope: scope)
    }

    /// The last exchanges of one of them (`cwd` is where the listing said it ran).
    public func previewSession(_ agentId: String, session: String, cwd: String) async throws -> [PreviewLine] {
        let place = try placeOf(agentId)
        return try await previewPastSession(place.runtime, try Self.sessionProfile(place.agent.profile), id: session, cwd: cwd)
    }

    /// Have a GUI Agent go on with another session of its CLI (`/resume`):
    /// Claude's past is read from its file first, and a session that cannot
    /// be read back is refused before the running CLI is touched.
    public func resume(_ agentId: String, session: String) async throws {
        let conversation = try await of(agentId)
        let place = try placeOf(agentId)
        let history = place.agent.profile.kind == .claude
            ? try await claudeHistory(place.runtime, try Self.sessionProfile(place.agent.profile), root: place.workspace.root, session: session)
            : []
        try await conversation.resumeSession(session, history: history)
    }

    // MARK: - Files and settings the conversation view asks about

    /// Which of a conversation's path candidates are files on the Agent's
    /// machine (`resolvePathCandidates`), the others nil.
    public func resolvePaths(_ agentId: String, cwd: String?, _ paths: [String]) async throws -> [String?] {
        let place = try placeOf(agentId)
        return try await resolvePathCandidates(RuntimeHostMachine(place.runtime), cwd: cwd, paths)
    }

    /// The defaults of the Agent's CLI's new sessions (`cliDefaults` in
    /// appController.ts): Claude Code's settings, Codex's `config.toml`; nil
    /// for a CLI DevHub cannot read them for.
    public func cliDefaults(_ agentId: String, model: String?) async throws -> CliDefaults? {
        let place = try placeOf(agentId)
        let profile = place.agent.profile
        switch profile.kind {
        case .claude:
            return try await readClaudeDefaults(
                place.runtime, profile: ClaudeProfileFacts(env: profile.env, args: profile.args),
                root: place.workspace.root, model: model)
        case .codex:
            return try await readCodexDefaults(place.runtime, profile: try Self.sessionProfile(profile))
        default:
            return nil
        }
    }

    /// Change one in the CLI's user settings (`~/.claude/settings.json`,
    /// `~/.codex/config.toml`): a Claude Code effort is saved for `model`
    /// when it is named.
    public func setCliDefault(_ agentId: String, _ which: ClaudeDefaultName, value: String, model: String?) async throws {
        let place = try placeOf(agentId)
        let profile = place.agent.profile
        switch profile.kind {
        case .claude:
            try await writeClaudeDefault(
                place.runtime, profile: ClaudeProfileFacts(env: profile.env, args: profile.args), which, value,
                model: model)
        case .codex:
            try await writeCodexDefault(place.runtime, profile: try Self.sessionProfile(profile), which, value)
        default:
            throw GuiAgentMissing("Only a Claude Code or Codex Agent's defaults can be set from DevHub")
        }
    }

    // MARK: - MCP sign-in

    /// Sign in to one of a GUI Agent's MCP servers: the CLI's own `mcp login`
    /// run on the Agent's machine, shown in `Transcript.mcpSignIn` as it
    /// goes. Returns once it has started; once it has succeeded the server is
    /// reconnected. Refused while another runs, or for a server the panel does
    /// not offer a sign-in for.
    public func signIn(_ agentId: String, server: String) async throws {
        let conversation = try await of(agentId)
        let place = try placeOf(agentId)
        if let running = lock.withLock({ signIns[agentId] }), running.state.phase == .running {
            throw ConversationError.refused("The sign-in to \(running.server) is still running. Cancel it first.")
        }
        let listed = await conversation.reading().transcript.mcp.servers?.first { $0.name == server }
        guard let listed, listed.actions.contains(.signIn) else {
            throw ConversationError.refused(
                "\(place.agent.displayName) offers no sign-in to an MCP server named \(server) now.")
        }
        // Declared before it is made: the run shows itself as it starts, and
        // a run that is no longer the Agent's shows nothing.
        let made = Guarded<McpSignInRun?>(nil)
        let log = options.log
        let run = McpSignInRun(McpSignInPlan(
            machine: RuntimeSignInMachine(place.runtime), program: place.agent.profile.command,
            env: place.agent.profile.env, cwd: place.workspace.root, server: server,
            show: { [weak self] signIn in
                let mine = made.with { $0 }
                if let mine, self?.lock.withLock({ self?.signIns[agentId] }) !== mine { return }
                Task {
                    do {
                        try await conversation.showSignIn(signIn)
                    } catch {
                        log("[devhub] the sign-in to \(server) could not be shown: \(failureText(error))")
                    }
                }
            },
            // Signed in: the server is connected again with the new
            // credentials, and asked about afresh once it is.
            signedIn: { try await conversation.command(.mcp(.act(action: .reconnect, server: server))) }))
        made.with { $0 = run }
        lock.withLock { signIns[agentId] = run }
    }

    /// A line the person typed for the running sign-in's prompt.
    public func signInInput(_ agentId: String, text: String) throws {
        guard let run = lock.withLock({ signIns[agentId] }) else {
            throw ConversationError.refused("No MCP sign-in is running.")
        }
        try run.input(text)
    }

    /// Stop the running sign-in.
    public func cancelSignIn(_ agentId: String) {
        lock.withLock { signIns[agentId] }?.cancel()
    }

    /// Put away a sign-in that has ended.
    public func dismissSignIn(_ agentId: String) async throws {
        guard let run = lock.withLock({ signIns[agentId] }) else { return }
        if run.state.phase == .running {
            throw ConversationError.refused("The sign-in to \(run.server) is still running. Cancel it first.")
        }
        lock.withLock { signIns[agentId] = nil }
        try await (try await of(agentId)).showSignIn(nil)
    }

    // MARK: - GuiAgentControl

    /// The GUI branch of a launch: the session runs the CLI under the host,
    /// in structured mode, with the host's files in a directory made for it
    /// first. Everything else about the session — its markers, its tmux, its
    /// Stop — is the terminal's. A failure is a `failed` result, worded by
    /// `portRefusal`, so the row is retryable rather than pretending.
    public func launch(workspaceId: WorkspaceId, agentId: AgentId, profile: AgentProfile, root: String) async -> AgentLaunchResult {
        do {
            guard let machine = options.model.machine(of: workspaceId.rawValue) else {
                throw GuiAgentMissing("the Workspace this Agent belongs to is no longer open")
            }
            let terminal = ControllerModelMirror.terminalProfile(profile)
            let skill = await options.devhubSkill(machine)
            let args = DevhubSkill.arguments(kind: profile.kind.rawValue, args: profile.args, skill: skill)
            let runtime = try options.machineRuntime(machine)
            let directory = try await stateDirectory(machine, agentId.rawValue)
            try await runtime.makeDirectory(directory)
            // Claude prints nothing of a resumed session's past, so DevHub
            // reads it from the session's file and puts it first in the
            // journal; Codex answers `thread/resume` with it.
            let kind = try Self.cliKind(profile.kind)
            if kind == .claude, let resumed = resumedSession(kind, profile.args) {
                try await seedJournal(
                    RuntimeHostMachine(runtime), stateDirectory: directory,
                    lines: try await claudeHistory(runtime, try Self.sessionProfile(terminal), root: root, session: resumed))
            }
            let command = hostSessionCommand(stateDirectory: directory, cli: guiAgentCli(try Self.guiProfile(terminal, args: args)))
            try await options.sessions.launchGuiSession(AgentLaunchSpec(
                target: AgentTerminalTarget(machine: machine, agentId: agentId.rawValue, workspaceId: workspaceId.rawValue, root: root),
                command: AgentSessionCommand(file: command.file, args: command.args, env: command.env)))
            return .started
        } catch {
            let refusal = agentPortRefusal(error)
            return .failed(code: refusal.code, detail: refusal.detail ?? failureText(error))
        }
    }

    /// Start a GUI Agent's CLI again on its session: done once the new CLI is
    /// ready. The conversation's refusal or failure, and a host that could
    /// not start it again, are the person's news, thrown named; anything else
    /// is DevHub's own bug and is thrown as it is.
    public func restart(_ agentId: AgentId) async throws {
        do {
            try await (try await of(agentId.rawValue)).restart()
        } catch let failure as HostLinkFailure {
            throw NamedFailure(AppError.at(.conversationStopped).withDetail("DevHub could not start the CLI again: \(failure.message)"))
        } catch let failure as ConversationError {
            throw NamedFailure(errorWire(failure))
        }
    }

    /// The conversation as `devhub --tell` reaches into it.
    public func conversation(_ agentId: AgentId) async throws -> (any TellConversation)? {
        guard let agent = options.model.place(of: agentId.rawValue)?.agent, agent.presentation == .gui else { return nil }
        return ConversationForTell(try await of(agentId.rawValue))
    }

    // MARK: - GuiAgentRounds

    /// Once a round, and only here: the round is the clock.
    public func reading(machine: RuntimeId, agent: TerminalAgentRecord, root: String) async -> TerminalAgentReading {
        let conversation: AgentConversation
        do {
            conversation = try await conversationOn(machine, agent.id, agent.profile, root)
        } catch {
            // Only DevHub's own invariants fail here; read as this Agent's
            // failure, on its pane, rather than failing the machine's round.
            options.log("[devhub] the conversation of \(agent.id) could not be made: \(failureText(error))")
            return TerminalAgentReading(
                status: .error, activity: nil, failure: AgentRefusal(code: "conversation_failed", detail: failureText(error)))
        }
        await conversation.reattach()
        let observation = observeConversation(await conversation.reading())
        return TerminalAgentReading(
            status: TerminalAgentStatus(rawValue: observation.status.rawValue) ?? .unknown, activity: observation.activity,
            promptCache: observation.promptCache, failure: observation.failure)
    }

    public func send(agentId: String, text: String) async throws {
        guard let place = options.model.place(of: agentId) else { throw GuiAgentMissing("there is no running Agent \(agentId)") }
        try await conversationOn(place.machine, agentId, place.agent.profile, place.workspace.root)
            .command(.send(text: text, images: [], origin: .injection))
    }

    /// A GUI Agent is over: stop following it, say how it ended unless DevHub
    /// ended it (`byDevHub`), and take its host files away.
    ///
    /// Called once per ending, by whoever owns it: the stop, for an Agent
    /// DevHub stopped, and the round otherwise (`TerminalAgentWiring`). A
    /// second call would read an ending whose files the first already took.
    ///
    /// What is said goes app-wide, because the Agent's row is on its way out
    /// and there is nowhere else to say it. A failure to read the ending, or
    /// to remove the files, is said the same way and does not hold the exit
    /// up: the Agent is gone either way.
    public func ended(machine: RuntimeId, agent: TerminalAgentRecord, byDevHub: Bool) async {
        await registry.close(agent.id)
        let run = lock.withLock { signIns.removeValue(forKey: agent.id) }
        run?.cancel()
        let runtime: any MachineRuntime
        let directory: String
        do {
            runtime = try options.machineRuntime(machine)
            directory = try await stateDirectory(machine, agent.id)
        } catch {
            options.report("DevHub could not remove the files of “\(agent.displayName)”: \(failureText(error))")
            return
        }
        if !byDevHub {
            do {
                let ending = try await options.link(runtime, directory).ending()
                if let sentence = Self.endingSentence(name: agent.displayName, kind: agent.profile.kind.rawValue, ending: ending) {
                    options.report(sentence)
                }
            } catch let failure as HostLinkFailure {
                options.report("DevHub could not read how “\(agent.displayName)” ended: \(failure.message)")
            } catch {
                options.report("DevHub could not read how “\(agent.displayName)” ended: \(failureText(error))")
            }
        }
        do {
            try await runtime.removeTree(directory)
        } catch {
            options.report(
                "DevHub could not remove the files of “\(agent.displayName)” at \(directory)\(runtime.where): \(failureText(error))")
        }
    }

    /// How a GUI Agent's CLI ended, in a sentence — or nil, when it ended the
    /// way a conversation is meant to.
    public static func endingSentence(name: String, kind: String, ending: HostEnding) -> String? {
        func said(_ tail: String) -> String {
            let trimmed = tail.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? "" : ": \(trimmed)"
        }
        switch ending {
        case let .exited(code, tail):
            return code == 0 ? nil : "The \(kind) of “\(name)” exited with code \(code)\(said(tail))"
        case let .hostFailed(tail):
            return "The \(kind) of “\(name)” could not be started\(said(tail))"
        case let .vanished(tail):
            return "The session of “\(name)” was ended outside DevHub\(said(tail))"
        }
    }

    // MARK: - What the rest of the app hears

    /// The Sidebar's usage-limits readout, from what the GUI Agents report
    /// (`usageLimitsListener`): every conversation's `usage` event fed into
    /// `limits`. `kind` is the model's word on which CLI the Agent runs; a
    /// broken rule is logged. Returns the unsubscribe.
    public func feedUsageLimits(
        _ limits: UsageLimits, kind: @escaping @Sendable (String) -> AgentProfileKind?,
        publish: @escaping @Sendable (UsageLimitsWire) -> Void
    ) async -> @Sendable () -> Void {
        let log = options.log
        return await registry.onEvent { agentId, _, event in
            guard case let .usage(usage) = event else { return }
            do {
                try UsageLimitsFeed.agentReported(limits, kind: kind(agentId), rateLimits: usage.rateLimits, publish: publish)
            } catch {
                log("[devhub] \(failureText(error))")
            }
        }
    }

    /// `[agents] auto_compact_*` may have changed: every conversation judges
    /// itself again (`adoptConfig`).
    public func reconsiderCacheKeeping() async { await registry.reconsiderCacheKeeping() }
}

// MARK: - The conversation, as `devhub --tell` reaches into it

/// An `AgentConversation` as `TellConversation` (appController.ts
/// `tellPorts().conversation`): the transcript's entries and open requests
/// in the fields `agent read` reads, the turn, and the composer's own paths.
public struct ConversationForTell: TellConversation {
    public let conversation: AgentConversation

    public init(_ conversation: AgentConversation) { self.conversation = conversation }

    public func entries() async -> [TellTranscriptEntry] {
        await conversation.snapshot().transcript.entries.map(Self.entry)
    }

    public func requests() async -> [TellPendingRequest] {
        await conversation.snapshot().transcript.requests.map(Self.request)
    }

    public func turn() async -> String { Self.turn(await conversation.snapshot().transcript.state) }

    public func submit(_ text: String) async throws { try await conversation.submit(text, images: []) }

    public func interrupt() async throws { try await conversation.command(.interrupt) }

    public func answer(_ request: String, _ answer: TellRequestAnswer) async throws {
        try await conversation.command(.answer(request: RequestId(request), answer: Self.answer(answer)))
    }

    /// `ready` is its turn; otherwise the phase.
    static func turn(_ state: ConversationState) -> String {
        if let turn = state.turn { return turn.rawValue }
        return state.phase
    }

    static func entry(_ entry: TranscriptEntry) -> TellTranscriptEntry {
        switch entry {
        case let .user(user): return .user(id: user.id.raw, text: user.text)
        case let .answer(answer):
            return .answer(id: answer.id.raw, answers: answer.answers.map {
                TellQuestionAnswer(question: $0.question, chosen: $0.chosen, written: $0.written)
            })
        case let .command(command): return .command(id: command.id.raw, line: command.line, output: command.output)
        case let .assistant(assistant):
            return .assistant(id: assistant.id.raw, texts: assistant.blocks.compactMap {
                if case let .text(markdown) = $0 { return markdown }
                return nil
            })
        case let .tool(tool): return .tool(id: tool.id.raw, tool: tool.tool, title: tool.title, status: tool.status.rawValue)
        case let .notice(notice): return .notice(id: notice.id.raw, text: notice.text)
        case let .compaction(compaction): return .compaction(id: compaction.id.raw)
        case let .turnEnd(end): return .turnEnd(id: end.id.raw, outcome: end.outcome.rawValue, detail: end.detail)
        }
    }

    static func request(_ request: PendingRequest) -> TellPendingRequest {
        let subject: TellRequestSubject
        switch request.subject {
        case let .tool(tool, title, _, _): subject = .tool(tool: tool, title: title)
        case let .command(command, _, _): subject = .command(command: command)
        case let .fileChange(files): subject = .fileChange(paths: files.map(\.path))
        case let .question(questions):
            subject = .question(questions.map { question in
                TellQuestion(
                    id: question.id, header: question.header, text: question.text,
                    options: question.options.map { TellQuestionOption(label: $0.label, description: $0.description) },
                    multiSelect: question.multiSelect, allowsOther: question.allowsOther)
            })
        case let .elicitation(server, message, _, _): subject = .elicitation(server: server, message: message)
        }
        return TellPendingRequest(id: request.id.raw, subject: subject)
    }

    static func answer(_ answer: TellRequestAnswer) -> RequestAnswer {
        .answers(
            values: answer.values.map { value in
                switch value.value {
                case let .one(text): return (value.id, AnswerValue.one(text))
                case let .many(texts): return (value.id, AnswerValue.many(texts))
                }
            },
            notes: Dictionary(answer.notes.map { ($0.id, $0.note) }, uniquingKeysWith: { _, last in last }))
    }
}

// MARK: - The settings a GUI Agent's conversation reads

/// `[agents]` as the conversations read it, each time (`resumeAfterLimit`
/// and `cacheKeeping` in `startRuntimes`). Settings that could not be read
/// are no settings: nothing is resumed or compacted on DevHub's own say-so.
public enum GuiAgentSettings {
    public static func resumeAfterLimit(_ config: Config?) -> LimitResumeSettings {
        guard let agents = config?.agents else { return LimitResumeSettings(enabled: false, message: DEFAULT_RESUME_MESSAGE) }
        return LimitResumeSettings(enabled: agents.resumeAfterLimit, message: agents.resumeAfterLimitMessage)
    }

    public static func cacheKeeping(_ config: Config?) -> CacheKeepSettings {
        guard let agents = config?.agents else { return CACHE_KEEP_OFF }
        return CacheKeepSettings(
            enabled: agents.autoCompactBeforeCacheExpiry, leadSeconds: agents.autoCompactLeadSeconds,
            minTokens: agents.autoCompactMinTokens)
    }
}
