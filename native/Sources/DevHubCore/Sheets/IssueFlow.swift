// Port of apps/desktop/src/shell/picker/IssueAssignmentSheet.tsx: "Assign
// Issue", the four questions, as a wizard.
//
// Which Issue and what to do with it, which clone, which branch, which agent —
// and each answer decides the next question. The branch answer is acted on
// before the agent is asked about: the folder is made or found, and the agent
// question is then New Agent's about that folder by its path, earlier
// sessions and all. Nothing is opened until an agent is chosen. Escape goes
// back one question the whole way down, because that is the runner's rule.
//
// Two kinds of "that did not work" show up in the same place, the line under
// the field. A URL that is not an Issue URL is this flow's business — the
// question has not been answered yet, so it is asked again with what was
// typed still in the field. A clone git refused, or a worktree whose
// directory is in the way, is DevHub's, and the runner brings it back to
// whichever step caused it.

import Foundation

/// What New Agent's question answered (`AgentChoice`).
public struct AgentChoice: Equatable, Sendable {
    public var profileId: String
    /// Beside the editor: Option.
    public var split: Bool
    public var presentation: AgentPresentation
    /// The earlier session the Agent resumes; nil starts afresh.
    public var resume: String?

    public init(profileId: String, split: Bool, presentation: AgentPresentation, resume: String? = nil) {
        self.profileId = profileId
        self.split = split
        self.presentation = presentation
        self.resume = resume
    }
}

/// The agent question's answer in the Issue flow: an Agent, or none.
public enum FolderAgentAnswer: Equatable, Sendable {
    case agent(AgentChoice)
    case editorOnly
}

/// A presenter that can also draw New Agent's sheet for a folder.
@MainActor
public protocol IssueFlowPresenter: WizardPresenter {
    func folderAgentSheet(title: String, place: WorkspacePlace, controls: WizardSheetControls<FolderAgentAnswer>) -> Drawing
}

public enum IssueFlow {
    static let lookAgain = "devhub:look-again"
    static let cloneElsewhere = "devhub:clone-elsewhere"
    static let acceptTyped = "devhub:accept-typed"
    static let actionPrefix = "devhub:action:"
    static let newWorktree = "devhub:new-worktree"
    static let existingBranch = "devhub:existing-branch"
    static let openCheckout = "devhub:open-checkout"
    static let rootCheckout = "devhub:root-checkout"
    static let rootExistingBranch = "devhub:root-existing-branch"
    static let rootNewBranch = "devhub:root-new-branch"
    static let useStaleBase = "devhub:use-stale-base"

    static let emptyNoMatch = "Nothing matches."
    static let emptyNoItems = "Nothing to choose from."
    static let notAnItem = "That is not a GitHub Issue or pull request URL."

    /// `owner/repo#128`.
    public static func itemLabel(_ item: GitHubItem) -> String { "\(item.owner)/\(item.repository)#\(item.number)" }

    /// "No worktrees", "2 worktrees".
    public static func worktreeCount(_ places: Int) -> String {
        let others = places - 1
        if others <= 0 { return "No worktrees" }
        return others == 1 ? "1 worktree" : "\(others) worktrees"
    }

    /// Why a clone is being asked about when nobody asked for one.
    public static func nothingCloned(_ item: GitHubItem) -> String {
        "No clone of \(item.owner)/\(item.repository) was found on this machine, so it has to be cloned before the agent can start."
    }

    /// A folder as the branch question names it: `../widget_128` when it sits
    /// beside the repository, the whole path anywhere else.
    public static func besideRoot(_ root: String, _ path: String) -> String {
        Worktrees.parentDirectory(path) == Worktrees.parentDirectory(root) ? "../\(Worktrees.baseName(path))" : path
    }

    /// Why a pull request's head cannot be worked on here.
    public static func unreachableHead(_ item: GitHubItem, _ plan: AssignmentBranch) -> String {
        let label = itemLabel(item)
        let branch = plan.branch ?? ""
        if let fork = plan.fork {
            return "\(branch) is in \(fork), which this clone has no remote for, so \(label) cannot be checked out here."
        }
        switch plan.pullRequestState {
        case .merged?: return "\(label) is a merged pull request, and its branch \(branch) no longer exists."
        case .closed?: return "\(label) is a closed pull request, and its branch \(branch) no longer exists."
        default: return "\(branch), the branch of \(label), is on neither this machine nor any remote this clone has."
        }
    }

    /// The rows of the branch question, each saying what it does and where.
    public static func folderRows(_ plan: AssignmentBranch, root: String, item: GitHubItem, wip: String) -> [PickerItem] {
        let work = WorkItem(kind: item.kind, number: item.number)
        let branch = plan.branch
        let checkedOutAt = plan.checkedOutAt
        let existing = branch != nil && (checkedOutAt != nil || plan.reachable) ? branch : nil
        let offerNew = item.kind != .pull && branch != wip
        var rows: [PickerItem] = []
        if let existing, checkedOutAt != root {
            if let checkedOutAt {
                rows.append(PickerItem(
                    id: openCheckout, label: "Open \(existing) in its worktree",
                    detail: "Already checked out in \(besideRoot(root, checkedOutAt))",
                    searchText: "existing branch worktree \(existing) \(checkedOutAt)", glyph: .branch))
            } else {
                rows.append(PickerItem(
                    id: existingBranch, label: "Open \(existing) in a new worktree",
                    detail: "Checks out the existing branch in \(besideRoot(root, Worktrees.directory(mainWorktree: root, work: work, branch: existing)))",
                    searchText: "existing branch worktree \(existing)", glyph: .branch))
            }
        }
        if offerNew {
            rows.append(PickerItem(
                id: newWorktree, label: "Create \(wip) in a new worktree",
                detail: "New branch from the default branch, in \(besideRoot(root, Worktrees.directory(mainWorktree: root, work: work, branch: wip)))",
                searchText: "new branch worktree \(wip)", glyph: .branch))
        }
        if let existing, checkedOutAt == root {
            rows.append(PickerItem(
                id: openCheckout, label: "Open \(existing) in the root checkout", detail: "Already checked out in \(root)",
                searchText: "existing branch root \(existing) \(root)", glyph: .folder))
        } else if let existing, checkedOutAt == nil {
            rows.append(PickerItem(
                id: rootExistingBranch, label: "Open \(existing) in the root checkout",
                detail: "Switches \(root) to the existing branch", searchText: "existing branch root switch \(existing) \(root)",
                glyph: .folder))
        }
        if offerNew {
            rows.append(PickerItem(
                id: rootNewBranch, label: "Create \(wip) in the root checkout",
                detail: "New branch from the default branch, switched to in \(root)",
                searchText: "new branch root switch \(wip) \(root)", glyph: .folder))
        }
        if !(existing != nil && checkedOutAt == root) {
            rows.append(PickerItem(
                id: rootCheckout, label: "Open the root checkout as it is", detail: "No branch change in \(root)",
                searchText: "repository root as is \(root)", glyph: .folder))
        }
        return rows
    }

    /// The Issue, and what the agent is to do with it.
    struct Work {
        let item: GitHubItem
        let actionId: String?
    }

    /// The folder the branch question settled on, before it is made or found.
    struct FolderChoice {
        let place: WorkspacePlace
        let branch: String?
        let inRoot: Bool
    }

    /// The flow's first step.
    @MainActor
    public static func start<P: IssueFlowPresenter>(_ services: any SheetServices) -> WizardStep<P> {
        issueUrlStep(services)
    }

    @MainActor
    static func issueUrlStep<P: IssueFlowPresenter>(_ services: any SheetServices) -> WizardStep<P> {
        @MainActor func ask(_ input: WizardInput<P>, _ typed: String, _ wrong: Bool) async throws -> WizardStep<P>? {
            // The Issue flow's own actions, and only those.
            let actions = try await input.working("Reading settings…") { await services.agentActions() }
                .filter { $0.trigger == .issue }
            let pinned: [PickerItem] = actions.isEmpty
                ? [PickerItem(
                    id: acceptTyped, label: "Use this URL",
                    detail: "No actions are configured, so the agent starts and is told nothing")]
                : actions.map { PickerItem(id: "\(actionPrefix)\($0.id)", label: $0.displayName) }
            let answer = try await input.ask(PickerPrompt(
                title: "Assign Issue",
                question: "Paste the GitHub Issue or pull request to work on, then choose what the agent should do with it.",
                placeholder: "https://github.com/owner/repo/issues/128 or /pull/128", initialQuery: typed, pinned: pinned,
                note: wrong ? notAnItem : nil, noteIsFailure: wrong))
            guard let item = GitHubItem.parse(url: answer.query) else { return try await ask(input, answer.query, true) }
            let actionId = answer.id.hasPrefix(actionPrefix) ? String(answer.id.dropFirst(actionPrefix.count)) : nil
            return repositoryStep(services, Work(item: item, actionId: actionId))
        }
        return WizardStep { input in try await ask(input, "", false) }
    }

    @MainActor
    static func repositoryStep<P: IssueFlowPresenter>(_ services: any SheetServices, _ work: Work) -> WizardStep<P> {
        let item = work.item
        let name = "\(item.owner)/\(item.repository)"
        return WizardStep { input in
            let repositories: [RepositoryCandidate]
            do {
                repositories = try await input.working("Looking for \(name)…") {
                    try await services.findIssueRepositories(item.url)
                }
            } catch let signal as WizardSignal {
                throw signal
            } catch {
                // A lookup that failed becomes a question: what happened, and
                // what may be done about it.
                guard let spoken = SpokenFailure.of(error) else { throw error }
                let answer = try await input.ask(PickerPrompt(
                    title: "Looking for \(name)", question: spoken.summary,
                    pinned: [
                        PickerItem(id: lookAgain, label: "Look again", detail: "Search this machine for \(name) once more"),
                        PickerItem(id: cloneElsewhere, label: "Clone…", detail: "Clone \(name) instead of looking for it"),
                    ],
                    emptyNoMatch: emptyNoMatch, emptyNoItems: emptyNoItems))
                return answer.id == lookAgain
                    ? repositoryStep(services, work)
                    : cloneDestinationStep(services, work, reason: "\(name) is being cloned because the search for it did not finish.")
            }
            if repositories.isEmpty { return cloneDestinationStep(services, work, reason: nothingCloned(item)) }
            if repositories.count == 1 { return branchStep(services, work, place: repositories[0].place) }
            let answer = try await input.ask(PickerPrompt(
                title: "Which \(name)",
                question: "This machine has more than one clone of \(name). Choose the one to work in, or clone it again somewhere else.",
                items: repositories.map { repository in
                    PickerItem(
                        id: repository.place.label, label: repository.place.label,
                        detail: worktreeCount(repository.worktrees.count), searchText: repository.place.label, glyph: .folder)
                },
                pinned: [PickerItem(id: cloneElsewhere, label: "Clone…", detail: "Clone \(name) again, somewhere else", glyph: .clone)],
                emptyNoMatch: "No repository matches.", emptyNoItems: "No clone of \(name) was found."))
            if answer.id == cloneElsewhere {
                return cloneDestinationStep(
                    services, work, reason: "\(name) is being cloned again rather than worked on where it already is.")
            }
            guard let chosen = repositories.first(where: { $0.place.label == answer.id }) else {
                return cloneDestinationStep(services, work, reason: nothingCloned(item))
            }
            return branchStep(services, work, place: chosen.place)
        }
    }

    @MainActor
    static func branchStep<P: IssueFlowPresenter>(_ services: any SheetServices, _ work: Work, place: WorkspacePlace) -> WizardStep<P> {
        let item = work.item
        let root = place.path
        return WizardStep { input in
            var plan = AssignmentBranch(reachable: false)
            var refusal: String?
            do {
                plan = try await input.working("Reading \(itemLabel(item))…") {
                    try await services.assignmentBranch(url: item.url, place: place)
                }
            } catch let signal as WizardSignal {
                throw signal
            } catch {
                guard let spoken = SpokenFailure.of(error) else { throw error }
                refusal = spoken.summary
            }
            if !plan.reachable && plan.checkedOutAt == nil {
                // A pull request is work on its head branch and nothing else.
                if item.kind == .pull && plan.branch != nil { throw UserFacingFailure(unreachableHead(item, plan)) }
                plan = AssignmentBranch(reachable: false)
            }
            let wip = GitHubBranchNaming.wipBranch(forIssue: item.number)
            let answer = try await input.ask(PickerPrompt(
                title: "Where to work on \(itemLabel(item))",
                question: "Choose where in \(Projects.folderName(root)) the agent works. The agent is chosen next.",
                pinned: folderRows(plan, root: root, item: item, wip: wip), emptyNoMatch: emptyNoMatch, note: refusal))
            let choice: FolderChoice
            if answer.id == openCheckout, let checkedOutAt = plan.checkedOutAt {
                choice = FolderChoice(place: place.with(path: checkedOutAt), branch: nil, inRoot: false)
            } else {
                let branch: String? = answer.id == newWorktree || answer.id == rootNewBranch
                    ? wip : answer.id == existingBranch || answer.id == rootExistingBranch ? plan.branch : nil
                choice = FolderChoice(
                    place: place, branch: branch, inRoot: answer.id == rootNewBranch || answer.id == rootExistingBranch)
            }
            return try await prepareFolder(services, input, work, choice, allowStaleBase: false)
        }
    }

    @MainActor
    static func cloneDestinationStep<P: IssueFlowPresenter>(_ services: any SheetServices, _ work: Work, reason: String) -> WizardStep<P> {
        let item = work.item
        let name = "\(item.owner)/\(item.repository)"
        return WizardStep { input in
            var parents: [String] = []
            var refusal: String?
            do {
                parents = try await input.working("Reading folders…") { try await services.cloneParentDirectories() }
            } catch let signal as WizardSignal {
                throw signal
            } catch {
                guard let spoken = SpokenFailure.of(error) else { throw error }
                refusal = spoken.summary
            }
            let answer = try await input.ask(PickerPrompt(
                title: "Clone \(name)",
                question: refusal.map { "\($0) Type the folder to clone it into." } ?? "\(reason) Choose the folder to clone it into.",
                items: SheetRows.cloneParentItems(parents, repositoryName: item.repository),
                pinned: [SheetRows.cloneTypedItem(repositoryName: item.repository)],
                emptyNoMatch: "No folder matches. Type one instead.",
                emptyNoItems: "Type the folder the clone should go into."))
            let destination = answer.id == SheetRows.cloneIntoTyped ? answer.query : answer.id
            guard case let .clone(url, _) = Projects.gitHubCloneTarget(owner: item.owner, repository: item.repository) else {
                throw InvariantViolation("the Issue's repository is not a name GitHub could have: \(name)")
            }
            let directory = try await input.working("Cloning \(name)…") {
                try await services.cloneRepository(url: url, parentDirectory: destination)
            }
            return branchStep(services, work, place: .local(path: directory))
        }
    }

    /// Make or find the folder, then ask which agent — opening nothing.
    @MainActor
    static func prepareFolder<P: IssueFlowPresenter>(
        _ services: any SheetServices, _ input: WizardInput<P>, _ work: Work, _ choice: FolderChoice, allowStaleBase: Bool
    ) async throws -> WizardStep<P> {
        let folder: WorkspacePlace
        let message: String = {
            guard let branch = choice.branch else { return "Reading \(Worktrees.baseName(choice.place.path))…" }
            return choice.inRoot
                ? "Switching \(Worktrees.baseName(choice.place.path)) to \(branch)…" : "Setting up the worktree for \(branch)…"
        }()
        do {
            folder = try await input.working(message) {
                try await services.prepareIssueFolder(IssueFolderRequest(
                    issueUrl: work.item.url, place: choice.place, branch: choice.branch, inRoot: choice.inRoot,
                    allowStaleBase: allowStaleBase))
            }
        } catch let failure as CodedFailure where failure.code == "git_fetch_failed" {
            return staleBaseStep(services, work, choice, failure: failure.summary)
        } catch let failure as NamedFailure where failure.code == .gitFetchFailed {
            return staleBaseStep(services, work, choice, failure: failure.summary)
        }
        return agentStep(services, work, folder: folder)
    }

    @MainActor
    static func agentStep<P: IssueFlowPresenter>(_ services: any SheetServices, _ work: Work, folder: WorkspacePlace) -> WizardStep<P> {
        let item = work.item
        return WizardStep { input in
            let presenter = input.presenter
            let agent: FolderAgentAnswer = try await input.sheet { controls in
                presenter.folderAgentSheet(title: "Agent for \(itemLabel(item))", place: folder, controls: controls)
            }
            switch agent {
            case .editorOnly:
                try await input.working("Opening \(itemLabel(item))…") {
                    try await services.assignIssue(SheetIssueAssignment(issueUrl: item.url, place: folder, editorOnly: true))
                }
            case let .agent(choice):
                try await input.working("Starting the agent for \(itemLabel(item))…") {
                    try await services.assignIssue(SheetIssueAssignment(
                        issueUrl: item.url, place: folder, profileId: choice.profileId, actionId: work.actionId,
                        split: choice.split, presentation: choice.presentation, resume: choice.resume))
                }
            }
            return nil
        }
    }

    /// The fetch failed: start from the copy on disk, or not at all.
    @MainActor
    static func staleBaseStep<P: IssueFlowPresenter>(
        _ services: any SheetServices, _ work: Work, _ choice: FolderChoice, failure: String
    ) -> WizardStep<P> {
        let branch = choice.branch ?? "The branch"
        return WizardStep { input in
            let answer = try await input.ask(PickerPrompt(
                title: "The remote could not be reached",
                question: "\(branch) cannot be started from the latest origin, because the fetch failed. Start it from the copy on this machine, or press Escape to go back.",
                items: [PickerItem(
                    id: useStaleBase, label: "Start from the copy on this machine",
                    detail: "\(branch) starts from origin as of the last successful fetch", searchText: "yes anyway offline stale local")],
                emptyNoMatch: emptyNoMatch, emptyNoItems: emptyNoItems, note: failure, noteIsFailure: true))
            return answer.id == useStaleBase ? try await prepareFolder(services, input, work, choice, allowStaleBase: true) : nil
        }
    }
}
