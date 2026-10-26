import XCTest
@testable import DevHubCore

final class ConfigModelTests: XCTestCase {
    func testDefaultsAreTheTypeScriptAppsDefaults() {
        let config = Config.defaults
        XCTAssertEqual(config.version, 4)
        XCTAssertEqual(config.general, GeneralConfig(
            importLoginEnvironment: true, notifyOnIdle: true, notifySound: true,
            noticeSeconds: 8, terminalIdleSeconds: 5, workbenchHibernateMinutes: 10,
            workbenchAwakeMax: 2, workbench: "vscode"
        ))
        XCTAssertEqual(config.runtimes, RuntimeConfig(shell: "/bin/zsh", git: "git", tmux: "tmux", tmuxSocketName: "devhub", tmuxArgs: []))
        XCTAssertEqual(config.appearance.mode, "auto")
        XCTAssertEqual(config.appearance.themeDark, "Dark 2026")
        XCTAssertEqual(config.appearance.themeLight, "Light 2026")
        XCTAssertEqual(config.appearance.titleBar, "shown")
        XCTAssertEqual(config.appearance.terminalFontFamily, "ui-monospace")
        XCTAssertEqual(config.appearance.terminalFontSize, 13)
        XCTAssertEqual(config.appearance.terminalLineHeight, 1)
        XCTAssertEqual(config.appearance.terminalScrollSensitivity, 3)
        XCTAssertEqual(config.appearance.sidebarDensity, "compact")
        XCTAssertEqual(config.appearance.terminalMargin, 4)
        XCTAssertEqual(config.appearance.terminalTheme, .vscode)
        XCTAssertEqual(config.keybindings, KeybindingsSpec(prefix: "Cmd+q", chords: [:]))
        XCTAssertEqual(config.workspaceSources, [])
        XCTAssertEqual(config.scratch.daily, "~/junk/YYYYMMDD")
        XCTAssertNil(config.projects.directory)
        XCTAssertEqual(config.agents, AgentsConfig(
            defaultPresentation: .tui, resumeAfterLimit: true, resumeAfterLimitMessage: "続けて",
            autoCompactBeforeCacheExpiry: true, autoCompactLeadSeconds: 60, autoCompactMinTokens: 100_000
        ))
        XCTAssertEqual(config.agentProfiles.map(\.id), ["codex", "claude", "cursor"])
        XCTAssertEqual(config.agentProfiles.map(\.command), ["codex", "claude", "cursor-agent"])
        XCTAssertEqual(config.agentActions.map(\.id), [
            "issue_assignment", "commit_changes", "push_commits", "open_pull_request",
            "ready_draft_pull_request", "address_review_comments", "fix_ci", "send_ok",
        ])
        XCTAssertEqual(config.agentActions.map(\.order), Array(repeating: 0, count: 8))
        XCTAssertEqual(config.agentActions.map(\.button), [false, true, true, true, true, true, true, true])
        XCTAssertEqual(config.agentActions.map(\.confirmBeforeSend), [true, false, false, false, false, false, false, false])
    }

    func testProfilePresentation() {
        let agents = AgentsConfig(defaultPresentation: .gui)
        XCTAssertEqual(profilePresentation(kind: .claude, presentation: nil, agents: agents), .gui)
        XCTAssertEqual(profilePresentation(kind: .cursor, presentation: nil, agents: agents), .tui)
        XCTAssertEqual(profilePresentation(kind: .claude, presentation: .tui, agents: agents), .tui)
    }

    func testProfileRuntimesWinOverASharedSocketName() {
        let locations = ProfileLocations(profile: "native-dev", home: "/Users/me", environment: [:])
        let (config, overridden) = Config.defaults.withProfileRuntimes(locations)
        XCTAssertEqual(config.runtimes.tmuxSocketName, "devhub-native-dev")
        XCTAssertEqual(overridden, "devhub")
        let (same, none) = Config.defaults.withProfileRuntimes(ProfileLocations(profile: "default", home: "/Users/me", environment: [:]))
        XCTAssertEqual(same, Config.defaults)
        XCTAssertNil(none)
    }

    func testJSNumberFormatting() {
        XCTAssertEqual(JSString.number(1), "1")
        XCTAssertEqual(JSString.number(1.5), "1.5")
        XCTAssertEqual(JSString.number(-0.25), "-0.25")
        XCTAssertEqual(JSString.number(100_000), "100000")
        XCTAssertEqual(JSString.number(0.000001), "0.000001")
        XCTAssertEqual(JSString.number(0.0000001), "1e-7")
        XCTAssertEqual(JSString.number(1e21), "1e+21")
        XCTAssertEqual(JSString.number(1.2345678901234568e20), "123456789012345680000")
        XCTAssertEqual(JSString.number(0.1 + 0.2), "0.30000000000000004")
        XCTAssertEqual(JSString.number(1.25e-10), "1.25e-10")
    }

    func testOrderedStringMapUsesJSPropertyOrder() {
        var map = OrderedStringMap()
        map["b"] = "1"
        map["10"] = "2"
        map["a"] = "3"
        map["2"] = "4"
        XCTAssertEqual(map.keys, ["2", "10", "b", "a"])
        map["b"] = nil
        XCTAssertEqual(map.keys, ["2", "10", "a"])
    }

    func testFillVariablesAndSkillNotation() {
        XCTAssertEqual(AgentActions.fillVariables("a {{X}} b {{Y}} {{lower}}", values: ["X": "1"]), "a 1 b {{Y}} {{lower}}")
        XCTAssertEqual(AgentActions.applySkillNotation("$review now\ncost $5\n$tidy", kind: .claude), "/review now\ncost $5\n/tidy")
        XCTAssertEqual(AgentActions.applySkillNotation("$review", kind: .codex), "$review")
        XCTAssertThrowsError(try AgentActions.render(id: "x", displayName: "X", template: "  {{A}}", values: ["A": ""], kind: .claude))
    }
}
