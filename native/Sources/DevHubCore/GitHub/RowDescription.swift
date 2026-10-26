// Port of the pure parts of
// apps/desktop/src/shell/components/sidebar/rowDescription.ts (with
// `statusLabel` from status.ts and `unreadShows` from StatusMark.tsx), and of
// `TooltipLineWire` from apps/desktop/src/ipc/contract.ts.
//
// What a row knows, as a list of facts — for everyone who is not reading the
// row itself.
//
// There are two such readers and they want the same facts in different forms.
// A screen reader is given the row's accessible name and needs the words: it
// cannot see a mark, so *branch* has to be said. The pointer is given the
// tooltip and needs the opposite: it can see the mark, and a tooltip that read
// "widget workspace, path /projects/widget, branch main" spent three quarters
// of its ink on label words naming the categories of facts a person had
// already recognised.
//
// So there is one list of facts and two renderings of it. `describe` turns the
// list into the sentence a reader hears; `tooltipLines` turns the same list
// into the lines the tooltip draws, each behind the same mark the row would
// have drawn. Neither is composed twice.
//
// The composition rule is the row's own facts, in the order a person asks for
// them: what it is, where it is, what it is a checkout of, what it is on, what
// it is for, how it is going out, and which machine it is all happening on.

import Foundation

/// A mark, by name (`GlyphName`). Never a drawing: the App maps it to the
/// Sidebar's own drawings, so the tooltip and the row share one set of marks.
public enum RowGlyph: String, Sendable, Equatable, Codable {
    case folder, terminal, plus, close, trash, repository, worktree, remote, container
    case issueOpen, issueClosed
    case pullRequest, pullRequestDraft, pullRequestClosed, pullRequestMerged
    case conversation
    case checksPassing, checksFailing, checksPending
    case openIssue
    case statusWorking, statusBackground, statusWaiting, statusIdle, statusError, statusUnknown, statusUnread
    case branch
}

/// How a fact is set: the name of the thing, anything that qualifies it, the
/// stronger dim ink for a reason something is not happening, a failure.
public enum RowFactStyle: String, Sendable, Equatable, Codable {
    case name, muted, note, danger
}

/// One fact, as a tooltip draws it (`TooltipFactLineWire`).
public struct TooltipFact: Equatable, Sendable {
    public var icon: RowGlyph?
    public var text: String
    public var style: RowFactStyle?
    /// The status colour this line takes, when it is about an Agent's status.
    public var tone: ConversationAgentStatus?
    /// Where this fact leads, when the fact is a place.
    public var href: String?

    public init(icon: RowGlyph? = nil, text: String, style: RowFactStyle? = nil, tone: ConversationAgentStatus? = nil, href: String? = nil) {
        self.icon = icon
        self.text = text
        self.style = style
        self.tone = tone
        self.href = href
    }
}

/// A measure drawn as a bar (`TooltipMeterLineWire`).
public struct TooltipMeter: Equatable, Sendable {
    /// What is measured, in words: "5-hour", "7-day", "primary".
    public var label: String
    /// 0–100; absent when the CLI did not say.
    public var usedPercent: Double?
    /// When the measure starts again from zero, epoch milliseconds.
    public var resetsAt: Double?

    public init(label: String, usedPercent: Double? = nil, resetsAt: Double? = nil) {
        self.label = label
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
    }
}

/// A line of a tooltip: a fact in words, or a measure drawn as a bar.
public enum TooltipLine: Equatable, Sendable {
    case fact(TooltipFact)
    case meter(TooltipMeter)
}

/// One fact a row knows.
public struct RowFact: Equatable, Sendable {
    /// The mark this fact is drawn behind, by name.
    public var icon: RowGlyph?
    /// The fact itself, in the words the row would draw.
    public var text: String
    /// What a reader is told instead, where the mark carries what the words
    /// would have been. Absent when the fact already says itself.
    public var spoken: String?
    public var style: RowFactStyle?
    public var tone: ConversationAgentStatus?
    /// The page this fact names — the row's own URL and never a second one.
    public var href: String?

    public init(icon: RowGlyph? = nil, text: String, spoken: String? = nil, style: RowFactStyle? = nil, tone: ConversationAgentStatus? = nil, href: String? = nil) {
        self.icon = icon
        self.text = text
        self.spoken = spoken
        self.style = style
        self.tone = tone
        self.href = href
    }
}

/// Where a Workspace's editor is (`EditorAttachmentWire`, ipc/appShell.ts).
public enum EditorAttachmentWire: Equatable, Sendable {
    case host
    case devContainer(label: String?)
}

/// What a Workspace's own terminals are doing, when there is anything to say.
public enum WorkspaceTerminalsFact: Equatable, Sendable {
    case working
    case finished
}

/// What a Workspace row needs that is not the repository's
/// (`WorkspaceSnapshot`'s part of `workspaceRowFacts`).
public struct WorkspaceRowInput: Equatable, Sendable {
    public var label: String
    /// The folder, written the way the person whose folder it is writes it.
    public var displayRoot: String
    /// A close that stopped, already in words (`closeFailureLabel`).
    public var closeFailure: String?
    public var terminals: WorkspaceTerminalsFact?
    /// The host, for a Workspace on another machine.
    public var sshHost: String?
    public var editor: EditorAttachmentWire

    public init(label: String, displayRoot: String, closeFailure: String? = nil, terminals: WorkspaceTerminalsFact? = nil, sshHost: String? = nil, editor: EditorAttachmentWire = .host) {
        self.label = label
        self.displayRoot = displayRoot
        self.closeFailure = closeFailure
        self.terminals = terminals
        self.sshHost = sshHost
        self.editor = editor
    }
}

/// How an Agent's runtime is doing (`AgentSnapshot.runtimeHealth`).
public enum AgentRuntimeHealth: String, Sendable, Equatable {
    case starting, degraded, unavailable, failed, healthy
}

/// What an Agent row needs (`AgentSnapshot`'s part of `agentRowFacts`).
public struct AgentRowInput: Equatable, Sendable {
    public var displayName: String
    public var status: ConversationAgentStatus
    /// The status it left when it became unread, while it is unread.
    public var unread: ConversationAgentStatus?
    /// What it says it is doing, in its own words.
    public var activity: String?
    /// Why it may not be doing what its status says (`agentNote`).
    public var note: String?

    public init(displayName: String, status: ConversationAgentStatus, unread: ConversationAgentStatus? = nil, activity: String? = nil, note: String? = nil) {
        self.displayName = displayName
        self.status = status
        self.unread = unread
        self.activity = activity
        self.note = note
    }
}

public enum RowDescription {
    /// The sentence a screen reader is given: one fact per line, in words.
    public static func describe(_ facts: [RowFact]) -> String {
        facts.map { $0.spoken ?? $0.text }.joined(separator: "\n")
    }

    /// The same facts, as the tooltip draws them.
    public static func tooltipLines(_ facts: [RowFact]) -> [TooltipLine] {
        facts.map { .fact(TooltipFact(icon: $0.icon, text: $0.text, style: $0.style, tone: $0.tone, href: $0.href)) }
    }

    /// The same facts, as a mark's own hover: each behind its mark, and
    /// nothing else.
    public static func markLines(_ facts: [RowFact]) -> [TooltipLine] {
        facts.map { .fact(TooltipFact(icon: $0.icon, text: $0.text)) }
    }

    /// Which silhouette a Workspace wears: a folder, or a folder somewhere
    /// else — the one distinction the column keeps.
    public static func workspaceGlyph(remote: Bool) -> RowGlyph { remote ? .remote : .folder }

    /// How a Workspace row introduces itself: its mark, and whether it can be
    /// closed or moved. Scratch wears the terminal and is neither closed nor
    /// dragged.
    public static func rowIdentity(workspaceId: String, scratchWorkspaceId: String, remote: Bool) -> (glyph: RowGlyph, fixed: Bool) {
        workspaceId == scratchWorkspaceId ? (.terminal, true) : (workspaceGlyph(remote: remote), false)
    }

    /// The quiet line that says a row's editor is in a dev container, or
    /// nothing when it is on the Workspace's own machine.
    public static func editorAttachmentFact(_ editor: EditorAttachmentWire) -> (text: String, spoken: String)? {
        switch editor {
        case .host: return nil
        case .devContainer(let label?):
            return ("editor in dev container: \(label)", "editor in the \(label) dev container")
        case .devContainer(nil):
            return ("editor in dev container", "editor in its dev container")
        }
    }

    /// The mark that links to GitHub: the repository's, whichever checkout.
    public static func repositoryGlyph() -> RowGlyph { .repository }

    /// The Issue, as the row draws it.
    public static func issueMark(_ issue: IssueStatus) -> String { "#\(issue.number) \(issue.title)" }

    /// The Issue, in full, for a reader who cannot see the mark beside it.
    public static func issueLabel(_ issue: IssueStatus) -> String { "Issue #\(issue.number), \(issue.state.rawValue): \(issue.title)" }

    /// Which repository the Issue is in, as `owner/name`: the one the
    /// workspace numbers its Issues in when known, else what the Issue's own
    /// URL names. `nil` when neither says.
    public static func issueRepositoryName(_ repository: WorkspaceRepositoryWire?, _ issue: IssueStatus) -> String? {
        if let named = repository?.issueRepository { return "\(named.owner)/\(named.repository)" }
        guard let match = TextPattern("^https://github\\.com/([^/]+)/([^/]+)/issues/").firstMatch(in: issue.url),
              let owner = match[1], let name = match[2]
        else { return nil }
        return "\(owner)/\(name)"
    }

    /// The Issue's Projects line for a tooltip, or the one hint that the token
    /// cannot read them.
    public static func issueProjectLine(_ issue: IssueStatus) -> String? {
        if let projects = issue.projects, !projects.isEmpty { return ProjectStatus.tooltip(projects) }
        return issue.projectsUnreadable == true ? ProjectStatus.scopeHint : nil
    }

    /// The Issue mark's own hover (`Sidebar.tsx`): the number and the whole
    /// title, the repository it is in, its Projects lanes, and the branch — all
    /// the row no longer says in words.
    public static func issueMarkLines(_ repository: WorkspaceRepositoryWire?, _ issue: IssueStatus) -> [TooltipLine] {
        var lines: [TooltipLine] = [.fact(TooltipFact(icon: issueGlyph(issue.state), text: issueMark(issue)))]
        if let name = issueRepositoryName(repository, issue) { lines.append(.fact(TooltipFact(icon: .repository, text: name))) }
        if let projects = issueProjectLine(issue) { lines.append(.fact(TooltipFact(text: projects))) }
        if let branch = repository?.branch { lines.append(.fact(TooltipFact(icon: .branch, text: branch))) }
        return lines
    }

    public static func pullRequestMark(_ pullRequest: PullRequestStatus) -> String { "#\(pullRequest.number) \(pullRequest.title)" }

    public static func pullRequestLabel(_ pullRequest: PullRequestStatus) -> String {
        "Pull request #\(pullRequest.number), \(pullRequest.state.rawValue): \(pullRequest.title)"
    }

    /// A pull request's unresolved review conversations, in words — or
    /// nothing, when there are none and none went uncounted. A count read
    /// from only the first page says so.
    public static func unresolvedConversationsText(_ conversations: ConversationCount) -> String? {
        let (unresolved, uncounted) = (conversations.unresolved, conversations.uncounted)
        if unresolved == 0 && uncounted == 0 { return nil }
        let counted = "\(unresolved) unresolved conversation\(unresolved == 1 ? "" : "s")"
        return uncounted == 0 ? counted : "\(counted), \(uncounted) more not counted"
    }

    /// Whether the pull request mark carries the badge: at least one
    /// conversation known to be unresolved.
    public static func hasUnresolvedConversations(_ pullRequest: PullRequestStatus) -> Bool {
        pullRequest.conversations.unresolved > 0
    }

    static func checksGlyph(_ state: CheckSummary.State) -> RowGlyph {
        switch state {
        case .passing: return .checksPassing
        case .failing: return .checksFailing
        case .pending: return .checksPending
        }
    }

    /// A pull request's CI, in words: the verdict, and how many of how many
    /// checks earned it.
    public static func checksText(_ checks: CheckSummary) -> String {
        func checksOf(_ count: Int) -> String { "\(count) check\(count == 1 ? "" : "s")" }
        switch checks.state {
        case .failing:
            return checks.failing == 0 ? "CI: failing" : "CI: failing (\(checks.failing) of \(checksOf(checks.total)))"
        case .pending:
            return checks.pending == 0 ? "CI: pending" : "CI: pending (\(checks.pending) of \(checksOf(checks.total)))"
        case .passing:
            return "CI: passing (\(checksOf(checks.total)))"
        }
    }

    /// The badge the pull request mark wears for its CI — none when nothing
    /// has reported, and none when everything passed.
    public static func checksBadge(_ pullRequest: PullRequestStatus) -> RowGlyph? {
        guard let checks = pullRequest.checks, checks.state != .passing else { return nil }
        return checksGlyph(checks.state)
    }

    /// Which mark a pull request wears, by what became of it.
    public static func pullRequestGlyph(_ state: PullRequestStatus.State) -> RowGlyph {
        switch state {
        case .open: return .pullRequest
        case .draft: return .pullRequestDraft
        case .closed: return .pullRequestClosed
        case .merged: return .pullRequestMerged
        }
    }

    static func issueGlyph(_ state: IssueStatus.State) -> RowGlyph { state == .open ? .issueOpen : .issueClosed }

    /// The pull request, as facts: itself, its unresolved conversations, its
    /// CI. One list, used by the row's tooltip and by the mark's own.
    public static func pullRequestFacts(_ pullRequest: PullRequestStatus) -> [RowFact] {
        var facts = [RowFact(
            icon: pullRequestGlyph(pullRequest.state),
            text: pullRequestMark(pullRequest),
            spoken: pullRequestLabel(pullRequest),
            style: .muted,
            href: pullRequest.url
        )]
        if let conversations = unresolvedConversationsText(pullRequest.conversations) {
            facts.append(RowFact(icon: .conversation, text: conversations, style: .muted))
        }
        if let checks = pullRequest.checks {
            facts.append(RowFact(icon: checksGlyph(checks.state), text: checksText(checks), style: .muted))
        }
        return facts
    }

    /// Why the row cannot say what it is working on, in the words it draws.
    public static func unavailableText(_ unavailable: WorkspaceRepositoryWire.Unavailable) -> String {
        unavailable.number.map { "#\($0) · \(unavailable.reason)" } ?? unavailable.reason
    }

    static func repositoryPage(_ url: String) -> String {
        url.hasPrefix("https://") ? String(url.dropFirst("https://".count)) : url
    }

    public static func workspaceRowFacts(_ workspace: WorkspaceRowInput, _ repository: WorkspaceRepositoryWire?) -> [RowFact] {
        var facts: [RowFact] = []
        // What it is.
        facts.append(RowFact(text: workspace.label, spoken: "\(workspace.label) workspace", style: .name))
        // Where it is.
        facts.append(RowFact(text: workspace.displayRoot, spoken: "path \(workspace.displayRoot)", style: .muted))
        // A close that stopped.
        if let failure = workspace.closeFailure {
            facts.append(RowFact(icon: .statusError, text: failure, spoken: "close failed: \(failure)", style: .danger))
        }
        // What its own terminals are doing.
        switch workspace.terminals {
        case .working?:
            facts.append(RowFact(icon: .statusWorking, text: "A command is running in a terminal", spoken: "terminal working", tone: .working))
        case .finished?:
            facts.append(RowFact(icon: .statusUnread, text: "A terminal command finished", spoken: "terminal finished, unread", tone: .idle))
        case nil:
            break
        }
        // What it is a checkout of, and where that page is.
        if let url = repository?.repositoryUrl {
            facts.append(RowFact(icon: repositoryGlyph(), text: repositoryPage(url), spoken: "repository \(repositoryPage(url))", style: .muted, href: url))
        }
        // That this checkout is a worktree, and of what.
        if let main = repository?.mainWorktree, let worktree = repository?.worktree, worktree != main {
            facts.append(RowFact(icon: .worktree, text: main, spoken: "worktree of \(main)", style: .muted))
        }
        // What it is on.
        if let branch = repository?.branch {
            let unborn = repository?.unborn == true
            facts.append(RowFact(
                icon: .branch,
                text: unborn ? "\(branch) · empty" : branch,
                spoken: unborn ? "branch \(branch), no commits yet" : "branch \(branch)",
                style: .muted
            ))
        }
        // What it is for, and how it is going out.
        if let issue = repository?.issue {
            facts.append(RowFact(icon: issueGlyph(issue.state), text: issueMark(issue), spoken: issueLabel(issue), style: .muted, href: issue.url))
            if let projects = issueProjectLine(issue) { facts.append(RowFact(text: projects, style: .muted)) }
        }
        if let pullRequest = repository?.pullRequest { facts += pullRequestFacts(pullRequest) }
        if let pending = repository?.pending {
            facts.append(RowFact(text: "Reading #\(pending.number)", spoken: "reading #\(pending.number)", style: .muted))
        }
        // Why it cannot say what it is working on.
        if let unavailable = repository?.unavailable {
            facts.append(RowFact(icon: .statusError, text: unavailableText(unavailable), style: .danger))
        }
        // Which machine all of it is happening on, when it is not this one.
        if let host = workspace.sshHost {
            facts.append(RowFact(icon: .remote, text: "ssh:\(host)", spoken: "on \(host)", style: .muted))
        }
        // Where the editor is, when it is not on the Workspace's machine.
        if let editor = editorAttachmentFact(workspace.editor) {
            facts.append(RowFact(icon: .container, text: editor.text, spoken: editor.spoken, style: .muted))
        }
        return facts
    }

    /// The status in words (`statusLabel`).
    public static func statusLabel(_ status: ConversationAgentStatus) -> String {
        switch status {
        case .working: return "Working"
        case .background: return "Background"
        case .waiting: return "Waiting"
        case .idle: return "Idle"
        case .error: return "Error"
        case .unknown: return "Unknown"
        }
    }

    /// Idle and unread is drawn as the unread mark; everything else is drawn
    /// as its status (`unreadShows`). `background` is not idle in this
    /// respect: something in it still moves.
    public static func unreadShows(_ status: ConversationAgentStatus, _ unread: ConversationAgentStatus?) -> Bool {
        status == .idle && unread != nil
    }

    static func statusGlyph(_ status: ConversationAgentStatus) -> RowGlyph {
        switch status {
        case .working: return .statusWorking
        case .background: return .statusBackground
        case .waiting: return .statusWaiting
        case .idle: return .statusIdle
        case .error: return .statusError
        case .unknown: return .statusUnknown
        }
    }

    static func runtimeHealthLabel(_ health: AgentRuntimeHealth) -> String {
        switch health {
        case .starting: return "Starting runtime"
        case .degraded: return "Runtime needs attention"
        case .unavailable, .failed: return "Runtime unavailable"
        case .healthy: return "Connected"
        }
    }

    /// Why this Agent may not be doing what its status says (`agentNote`):
    /// stopping, a stop that failed, a failure, or a runtime that is not
    /// healthy. The labels of the first three are the model's words.
    public static func agentNote(stopping: Bool, stopFailed: String?, failure: String?, runtimeHealth: AgentRuntimeHealth) -> String? {
        if stopping { return "Stopping" }
        if let stopFailed { return stopFailed }
        if let failure { return failure }
        return runtimeHealth == .healthy ? nil : runtimeHealthLabel(runtimeHealth)
    }

    public static func agentRowFacts(_ agent: AgentRowInput, owner: (label: String, icon: RowGlyph)? = nil) -> [RowFact] {
        let unread = unreadShows(agent.status, agent.unread)
        var facts = [RowFact(text: agent.displayName, style: .name)]
        // What it is doing, in its own colour. Unread is part of this fact.
        facts.append(RowFact(
            icon: unread ? .statusUnread : statusGlyph(agent.status),
            text: unread ? "\(statusLabel(agent.status)) · unread" : statusLabel(agent.status),
            spoken: unread ? "\(statusLabel(agent.status)) agent, unread" : "\(statusLabel(agent.status)) agent",
            tone: unread ? agent.unread : agent.status
        ))
        if let activity = agent.activity { facts.append(RowFact(text: activity, style: .muted)) }
        if let note = agent.note { facts.append(RowFact(text: note, style: .note)) }
        if let owner { facts.append(RowFact(icon: owner.icon, text: owner.label, style: .muted)) }
        return facts
    }

    public static func agentRowDescription(_ agent: AgentRowInput, owner: (label: String, icon: RowGlyph)? = nil) -> String {
        describe(agentRowFacts(agent, owner: owner))
    }

    /// The one fact an Agent's tooltip is: its mark, and what the row leads
    /// with — what it says it is doing, or its name.
    public static func agentTooltipFacts(_ agent: AgentRowInput) -> [RowFact] {
        let unread = unreadShows(agent.status, agent.unread)
        return [RowFact(
            icon: unread ? .statusUnread : statusGlyph(agent.status),
            text: agent.activity ?? agent.displayName,
            tone: unread ? agent.unread : agent.status
        )]
    }
}
