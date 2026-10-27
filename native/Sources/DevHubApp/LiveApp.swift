// The window and the runtime behind it, put together the one way there is:
// the app's launch (`AppDelegate.launch`) and the self-test's end-to-end
// phase (`LiveSelfTest`) both make them here, so what the self-test drives is
// what a person runs — the conversations wired to the window, the questions
// layer, the notices, Settings, dictation and the editor area's exits.
//
// The window is made first, in the settings' chrome and colours (read from
// the file before the settings can be loaded), so that the runtime's first
// messages have somewhere to go; the runtime is started into it after.

import AppKit
import DevHubCore

@MainActor
final class LiveApp {
    let locations: ProfileLocations
    let shell: ShellController
    /// WP10: the GUI Agents' conversations, and what is drawn over the active Agent.
    let conversations = ConversationViews()
    private let box = ShellBox()
    private let transport = LateTransport()
    private(set) var runtime: DevHubRuntime?

    /// The window, shown and taking keys. `extensionRoots` is where colour
    /// themes are looked for (the profile's own, by default).
    init(locations: ProfileLocations, extensionRoots: ExtensionRoots? = nil) {
        self.locations = locations
        let text = try? String(contentsOfFile: locations.settingsFilePath, encoding: .utf8)
        let titleBar = ConfigParsing.titleBarMode(in: text)
        let themes = ConfigParsing.colorThemes(in: text)
        let names = ColorThemeNames(dark: themes.dark, light: themes.light)
        let roots = extensionRoots ?? ExtensionRoots.standard(profile: locations, home: NSHomeDirectory())
        let appearance = AppearanceController(names: names, roots: roots)
        appearance.configure(mode: ConfigParsing.appearanceMode(in: text), names: names)
        let shell = ShellController(titleBar: titleBar, appearance: appearance, transport: transport, conversations: conversations)
        self.shell = shell
        let conversations = self.conversations
        shell.window.agents.overlays = conversations
        conversations.dispatch = { [weak shell] intent in shell?.dispatch(intent) }
        conversations.repository = { [weak shell] workspaceId in
            shell?.repositories.workspaces.first { $0.workspaceId == workspaceId }
        }
        conversations.agentActions = { [weak shell] in shell?.config?.agentActions ?? [] }
        conversations.link.report = { [weak shell] failure in shell?.notices.error(failure) }
        conversations.link.dictation = shell.dictation
        conversations.link.pickSession = { [weak shell] request, chosen in
            guard let shell else { return chosen(nil) }
            shell.pickSession(request, chosen: chosen)
        }
        box.shell = shell
        shell.openSettings = { [weak shell] in shell?.toggleSettings() }
        shell.window.showWindow(nil)
        NSApp.activate()
        shell.installKeyboard()
    }

    var titleBar: TitleBarMode { shell.titleBar }

    /// Start the runtime into the window, and say the window is ready for it.
    func start(_ environment: RuntimeEnvironment) async throws -> DevHubRuntime {
        let box = self.box
        let hooks = RuntimeHooks(
            repositories: { status in Task { @MainActor in box.shell?.repositoriesChanged(status) } },
            usageLimits: { limits in Task { @MainActor in box.shell?.usageLimitsChanged(limits) } },
            config: { config in Task { @MainActor in box.shell?.configAccepted(config) } })
        let runtime = try await DevHubRuntime.start(environment, app: WindowShell(box: box), hooks: hooks)
        self.runtime = runtime
        transport.target = runtime.transport
        shell.adopt(runtime)
        let controller = runtime.controller
        let shell = self.shell
        conversations.runAgentAction = { [weak shell] agentId, actionId in
            Task {
                do { _ = try await controller.runAgentAction(agentId: agentId, actionId: actionId) } catch {
                    shell?.notices.error(errorWire(error))
                }
            }
        }
        if let conversationTransport = await controller.conversationTransport() {
            conversations.link.adopt(conversationTransport)
        }
        await runtime.controller.shellReady()
        return runtime
    }

    /// DevHub is going: nothing the window sees from here on is a person's exit.
    func letGo() {
        shell.editorTerminalExits.dispose()
        shell.window.disposeAll()
    }
}
