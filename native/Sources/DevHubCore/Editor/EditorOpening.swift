// Port of the terminal-mode open flow in apps/desktop/src/main/shell/appController.ts
// (`openFromCli`, `openFromConversation`, `openRouted` → `openInManagedNeovim`,
// `rememberWaitReturn`, `waitEndedFromCli`, `because`, `at`) and of
// apps/desktop/src/main/shell/openFromFinder.ts.
//
// `devhub <path>`, a conversation's file link, Finder's Open With: one rule
// for where a file lands (`OpenRouting`), and this is the carrying out of its
// answer in terminal mode — the Workspace selected (beside the Agent that
// asked, for an Agent's pane or a conversation link), the editor area in
// front with the keyboard in it, and the file opened in that Workspace's
// managed Neovim, started in a new window of its tmux session if it is not
// running. A Workspace terminal mode cannot serve yet (on an SSH host, or
// with its editor in a dev container) is refused with the sentence its
// editor area shows.
//
// Everything that is the app's model — what is selected, which Workspaces
// are open, selecting one — is `EditorOpenHost`, which the coordinator
// implements (WP2/Wave 2). The sentences the CLI prints are here, verbatim.

import Foundation

/// A Workspace as a file jump needs it: where its managed Neovim runs, and
/// whether terminal mode can serve it at all.
public struct EditorPlace: Equatable, Sendable {
    public var workspaceId: String
    /// Absolute, canonical.
    public var root: String
    /// `terminalModeSupports`: a Workspace on this Mac.
    public var supported: Bool
    /// `TERMINAL_MODE_NO_SSH`: what is said when it is not —
    /// given for every Workspace, because a jump from another machine into a
    /// served one is refused with it too.
    public var unsupportedReason: String

    public init(
        workspaceId: String, root: String, supported: Bool = true,
        unsupportedReason: String = TerminalMode.noSSH
    ) {
        self.workspaceId = workspaceId
        self.root = root
        self.supported = supported
        self.unsupportedReason = unsupportedReason
    }

    /// What a refused jump says (model/terminalMode.ts): an SSH Workspace's
    /// `TERMINAL_MODE_NO_SSH`, a dev container's `TERMINAL_MODE_NO_DEV_CONTAINERS`.
    public static func unsupportedSentence(onSSHHost: Bool) -> String {
        onSSHHost ? TerminalMode.noSSH : TerminalMode.noDevContainers
    }
}

/// Where the editor puts the cursor; with an `end`, the selection — whose
/// cursor in Neovim is its start.
public struct FileSelection: Equatable, Sendable {
    public var line: Int
    public var column: Int
    public var end: ControlPosition?

    public init(line: Int, column: Int, end: ControlPosition? = nil) {
        self.line = line
        self.column = column
        self.end = end
    }

    public init(_ position: ControlPosition) {
        self.init(line: position.line, column: position.column)
    }
}

/// A file a link named that is not there to open (`fileNotFound`, model/wire.ts).
public struct FileNotFound: NamedFailureText, Equatable, CustomStringConvertible, Sendable {
    public let path: String
    public let detail: String?
    public var summary: String { "File not found: \(path)" }
    public var description: String { controlFailureText(self) }

    public init(path: String, detail: String) {
        self.path = path
        self.detail = detail
    }
}

/// The app's model, as a file jump needs it. The coordinator implements it
/// with the intents its own window dispatches.
public protocol EditorOpenHost: Sendable {
    /// WP2's `NavigationSelection` (context + presentation).
    associatedtype Selection: Equatable & Sendable

    /// What is selected now: the "before" a `--wait` goes back to.
    func selection() async -> Selection
    /// The filesystem of the machine a path is on (`runtimeById(machine)`);
    /// throws for a machine DevHub cannot reach.
    func pathMachine(_ machine: String) async throws -> any PathMachine
    /// Where the files are, in a sentence's words: "" here, " on <host>" there
    /// (`Runtime.where`).
    func whereOnMachine(_ machine: String) async -> String
    /// The open Workspaces, as the routing rule reads them.
    func routableWorkspaces() async -> [RoutableWorkspace]
    /// The open Workspace rooted at `root` on `machine` (`workspaceAt`).
    func place(root: String, machine: String) async throws -> EditorPlace
    /// Today's Scratch (`scratchWorkspace`).
    func scratchPlace() async throws -> EditorPlace
    /// The running Agent's name, for the sentence; nil when it is not running.
    func runningAgentName(_ agentId: String) async -> String?
    /// The Workspace an Agent runs in and its machine (`workspaceForAgent`,
    /// `agentMachine`); throws "no Agent <id> is open".
    func agentPlace(_ agentId: String) async throws -> (workspaceId: String, machine: String)
    /// `devhub <folder>`: make it a Workspace and show its editor terminal
    /// (`openFolder` + `syncEditorView`).
    func openFolder(_ path: String, machine: String) async throws
    /// Show Scratch's editor area (`new_window`).
    func showScratch() async throws
    /// Select the Workspace — `beside` the Agent first when there is one, the
    /// editor half in front (two `select_context`s, as a person makes a split).
    func select(workspaceId: String, besideAgent agentId: String?) async throws
    /// The keyboard out of the Sidebar and any Agent terminal, into the editor
    /// area (`keyboardInSidebar = false`, `focus_pane content`,
    /// `placeKeyboardOnSurface`).
    func keyboardToEditorArea() async
    func bringToFront() async
    /// The person started an action (a link clicked).
    func personStartedAction() async
    /// Whether the Workspace or Agent a selection names is still open.
    func stillExists(_ selection: Selection) async -> Bool
    /// Go back to a selection (`select_context` + `syncEditorView`).
    func restore(_ selection: Selection) async throws
}

public actor EditorOpening<Host: EditorOpenHost> {
    private let host: Host
    private let neovims: ManagedNeovims
    private var waitReturns = WaitSelectionReturns<Host.Selection>()

    public init(host: Host, neovims: ManagedNeovims) {
        self.host = host
        self.neovims = neovims
    }

    /// `because`: why an open went where it went, for the CLI's sentence.
    public static func because(_ reason: OpenReason) -> String {
        switch reason {
        case .origin: return "it is the window this terminal belongs to."
        case .originAgent: return "it is the Agent this terminal belongs to."
        case .containing: return "it is the open workspace that contains it."
        case .noContainingWorkspace: return "no open workspace contains it."
        }
    }

    /// `at`: where in the file, for the same sentence.
    public static func at(_ position: FileSelection?) -> String {
        guard let position else { return "" }
        return " at line \(position.line), column \(position.column),"
    }

    /// `devhub <path>` (the `open` request): a folder becomes a Workspace; a
    /// file lands where `routeOpen` says.
    public func openFromCli(_ request: ControlOpenRequest) async throws -> String {
        let machine = request.machine ?? "local"
        // The `devhub` command inside a dev container: terminal mode has no
        // workbench to put in one.
        if machine.hasPrefix("container:") {
            throw ManagedNeovimError(EditorPlace.unsupportedSentence(onSSHHost: false))
        }
        // Taken before anything is selected: this is the "before" a `--wait`
        // goes back to when its editor is closed.
        let before = await host.selection()
        // Resolved on the machine that owns the path, because that is where
        // its symlinks are.
        let target = try await PathCanonicalisation.canonicalise(try await host.pathMachine(machine), request.path)
        let position = request.position.map(FileSelection.init)
        if target.isDirectory {
            if position != nil {
                throw ManagedNeovimError("\(target.path) is a folder, and a line and column belong to a file.")
            }
            // A folder has no editor to close, so there is nothing here that
            // `--wait` could wait for. Saying so beats waiting forever.
            if request.waitMarkerPath != nil {
                throw ManagedNeovimError("\(target.path) is a folder, and --wait waits for an editor to be closed.")
            }
            try await host.openFolder(target.path, machine: machine)
            await host.bringToFront()
            return "\(target.path) is open in DevHub."
        }
        let destination = try OpenRouting.routeOpen(
            target.path, machine: machine, workspaces: await host.routableWorkspaces(), origin: request.origin)
        return try await openRouted(
            destination, machine: machine, target: target, position: position, waitMarkerPath: request.waitMarkerPath,
            before: before)
    }

    /// A file link in a GUI Agent's conversation, clicked: opened where
    /// `routeAgentOpen` says. A file that has gone since the link was drawn is
    /// refused rather than opened as a new, empty editor.
    public func openFromConversation(agentId: String, path: String, selection: FileSelection?) async throws {
        await host.personStartedAction()
        let place = try await host.agentPlace(agentId)
        let target = try await PathCanonicalisation.canonicalise(try await host.pathMachine(place.machine), path)
        if !target.exists {
            throw FileNotFound(path: path, detail: "It is no longer there\(await host.whereOnMachine(place.machine)).")
        }
        if target.isDirectory {
            throw FileNotFound(path: target.path, detail: "\(target.path) is a folder, not a file to open.")
        }
        let destination = try OpenRouting.routeAgentOpen(
            target.path, machine: place.machine, workspaces: await host.routableWorkspaces(),
            agentWorkspaceId: place.workspaceId, agentId: agentId)
        _ = try await openRouted(
            destination, machine: place.machine, target: target, position: selection, waitMarkerPath: nil,
            before: await host.selection())
    }

    /// `openRouted` in terminal mode (`openInManagedNeovim`).
    func openRouted(
        _ destination: OpenDestination, machine: String, target: ResolvedPath, position: FileSelection?,
        waitMarkerPath: String?, before: Host.Selection
    ) async throws -> String {
        let place: EditorPlace
        var besideAgentId: String?
        switch destination {
        case .scratch:
            place = try await host.scratchPlace()
        case let .workspace(workspace, _):
            place = try await host.place(root: workspace.root, machine: workspace.machine)
        case let .besideAgent(workspace, agentId):
            place = try await host.place(root: workspace.root, machine: workspace.machine)
            besideAgentId = agentId
        }
        if !place.supported || machine != "local" {
            throw ManagedNeovimError(place.unsupportedReason)
        }
        var besideName: String?
        if let agentId = besideAgentId, let name = await host.runningAgentName(agentId) {
            besideName = name
        } else {
            besideAgentId = nil
        }
        if case .scratch = destination {
            try await host.showScratch()
        } else {
            try await host.select(workspaceId: place.workspaceId, besideAgent: besideAgentId)
        }
        // The keyboard goes to the editor area, laid out first, so it is
        // attached while Neovim starts: the jump is handing the person
        // something to type in.
        await host.keyboardToEditorArea()
        let started = try await neovims.open(
            WorkspaceTerminalTarget(machine: .local, workspaceId: place.workspaceId, root: place.root),
            NeovimOpen(path: target.path, line: position?.line, column: position?.column, waitMarkerPath: waitMarkerPath))
        await rememberWaitReturn(waitMarkerPath, before: before)
        await host.bringToFront()
        let whereText: String
        if case .scratch = destination {
            whereText = "Scratch (\(place.root))"
        } else {
            whereText = "the workspace at \(place.root)"
        }
        let beside = besideName.map { ", beside the Agent \($0)" } ?? ""
        let editor = started ? "a new Neovim" : "its Neovim"
        return
            "\(target.path)\(Self.at(position)) is open in \(editor) in \(whereText)\(beside): \(Self.because(destination.reason))"
    }

    /// Only for `--wait`: an open without one is not a modal session. The
    /// landing selection is read after the open, because it is what the pop
    /// is checked against.
    private func rememberWaitReturn(_ waitMarkerPath: String?, before: Host.Selection) async {
        guard let waitMarkerPath else { return }
        waitReturns.push(waitMarkerPath, before: before, produced: await host.selection())
    }

    /// The CLI says a `--wait` is over (`wait-ended`): go back to where its
    /// open came from, if nothing has moved since and it still exists.
    /// DevHub is deliberately *not* brought to the front.
    public func waitEnded(_ waitMarkerPath: String) async throws -> String {
        guard let back = waitReturns.take(waitMarkerPath, current: await host.selection()) else {
            return "The wait is over; DevHub stayed where it was."
        }
        if !(await host.stillExists(back)) {
            return "The wait is over; what was selected before it is gone."
        }
        try await host.restore(back)
        return "The wait is over; DevHub is back where it was."
    }

    /// The Workspace is closing: its managed Neovim goes with it (the close's
    /// `editor` step).
    public func closeEditor(workspaceId: String, root: String) async throws {
        try await neovims.close(WorkspaceTerminalTarget(machine: .local, workspaceId: workspaceId, root: root))
    }
}

/// Paths the desktop asked for (`application(_:open:)`, a Dock drop, `open
/// -a DevHub <path>`), and the thing that opens them once it exists. Port of
/// `FinderOpens`: a launch-by-file delivers its document before DevHub has a
/// model, so the paths are queued and answered once the coordinator exists,
/// one at a time — two opens interleaved would be two answers to "what is
/// selected now".
public actor FinderOpens {
    public typealias OpenPath = @Sendable (String) async throws -> Void
    public typealias ReportFailure = @Sendable (Error) async -> Void

    private var waiting: [String] = []
    private var open: OpenPath?
    private var report: ReportFailure?
    private var running: Task<Void, Never>?

    public init() {}

    /// How many paths are still waiting for something to open them.
    public var queued: Int { waiting.count }

    /// macOS asked for this path. It hands out decomposed Unicode; everything
    /// downstream compares with roots that came from somewhere else, so it is
    /// composed (NFC) here.
    public func offer(_ path: String) {
        waiting.append(path.precomposedStringWithCanonicalMapping)
        drain()
    }

    /// There is now something that can open a file. Two openers would be two
    /// rules for where a file lands.
    public func answer(with open: @escaping OpenPath, report: @escaping ReportFailure) throws {
        if self.open != nil {
            throw ManagedNeovimError("DevHub already has something answering Finder opens")
        }
        self.open = open
        self.report = report
        drain()
    }

    /// Wait for every open handed out so far (for tests and for quitting).
    public func settled() async {
        await running?.value
    }

    private func drain() {
        guard let open, let report else { return }
        let paths = waiting
        waiting.removeAll()
        for path in paths {
            let previous = running
            running = Task {
                await previous?.value
                do {
                    try await open(path)
                } catch {
                    // Nothing above called it, so nothing above can be told: it
                    // goes to the one place DevHub shows failures, and the next
                    // path still opens.
                    await report(error)
                }
            }
        }
    }

    /// The `devhub` command's own entry point, addressed as Finder addresses
    /// it: no position, no `--wait`, no machine (a file dropped on this Dock is
    /// a file on this Mac), and its own directory as the cwd.
    public static func finderOpen(_ openFromCli: @escaping @Sendable (ControlOpenRequest) async throws -> String)
        -> OpenPath
    {
        { path in
            _ = try await openFromCli(
                ControlOpenRequest(path: path, cwd: (path as NSString).deletingLastPathComponent))
        }
    }
}
