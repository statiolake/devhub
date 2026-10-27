// Port of apps/desktop/src/settings/rules.test.ts and errorMessage.test.ts:
// every rule the window states while typing is run against the real
// validator over a corpus of values, so the two cannot disagree.
import XCTest
@testable import DevHubCore

final class SettingsRulesTests: XCTestCase {
    static let corpus: [String] = [
        "", " ", "a", "abc", "ABC", "Abc", "a-b_c", "a.b", "1abc", "-lead", "_lead", "with space", "~", "~/dev", "~user",
        "/usr/local/bin/git", "x/y", "node_modules", "*.log", "a[1]", "~/YYYY/[DD]", "~/YYYY/[DD", "~/YYYY/DD]", "a{b}",
        "a?b", "a\\b", "VAR_1", "1VAR", "-u", "-2", "-x", String(repeating: "a", count: 64), String(repeating: "a", count: 65),
        "a\u{0}b",
    ]

    let source = FilesystemSource(
        id: "source", path: "~/dev", minDepth: 1, maxDepth: 2, kinds: [.gitRepository], includeHidden: false, excludeNames: [])
    let dated = DateSource(id: "daily", path: "~/workspace/daily/YYYY/MMDD", createIfMissing: true)
    let profile = ConfiguredAgentProfile(id: "agent", displayName: "Agent", kind: .codex, command: "codex", presentation: .tui)

    func base() -> Config {
        var config = Config.defaults
        config.workspaceSources = [.filesystem(source)]
        config.agentProfiles = [profile]
        return config
    }

    func accepted(_ config: Config) -> Bool { (try? ConfigParsing.validate(config)) != nil }

    func agree(_ what: String, _ rule: (String) -> String?, _ place: (String) -> Config, file: StaticString = #filePath, line: UInt = #line) {
        for value in Self.corpus {
            XCTAssertEqual(rule(value) == nil, accepted(place(value)), "\(what): \(value.debugDescription) — \(rule(value) ?? "accepted by the field")", file: file, line: line)
        }
    }

    func testMatchesTheLoaderOnIdentifiers() {
        agree("workspace source id", SettingsRules.idProblem) { id in
            var config = base()
            var changed = source
            changed.id = id
            config.workspaceSources = [.filesystem(changed)]
            return config
        }
        agree("agent profile id", SettingsRules.idProblem) { id in
            var config = base()
            var changed = profile
            changed.id = id
            config.agentProfiles = [changed]
            return config
        }
    }

    func testMatchesTheLoaderOnTheProgramsDevHubRuns() {
        agree("runtimes.shell", SettingsRules.runtimeProblem) { shell in
            var config = base()
            config.runtimes.shell = shell
            return config
        }
    }

    func testMatchesTheLoaderOnTheTmuxSocketName() {
        agree("runtimes.tmux_socket_name", SettingsRules.socketProblem) { name in
            var config = base()
            config.runtimes.tmuxSocketName = name
            return config
        }
    }

    func testMatchesTheLoaderOnAWorkspaceSourcesFolder() {
        agree("workspace source path", SettingsRules.workspacePathProblem) { path in
            var config = base()
            var changed = source
            changed.path = path
            config.workspaceSources = [.filesystem(changed)]
            return config
        }
    }

    func testMatchesTheLoaderOnADatedSourcesFolder() {
        agree("date source path", SettingsRules.dateTemplateProblem) { path in
            var config = base()
            var changed = dated
            changed.path = path
            config.workspaceSources = [.date(changed)]
            return config
        }
    }

    func testMatchesTheLoaderOnTheNamesASourceSkips() {
        agree("exclude name", SettingsRules.excludeNameProblem) { name in
            var config = base()
            var changed = source
            changed.excludeNames = [name]
            config.workspaceSources = [.filesystem(changed)]
            return config
        }
    }

    func testMatchesTheLoaderOnAnAgentProfilesName() {
        agree("display name", SettingsRules.displayNameProblem) { name in
            var config = base()
            var changed = profile
            changed.displayName = name
            config.agentProfiles = [changed]
            return config
        }
    }

    func testMatchesTheLoaderOnEnvironmentVariableNames() {
        agree("environment key", SettingsRules.environmentNameProblem) { key in
            var config = base()
            var changed = profile
            changed.env = OrderedStringMap([(key, "value")])
            config.agentProfiles = [changed]
            return config
        }
    }

    func testMatchesTheLoaderOnArguments() {
        agree("agent argument", SettingsRules.argumentProblem) { argument in
            var config = base()
            var changed = profile
            changed.args = [argument]
            config.agentProfiles = [changed]
            return config
        }
    }

    func testMatchesTheLoaderOnScratchAndTheProjectsFolderAndTheResumeMessage() {
        agree("scratch.daily", SettingsRules.scratchDailyProblem) { daily in
            var config = base()
            config.scratch.daily = daily
            return config
        }
        agree("projects.directory", SettingsRules.projectDirectoryProblem) { directory in
            var config = base()
            config.projects.directory = directory.isEmpty ? nil : directory
            return config
        }
        agree("resume message", SettingsRules.resumeMessageProblem) { message in
            var config = base()
            config.agents.resumeAfterLimitMessage = message
            return config
        }
    }

    func testOffersEverySetOfKindsTheLoaderAcceptsAndNoOther() {
        for choice in SettingsRules.MatchChoice.allCases {
            var config = base()
            var changed = source
            changed.kinds = choice.kinds
            config.workspaceSources = [.filesystem(changed)]
            XCTAssertTrue(accepted(config), choice.rawValue)
            XCTAssertEqual(SettingsRules.MatchChoice.of(choice.kinds), choice)
        }
        var mixed = source
        mixed.kinds = [.directory, .gitRepository]
        var config = base()
        config.workspaceSources = [.filesystem(mixed)]
        XCTAssertFalse(accepted(config))
        XCTAssertFalse(SettingsRules.MatchChoice.allCases.map(\.kinds).contains([.directory, .gitRepository]))
    }

    func testNumbersAndDepthsSayTheirRange() {
        XCTAssertNil(SettingsRules.numberProblem("8", label: "Hide after", min: 0, max: 3600))
        XCTAssertEqual(SettingsRules.numberProblem("x", label: "Hide after", min: 0, max: 3600), "Hide after is a number between 0 and 3600.")
        XCTAssertNotNil(SettingsRules.numberProblem("", label: "L", min: 0.1, max: 20))
        XCTAssertEqual(SettingsRules.numberProblem("30", label: "L", min: 0.1, max: 20), "L is a number between 0.1 and 20.")
        XCTAssertNil(SettingsRules.maxDepthProblem("", minDepth: 2))
        XCTAssertNil(SettingsRules.maxDepthProblem("3", minDepth: 2))
        XCTAssertNotNil(SettingsRules.maxDepthProblem("1", minDepth: 2))
        XCTAssertNotNil(SettingsRules.maxDepthProblem("2.5", minDepth: 2))
    }

    // MARK: errorMessage.test.ts

    func testNamesTheCodeAndStatesARuleForEveryDiagnostic() {
        for code in ValidationCode.allCases {
            XCTAssertFalse(SettingsRules.ruleMessage(code).isEmpty, code.rawValue)
            let message = SettingsRules.Refusal.invalidConfig(ConfigDiagnostic(code: code)).message
            XCTAssertTrue(message.contains(code.rawValue), message)
        }
    }

    func testNamesTheFieldWhenTheDiagnosticCarriesOne() {
        let message = SettingsRules.Refusal.invalidConfig(ConfigDiagnostic(code: .invalidCommand, path: "workspace_sources[0].command")).message
        XCTAssertEqual(
            message,
            "workspace_sources[0].command was not saved. A command source needs at least one argument: the program to run. (invalid_command, workspace_sources[0].command)")
    }

    func testNamesThePositionWhenTheDiagnosticIsAboutTheFile() {
        let message = SettingsRules.fileDiagnosticMessage(ConfigDiagnostic(code: .parse, location: SourceLocation(line: 3, column: 0)))
        XCTAssertTrue(message.hasSuffix("settings.toml is not valid TOML at that point. (parse, line 3, column 0)"), message)
    }

    func testSaysSoWhenThereIsNoDiagnosticAtAll() {
        XCTAssertEqual(
            SettingsRules.Refusal.invalidConfig(nil).message,
            "That change was not saved, and DevHub did not say which value it refused. Please report this.")
        XCTAssertEqual(SettingsRules.Refusal.externalEditConflict.message, "settings.toml changed outside Settings. Reload to see the new file.")
        XCTAssertEqual(SettingsRules.Refusal.of(ConfigError(code: .conflict)), .externalEditConflict)
        XCTAssertEqual(SettingsRules.Refusal.of(ConfigError(code: .io)), .invalidFile)
        XCTAssertEqual(SettingsRules.Refusal.of(InvariantViolation("x")), .nativeUnavailable)
    }
}
