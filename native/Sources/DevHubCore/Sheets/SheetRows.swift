// The rows and the words of every sheet, ported from the sheets that draw them:
//
//   apps/desktop/src/shell/components/shell/WorkspacePicker.tsx  the fixed rows
//   apps/desktop/src/shell/components/shell/cloneDestination.ts  where a clone goes
//   apps/desktop/src/shell/components/shell/AgentProfilePicker.tsx  New Agent's rows
//   apps/desktop/src/shell/components/shell/sessionRows.tsx      an earlier session
//   apps/desktop/src/shell/picker/TabPickerSheet.tsx             Go to
//   apps/desktop/src/shell/picker/AgentActionsSheet.tsx          Send to agent
//   apps/desktop/src/shell/picker/CommandPaletteSheet.tsx        Commands
//   apps/desktop/src/shell/picker/WorktreeCloseSheet.tsx         a dirty worktree
//   apps/desktop/src/shell/picker/CloseConfirmationSheet.tsx     close / stop / restart / continue
//   apps/desktop/src/shell/picker/AgentRenameSheet.tsx           Rename Agent
//   apps/desktop/src/shell/picker/IssueAssignmentSheet.tsx       the Issue flow's rows
//
// Pure, so every sentence a sheet says is tested without a window; the App
// only draws what these return.

import Foundation

public enum SheetRows {
    // MARK: - The workspace picker

    public static let newProject = "devhub:new-project"
    public static let cloneProject = "devhub:clone-project"
    public static let otherFolder = "devhub:other-folder"

    /// The rows that are not workspaces. (SSH: Connect… is not offered: the
    /// native app opens local folders only.)
    public static let workspaceActions: [PickerItem] = [
        PickerItem(id: newProject, label: "New Project…", detail: "Create a folder and open it", glyph: .plus),
        PickerItem(id: cloneProject, label: "Clone Project…", detail: "Clone a Git repository and open it", glyph: .clone),
        PickerItem(id: otherFolder, label: "Other…", detail: "Choose a folder DevHub does not know about", glyph: .ellipsis),
    ]

    public static func workspacePicker(pool: WorkspacePickerPool, busy: Bool, sourceCount: Int?) -> PickerPrompt {
        PickerPrompt(
            title: "Open Workspace",
            question: "Which workspace should this window open? Type to search the folders your sources cover.",
            step: 1, items: pool.items, pinned: workspaceActions, busy: busy,
            emptyNoMatch: "No workspaces match.",
            // Two different things to say, and an empty list cannot tell them apart.
            emptyNoItems: sourceCount == 0
                ? "No workspace sources yet. Add one in Settings to search your folders — or make a project with the rows below."
                : "No workspaces found in the configured sources.",
            note: "⌘↵ Open with an agent")
    }

    // MARK: - Projects (ProjectSheets.tsx) and where a clone goes

    public static let createTyped = "devhub:create-typed"
    public static let cloneTypedSpec = "devhub:clone-typed-spec"
    public static let cloneIntoTyped = "devhub:clone-into-typed"

    /// New Project's starting value: where projects go, with whatever was
    /// already typed as the name of this one.
    public static func newProjectStart(defaultDirectory: String, typed: String) -> String {
        typed.isEmpty ? "\(defaultDirectory)/" : Projects.joinPath(defaultDirectory, typed)
    }

    public static func newProject(start: String?, step: Int?, failure: String?) -> PickerPrompt {
        PickerPrompt(
            title: "New Project", question: "The folder is created and opened as a workspace.", step: step,
            initialQuery: start ?? "",
            pinned: [PickerItem(id: createTyped, label: "Create and open this folder", needsQuery: true)], busy: start == nil
        ).failing(failure)
    }

    /// Clone Project's first question; the row's second line says which
    /// repository the typing was read as, as it is typed.
    public static func cloneRepository(typed: String, draft: String, login: GitHubLogin, step: Int?, failure: String?) -> PickerPrompt {
        let previewed = Projects.cloneTarget(draft, login: login)
        var pinned: [PickerItem] = []
        var note: String?
        switch previewed {
        case let .clone(url, name):
            pinned = [PickerItem(id: cloneTypedSpec, label: "Clone it", detail: "Clones \(url) as \(name)", needsQuery: true)]
        case let .unreadable(reason):
            note = reason
        }
        var prompt = PickerPrompt(
            title: "Clone Project", question: "The repository is cloned and then opened as a workspace.", step: step,
            placeholder: "owner/repo", initialQuery: typed, pinned: pinned, note: note)
        if let failure { prompt = prompt.failing(failure) }
        return prompt
    }

    /// Clone Project's second question: which folder.
    public static func cloneDestination(name: String?, parents: [String]?, step: Int?, failure: String?) -> PickerPrompt {
        PickerPrompt(
            title: "Clone \(name ?? "repository")", question: "Choose the folder \(name ?? "it") is cloned into.",
            step: step.map { $0 + 1 }, items: cloneParentItems(parents ?? [], repositoryName: name),
            pinned: [cloneTypedItem(repositoryName: name)], busy: parents == nil,
            emptyNoMatch: "No folder matches. Type one instead.",
            emptyNoItems: "Type the folder the clone should go into."
        ).failing(failure)
    }

    /// The parents, as rows: each says where *this* clone would land.
    public static func cloneParentItems(_ parents: [String], repositoryName: String?) -> [PickerItem] {
        parents.map { parent in
            PickerItem(
                id: parent, label: parent,
                detail: repositoryName.map { "Lands as \(Projects.joinPath(parent, $0))" } ?? "Clone into this folder",
                searchText: parent)
        }
    }

    /// The row that means "the folder I just typed".
    public static func cloneTypedItem(repositoryName: String?) -> PickerItem {
        PickerItem(
            id: cloneIntoTyped, label: "Clone into the folder typed above",
            detail: repositoryName.map { "The clone lands in it as \($0)" } ?? "Uses exactly what is in the field",
            needsQuery: true)
    }

    // MARK: - New Agent (AgentProfilePicker.tsx)

    public static let openEditorRow = "devhub:open-editor"
    public static let readingRow = "devhub:sessions-reading"

    /// One profile's listing of earlier sessions in the folder.
    public enum Listing: Equatable, Sendable {
        case reading
        case listed([PastSession])
        case failed(String)
    }

    /// What a row stands for.
    public struct AgentTarget: Equatable, Sendable {
        public var profile: SheetProfile
        public var session: PastSession?
    }

    public struct AgentRows: Equatable, Sendable {
        public var items: [PickerItem]
        public var targets: [String: AgentTarget]
        public var sessionCount: Int
        /// A listing that failed, per profile, in profile order.
        public var refusals: [String]

        public init(items: [PickerItem], targets: [String: AgentTarget], sessionCount: Int, refusals: [String]) {
            self.items = items
            self.targets = targets
            self.sessionCount = sessionCount
            self.refusals = refusals
        }
    }

    /// The kinds whose CLI keeps sessions DevHub can list and resume.
    public static func lists(_ kind: AgentProfileKind) -> Bool { kind == .claude || kind == .codex }

    /// `New <Profile> Session` per profile, "Just open the editor" when offered,
    /// then every profile's earlier sessions newest first (each once), and a
    /// quiet last row while any listing is still being read.
    public static func agentRows(
        _ profiles: [SheetProfile], listings: [String: Listing], openEditor: Bool, now: Double
    ) -> AgentRows {
        var targets: [String: AgentTarget] = [:]
        var items: [PickerItem] = profiles.map { profile in
            let id = "new:\(profile.id)"
            targets[id] = AgentTarget(profile: profile, session: nil)
            let kind = kindLabel(profile.kind)
            return PickerItem(
                id: id, label: "New \(profile.displayName) Session",
                detail: kind == profile.displayName ? nil : .text(kind),
                searchText: "new \(profile.displayName) \(profile.kind.rawValue)", glyph: .agent,
                accessory: presentationAccessory(profile))
        }
        if openEditor {
            items.append(PickerItem(
                id: openEditorRow, label: "Just open the editor", detail: "No agent is started",
                searchText: "editor open no agent without just"))
        }
        var offered = Set<String>()
        var past: [(item: PickerItem, at: Double, index: Int)] = []
        var reading = false
        var refusals: [String] = []
        for profile in profiles {
            switch listings[profile.id] {
            case .reading?: reading = true
            case let .failed(reason)?: refusals.append(reason)
            case let .listed(sessions)?:
                for session in sessions {
                    let same = "\(profile.kind.rawValue)\u{0}\(session.id)"
                    if offered.contains(same) { continue }
                    offered.insert(same)
                    let id = "session:\(profile.id):\(session.id)"
                    targets[id] = AgentTarget(profile: profile, session: session)
                    past.append((
                        PickerItem(
                            id: id, label: "\(profile.displayName) Session: \(session.title)",
                            detail: sessionDetail(session, now: now, where: false).map(PickerDetail.text),
                            searchText: "\(profile.displayName) \(session.branch ?? "") \(session.title)", glyph: .session,
                            accessory: presentationAccessory(profile)),
                        session.updatedAt ?? -Double.infinity, past.count))
                }
            case nil: break
            }
        }
        past.sort { $0.at == $1.at ? $0.index < $1.index : $0.at > $1.at }
        items += past.map(\.item)
        if reading {
            items.append(PickerItem(id: readingRow, label: "Earlier sessions", searchText: "", unavailable: "Reading…"))
        }
        return AgentRows(items: items, targets: targets, sessionCount: past.count, refusals: refusals)
    }

    /// A profile row's right end: `TUI` or `GUI`, whichever Return launches.
    public static func presentationAccessory(_ profile: SheetProfile) -> PickerAccessory {
        .text(
            normal: presentationLabel(profile.launchPresentation(alternate: false)),
            alternate: presentationLabel(profile.launchPresentation(alternate: true)))
    }

    public static func presentationLabel(_ presentation: AgentPresentation) -> String {
        presentation == .tui ? "TUI" : "GUI"
    }

    /// The one line under a profile's row: whose screen it draws.
    public static func kindLabel(_ kind: AgentProfileKind) -> String {
        switch kind {
        case .codex: return "Codex"
        case .claude: return "Claude"
        case .cursor: return "Cursor — busy and waiting only"
        case .custom: return "Other — no status detection"
        }
    }

    public static let folderAgentHint =
        "The agent starts in this folder. ⌥Return opens it beside the editor; ⌘Return opens it as the other of TUI and GUI."
    public static let openingAgentHint =
        "The agent starts at the workspace root, once it is open. ⌘Return opens it as the other of TUI and GUI."

    /// New Agent's question, wherever it is asked.
    public static func agentPicker(
        title: String, question: String, step: Int?, hint: String, failure: String?, rows: AgentRows,
        availability: SheetProfiles.Availability
    ) -> PickerPrompt {
        let refusal = rows.refusals.isEmpty ? nil : rows.refusals.joined(separator: "\n")
        let note = availability == .degraded
            ? "The configuration needs attention; these are the last profiles DevHub could confirm." : hint
        let failing = failure ?? refusal
        return PickerPrompt(
            title: title, question: question, step: step, items: rows.items,
            emptyNoMatch: "No agent profile or earlier session matches.",
            emptyNoItems: availability == .unavailable
                ? "Agent profiles are unavailable until the configuration is readable again."
                : "No agent profiles are enabled.",
            note: failing.map { "\($0)\n\(note)" } ?? note, noteIsFailure: failing != nil)
    }

    public static let folderAgentQuestion = "Start a new session, or go on with one of this folder's earlier ones."

    // MARK: - An earlier session (sessionRows.tsx)

    /// A session row's second line: when it last changed, the branch, and
    /// where it ran for a list that spans directories.
    public static func sessionDetail(_ session: PastSession, now: Double, where: Bool) -> String? {
        let parts = [
            session.updatedAt.map { relativeTime($0, now: now) }, session.branch, `where` ? session.cwd : nil,
        ].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// "3 hours ago", "yesterday", "just now" (`Intl.RelativeTimeFormat("en",
    /// { numeric: "auto" })`).
    public static func relativeTime(_ at: Double, now: Double) -> String {
        let units: [(String, Double)] = [
            ("year", 365 * 24 * 3_600_000), ("month", 30 * 24 * 3_600_000), ("week", 7 * 24 * 3_600_000),
            ("day", 24 * 3_600_000), ("hour", 3_600_000), ("minute", 60_000),
        ]
        let elapsed = now - at
        for (unit, length) in units where abs(elapsed) >= length {
            let value = -Int((elapsed / length).rounded(.toNearestOrAwayFromZero))
            return format(value, unit)
        }
        return "just now"
    }

    private static func format(_ value: Int, _ unit: String) -> String {
        switch (value, unit) {
        case (-1, "day"): return "yesterday"
        case (1, "day"): return "tomorrow"
        case (-1, "week"), (-1, "month"), (-1, "year"): return "last \(unit)"
        case (1, "week"), (1, "month"), (1, "year"): return "next \(unit)"
        case (0, "day"): return "today"
        case (0, _): return "this \(unit)"
        default:
            let count = abs(value)
            let noun = count == 1 ? unit : "\(unit)s"
            return value < 0 ? "\(count) \(noun) ago" : "in \(count) \(noun)"
        }
    }

    /// The preview beside the list.
    public enum Preview: Equatable, Sendable {
        case reading
        case read([PreviewLine])
        case failed(String)
    }

    /// Why a session cannot be previewed when its CLI did not say where it ran.
    public static func previewWithoutDirectory(_ cli: String) -> String {
        "\(cli) does not say where this session ran, so it cannot be previewed."
    }

    public static let previewInvite = "Point at a session to see how it ended."
    public static let previewEmpty = "Nothing was said in this session's last part."

    // MARK: - /resume (SessionPicker.tsx)

    public static func sessionPicker(
        title: String, question: String, cli: String, scope: SessionScope, sessions: [PastSession]?, refusal: String?,
        now: Double
    ) -> PickerPrompt {
        let items = (sessions ?? []).map { session in
            PickerItem(
                id: session.id, label: session.title,
                detail: sessionDetail(session, now: now, where: scope == .everywhere).map(PickerDetail.text),
                searchText: "\(session.title) \(session.branch ?? "") \(session.cwd ?? "")", glyph: .session,
                unavailable: session.resumableHere ? nil : "\(cli) goes on with it only in \(session.cwd ?? "the directory it ran in").")
        }
        return PickerPrompt(
            title: title, question: question, items: items, busy: sessions == nil,
            emptyNoMatch: "No earlier session matches.",
            emptyNoItems: refusal != nil
                ? "The sessions could not be listed."
                : scope == .here ? "This workspace has no earlier \(cli) sessions." : "There are no earlier \(cli) sessions on this machine.",
            note: refusal, noteIsFailure: refusal != nil)
    }

    // MARK: - Go to (TabPickerSheet.tsx)

    public static func tabPicker(_ snapshot: AppSnapshotWire?) -> PickerPrompt {
        var items: [PickerItem] = []
        for workspace in (try? snapshot?.orderedWorkspaces()) ?? [] {
            items.append(PickerItem(
                id: "workspace:\(workspace.id)", label: workspace.label, detail: .path(workspace.selectedPath),
                searchText: "\(workspace.label) \(workspace.root)", glyph: .workspace))
            for agent in workspace.agents {
                items.append(PickerItem(
                    id: "agent:\(agent.id)", label: agent.displayName,
                    detail: .text(agent.activity.map { "\(workspace.label) — \($0)" } ?? workspace.label),
                    searchText: "\(agent.displayName) \(workspace.label)", glyph: .agent))
            }
        }
        return PickerPrompt(
            title: "Go to", question: "Which workspace or agent do you want to look at?", items: items,
            emptyNoMatch: "Nothing here matches that.", note: "⌥Return opens an agent beside its editor.")
    }

    /// Where a Go to row goes.
    public static func tabTarget(_ choice: PickerChoice) -> AppIntentWire? {
        if choice.id.hasPrefix("agent:") {
            return .selectContext(.agent(String(choice.id.dropFirst("agent:".count))), split: choice.split)
        }
        if choice.id.hasPrefix("workspace:") {
            return .selectContext(.workspace(String(choice.id.dropFirst("workspace:".count))))
        }
        return nil
    }

    // MARK: - Send to agent (AgentActionsSheet.tsx)

    public static func agentActions(_ actions: [ConfiguredAgentAction]?, agentName: String?) -> PickerPrompt {
        PickerPrompt(
            title: "Send to agent",
            question: agentName.map { "Which action should \($0) be sent?" } ?? "Which action should this agent be sent?",
            items: (actions ?? []).map { action in
                PickerItem(
                    id: action.id, label: action.displayName, detail: action.trigger.displayName,
                    searchText: "\(action.displayName) \(action.trigger.displayName)", glyph: .action)
            },
            busy: actions == nil, emptyNoMatch: "No configured action matches that.",
            emptyNoItems: "There are no agent actions configured. Settings ▸ Actions is where they are written.")
    }

    /// The actions in the Settings tree's order: by trigger, then each
    /// trigger's own order.
    public static func actionsInTreeOrder(_ actions: [ConfiguredAgentAction]) -> [ConfiguredAgentAction] {
        AgentActionTrigger.ordered.flatMap { trigger in actions.filter { $0.trigger == trigger } }
    }

    // MARK: - Commands (CommandPaletteSheet.tsx)

    public static func commandPalette(_ rows: [CommandPaletteRow]) -> PickerPrompt {
        PickerPrompt(
            title: "Commands", question: "Which DevHub command do you want to run?",
            items: rows.enumerated().map { index, row in
                PickerItem(
                    id: String(index), label: row.title, detail: row.recent ? .text("recently used") : nil,
                    searchText: CommandPalette.searchText(title: row.title, commandId: row.commandId.rawValue), glyph: .command,
                    accessory: row.chords.isEmpty ? nil : .keys(row.chords))
            },
            emptyNoMatch: "No command matches that.", emptyNoItems: "Nothing can be run here.")
    }

    // MARK: - A dirty worktree (WorktreeCloseSheet.tsx)

    public static func worktreeClose(label: String, root: String, branch: String?, dirty: Bool?) -> PickerPrompt {
        PickerPrompt(
            title: "Close \(label)",
            question: dirty == true
                ? "\(label) is a worktree with uncommitted changes in it. What should happen to the folder?"
                : "\(label) is a worktree, and DevHub could not tell whether there is anything uncommitted in it. What should happen to the folder?",
            items: [
                PickerItem(id: "close", label: "Just close the workspace", detail: "Keep \(root) on disk."),
                PickerItem(
                    id: "delete", label: "Delete the worktree",
                    detail: branch.map { "Remove \(root) and everything uncommitted on \($0)." }
                        ?? "Remove \(root) and everything uncommitted in it."),
            ],
            cancelRow: PickerCancelRow(detail: "Leave the workspace open."))
    }

    // MARK: - Close, stop, restart, continue (CloseConfirmationSheet.tsx)

    public static let confirmRow = "devhub:confirm"
    public static let moveTerminalRow = "devhub:move-terminal"

    static func diagnosticStatus(_ diagnostic: DiagnosticCode) -> String {
        switch diagnostic {
        case .rootMissing: return "Could not verify: workspace root is missing"
        case .rootInaccessible: return "Could not verify: workspace root is inaccessible"
        case .closeAgentsUnknown: return "Could not verify agents"
        case .closeTerminalUnknown: return "Could not verify terminal state"
        case .closeEditorUnknown: return "Could not verify editor state"
        case .closeEditorStarting: return "Could not verify: the editor is still starting"
        case .closeEditorUnresponsive: return "Could not verify: the editor is not answering"
        case .closeEditorVetoed: return "The editor has unsaved changes"
        case .cleanupFailed: return "Could not verify cleanup state"
        case .runtimeUnavailable: return "Could not verify: runtime unavailable"
        case .editorRestartExhausted: return "Could not verify: the editor kept stopping"
        case .editorUnavailable: return "Could not verify: the editor could not be started"
        }
    }

    /// The status a row shows, with the reason in it when there is one.
    static func closeResourceText(_ resource: ResourceInspection) -> String? {
        switch resource {
        case .clean: return nil
        case let .busy(count): return "\(count) busy"
        case let .unknown(diagnostic, reason):
            let status = diagnosticStatus(diagnostic)
            return reason.map { "\(status) — \($0)" } ?? status
        }
    }

    /// How many tab names the sheet spells out before it says how many more.
    static let unsavedTabsShown = 5

    static func unsavedEditorsText(_ unsaved: UnsavedEditorsInspection) -> String? {
        switch unsaved {
        case .clean: return nil
        case let .unsaved(tabs):
            let shown = tabs.prefix(unsavedTabsShown).joined(separator: ", ")
            let more = tabs.count - unsavedTabsShown
            return more > 0 ? "\(shown), and \(more) more" : shown
        case let .unknown(diagnostic, reason):
            let status = "Could not read whether there are unsaved files: \(diagnosticStatus(diagnostic))"
            return reason.map { "\(status) — \($0)" } ?? status
        }
    }

    /// Neighbouring rows whose status is word-for-word the same are one fact.
    static func collapsed(_ rows: [PickerFact]) -> [PickerFact] {
        var joined: [PickerFact] = []
        for row in rows {
            if let last = joined.last, last.value == row.value {
                joined[joined.count - 1] = PickerFact("\(last.label), \(row.label)", row.value)
            } else {
                joined.append(row)
            }
        }
        return joined
    }

    /// What the question is about, under the list.
    public static func closeDiagnostics(_ purpose: ConfirmationOutcomePurpose) -> [PickerFact] {
        guard case let .workspaceClose(inspection, worktree) = purpose else { return [] }
        var rows: [PickerFact] = []
        for (label, resource) in [
            ("Agents", inspection.agents), ("Terminal processes", inspection.terminalProcesses),
            ("Terminal panes", inspection.terminalPanes), ("Terminal windows", inspection.terminalWindows),
        ] {
            if let text = closeResourceText(resource) { rows.append(PickerFact(label, text)) }
        }
        if let unsaved = unsavedEditorsText(inspection.unsavedEditors) { rows.append(PickerFact("Unsaved files", unsaved)) }
        if worktree != .keep { rows.append(PickerFact("Worktree", "The folder is removed from disk")) }
        return collapsed(rows)
    }

    /// Everything the sheet says, for one purpose.
    public struct ConfirmationWords: Equatable, Sendable {
        public var title: String
        public var question: String
        public var cancel: String
        public var confirm: String
        public var confirmDetail: String
    }

    public static func confirmationWords(_ purpose: ConfirmationOutcomePurpose, agentName: String?) -> ConfirmationWords {
        switch purpose {
        case let .workspaceClose(inspection, _):
            let unsaved = unsavedEditorsText(inspection.unsavedEditors)
            return ConfirmationWords(
                title: "Close “\(inspection.workspaceLabel)”?",
                question: "The workspace has resources open. Closing it will close them.",
                cancel: "Leave the workspace open.", confirm: "Close the workspace",
                confirmDetail: unsaved == nil
                    ? "Everything listed below is closed with it."
                    : "Everything listed below is closed with it. Unsaved changes are discarded.")
        case let .agentStop(_, terminal):
            return ConfirmationWords(
                title: agentName.map { "Stop “\($0)”?" } ?? "Stop this Agent?",
                question: terminal
                    ? "Its terminal is still open. Move it to the editor, or close it with the Agent?"
                    : "This stops the Agent runtime. You can retry if cleanup fails.",
                cancel: "Leave the Agent running.", confirm: "Stop the Agent",
                confirmDetail: "The runtime stops. You can retry if cleanup fails.")
        case let .agentContinue(_, presentation):
            let place = presentation == .tui ? "in a terminal" : "in the GUI"
            return ConfirmationWords(
                title: agentName.map { "Continue “\($0)” \(place)?" } ?? "Continue this Agent \(place)?",
                question: "It is not idle. Its CLI is stopped and the session resumed in a new Agent: the turn it is in, a question it is waiting on, and any subagents or background tasks it started stop with it.",
                cancel: "Leave the Agent running.",
                confirm: presentation == .tui ? "Continue in terminal" : "Continue in GUI",
                confirmDetail: "A new Agent resumes the session \(place), and this one is stopped once it runs.")
        case .agentRestart:
            return ConfirmationWords(
                title: agentName.map { "Restart the session of “\($0)”?" } ?? "Restart this Agent's session?",
                question: "It is not idle. Its CLI is stopped and started again on the same session: the turn it is in, a question it is waiting on, and any subagents or background tasks it started stop with it.",
                cancel: "Leave the Agent running.", confirm: "Restart Session",
                confirmDetail: "The conversation stays, and the CLI connects again to its MCP servers and reads its configuration afresh.")
        }
    }

    /// The agent a confirmation is about, if any.
    public static func agentId(of purpose: ConfirmationOutcomePurpose) -> String? {
        switch purpose {
        case .workspaceClose: return nil
        case let .agentStop(id, _), let .agentContinue(id, _), let .agentRestart(id): return id.rawValue
        }
    }

    public static func closeConfirmation(_ purpose: ConfirmationOutcomePurpose, agentName: String?) -> PickerPrompt {
        let words = confirmationWords(purpose, agentName: agentName)
        let terminal: Bool = { if case let .agentStop(_, terminal) = purpose { return terminal } else { return false } }()
        var items: [PickerItem] = []
        if terminal {
            items.append(PickerItem(
                id: moveTerminalRow, label: "Move the terminal to the editor",
                detail: "Its windows become windows of the workspace's editor terminal, still running; then the Agent stops."))
        }
        items.append(PickerItem(
            id: confirmRow, label: terminal ? "Stop, and close the terminal" : words.confirm,
            detail: terminal ? "The Agent stops, and its terminal closes with what runs in it." : words.confirmDetail))
        return PickerPrompt(
            title: words.title, question: words.question, items: items, details: closeDiagnostics(purpose),
            cancelRow: PickerCancelRow(detail: words.cancel))
    }

    // MARK: - Rename Agent (AgentRenameSheet.tsx)

    public static let renameToTyped = "devhub:rename-to-typed"

    public static func rename(current: String, failure: String?) -> PickerPrompt {
        PickerPrompt(
            title: "Rename Agent", question: "The name is how this agent appears in the sidebar.", initialQuery: current,
            pinned: [PickerItem(id: renameToTyped, label: "Rename it", needsQuery: true)]
        ).failing(failure)
    }

    /// The name a rename answer gives, or why it gives none.
    public static func renamed(_ typed: String) -> Result<String, UserFacingFailure> {
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? .failure(UserFacingFailure("A name cannot be only spaces.")) : .success(trimmed)
    }

    // MARK: - The review sheet (InjectionReviewSheet.tsx)

    /// Why a reviewed message cannot go, when its Agent is not there to take it.
    public static func injectionGone(_ agent: AgentWire?, known: Bool) -> String? {
        guard known else { return nil }
        guard let agent else { return "That agent has ended, so this message cannot be sent." }
        return agent.controlState == .running ? nil : "That agent is no longer running, so this message cannot be sent."
    }

    /// The footer's line while it can still go.
    public static func injectionStatus(_ agent: AgentWire?) -> String {
        if let agent, agent.status.atPrompt {
            return "The agent is ready. It will be sent as soon as you confirm."
        }
        return "It is sent once you confirm and the agent's prompt is free."
    }
}
