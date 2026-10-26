// Port of apps/desktop/src/model/config.test.ts — "parsing", "round trip",
// "the keyboard, as the file spells it", "where new projects go", "the colour
// theme", "the Agent panes' colours" and "going on after a usage limit".
// The store's tests are in ConfigStoreTests.swift.
import XCTest
@testable import DevHubCore

let MINIMAL = "version = 1\n"
let EMPTY_FONT = "version = 1\n[appearance]\nterminal_font_family = \"\"\n"
let SCHEMA = ConfigConstants.schemaVersion

func configCodeOf(_ run: () throws -> Any) -> ValidationCode? {
    do { _ = try run() } catch let error as ConfigError { return error.code } catch { return nil }
    return nil
}

func configPathOf(_ run: () throws -> Any) -> String? {
    do { _ = try run() } catch let error as ConfigError { return error.diagnostic.path } catch { return nil }
    return nil
}

func parseConfig(_ text: String) throws -> Config { try ConfigParsing.parse(text) }
func configToToml(_ config: Config) throws -> String { try ConfigParsing.toToml(config) }
func configOntoDocument(_ source: String, _ config: Config) throws -> String { try ConfigParsing.ontoDocument(source, config) }
func configLines(_ parts: String...) -> String { parts.joined(separator: "\n") }

final class ConfigParsingTests: XCTestCase {
    func testFillsEverySectionFromDefaultsWhenOnlyTheVersionIsPresent() throws {
        XCTAssertEqual(try parseConfig(MINIMAL), Config.defaults)
    }

    func testClosesAnAwayEditorAfter10MinutesUnlessToldOtherwise() throws {
        XCTAssertEqual(try parseConfig(MINIMAL).general.workbenchHibernateMinutes, 10)
        XCTAssertEqual(try parseConfig(MINIMAL).general.workbenchAwakeMax, 2)
        XCTAssertEqual(try parseConfig("version = 1\n[general]\nworkbench_hibernate_minutes = 0\n").general.workbenchHibernateMinutes, 0)
        XCTAssertEqual(configPathOf { try parseConfig("version = 1\n[general]\nworkbench_hibernate_minutes = -1\n") }, "general.workbench_hibernate_minutes")
    }

    func testLeavesARowAtTheFontsOwnLineBox() throws {
        XCTAssertEqual(try parseConfig(MINIMAL).appearance.terminalLineHeight, 1)
        XCTAssertEqual(Config.defaults.appearance.terminalLineHeight, 1)
    }

    func testOffersTheThreeAgentsDevHubKnowsHowToStart() {
        let profiles = Config.defaults.agentProfiles.map { [$0.id, $0.kind.rawValue, $0.command] }
        XCTAssertEqual(profiles, [["codex", "codex", "codex"], ["claude", "claude", "claude"], ["cursor", "cursor", "cursor-agent"]])
    }

    func testReadsADatedSourceAndDefaultsItToOfferingTodayBeforeItExists() throws {
        let source = configLines("version = 1", "", "[[workspace_sources]]", #"type = "date""#, #"id = "daily""#, #"path = "~/workspace/daily/YYYY/MMDD""#, "")
        XCTAssertEqual(try parseConfig(source).workspaceSources, [.date(DateSource(id: "daily", path: "~/workspace/daily/YYYY/MMDD", createIfMissing: true))])
        XCTAssertEqual(try parseConfig(configToToml(parseConfig(source))), try parseConfig(source))
    }

    func testRefusesADatedSourceWhoseBracketsDoNotClose() {
        let source = configLines("version = 1", "", "[[workspace_sources]]", #"type = "date""#, #"id = "daily""#, #"path = "~/[YYYY""#, "")
        XCTAssertEqual(configCodeOf { try parseConfig(source) }, .invalidDateTemplate)
    }

    func testRefusesADatedSourceWhoseFolderNameWouldExpand() {
        let source = configLines("version = 1", "", "[[workspace_sources]]", #"type = "date""#, #"id = "daily""#, #"path = "~/Documents/summaries/YYYY""#, "")
        XCTAssertEqual(configCodeOf { try parseConfig(source) }, .ambiguousDateToken)
        let at = configPathOf { try parseConfig(source) } ?? ""
        XCTAssertTrue(at.contains(#"source "daily""#))
        XCTAssertTrue(at.contains(#"the segment "summaries""#))
        XCTAssertTrue(at.contains("date token mm"))
        XCTAssertTrue(at.contains("[summaries]"))
    }

    func testTakesADatedSourceThatSaysWhichPartsAreText() {
        func dated(_ path: String) -> String {
            configLines("version = 1", "", "[[workspace_sources]]", #"type = "date""#, #"id = "daily""#, "path = \"\(path)\"", "")
        }
        for path in ["~/Documents/[summaries]/YYYY", "~/YYYY-MM-DD", "~/workspace/daily/YYYY/MMDD"] {
            XCTAssertNoThrow(try parseConfig(dated(path)))
        }
        XCTAssertEqual(configCodeOf { try parseConfig(dated("~/logsYYYY")) }, .ambiguousDateToken)
    }

    func testShipsOneActionPerThingThatCanFireOne() throws {
        let actions = try parseConfig(MINIMAL).agentActions
        XCTAssertEqual(actions.map(\.id), [
            "issue_assignment", "commit_changes", "push_commits", "open_pull_request",
            "ready_draft_pull_request", "address_review_comments", "fix_ci", "send_ok",
        ])
        for action in actions {
            XCTAssertFalse(action.displayName.isEmpty)
            XCTAssertFalse(action.template.isEmpty)
        }
    }

    func testAddsTheFilesActionsToTheOnesDevHubShips() throws {
        let source = configLines(
            "version = 1", "", "[agent_actions.issue.implement]", #"display_name = "Work on it""#, #"template = "read {{ISSUE_URL}}""#, "",
            "[agent_actions.issue.review]", #"display_name = "Review it""#, #"template = "review {{ISSUE_URL}}""#, ""
        )
        XCTAssertEqual(try parseConfig(source).agentActions.map(\.displayName), [
            "Work on the Issue", "Work on it", "Review it", "Commit the changes", "Push the commits",
            "Open a pull request", "Get the draft PR ready", "Address review comments", "Fix CI", "OK",
        ])
        XCTAssertEqual(try parseConfig(configToToml(parseConfig(source))), try parseConfig(source))
    }

    func testSendsTheSmartButtonsWithoutAReviewSheet() {
        let confirms = Dictionary(uniqueKeysWithValues: Config.defaults.agentActions.map { ($0.id, $0.confirmBeforeSend) })
        XCTAssertEqual(confirms, [
            "issue_assignment": true, "commit_changes": false, "push_commits": false, "open_pull_request": false,
            "ready_draft_pull_request": false, "address_review_comments": false, "fix_ci": false, "send_ok": false,
        ])
    }

    func testReadsAnUntouchedBuiltInsStoredTrueAsTheOldDefault() throws {
        let source = configLines("version = 1", "", "[agent_actions.commit.commit_changes]", #"display_name = "Commit the changes""#, "confirm_before_send = true", "")
        let config = try parseConfig(source)
        XCTAssertEqual(config.agentActions.first { $0.id == "commit_changes" }?.confirmBeforeSend, false)
        XCTAssertEqual(config.version, SCHEMA)
    }

    func testLeavesAStoredTrueAloneOnceTheFileIsInTheNewShape() throws {
        let source = configLines("version = \(JSString.number(SCHEMA))", "", "[agent_actions.commit.commit_changes]", "confirm_before_send = true", "")
        XCTAssertEqual(try parseConfig(source).agentActions.first { $0.id == "commit_changes" }?.confirmBeforeSend, true)
    }

    func testLeavesAStoredTrueAloneOnABuiltInSomebodyHasReworded() throws {
        let source = configLines("version = 1", "", "[agent_actions.commit.commit_changes]", #"template = "commit it my way""#, "confirm_before_send = true", "")
        XCTAssertEqual(try parseConfig(source).agentActions.first { $0.id == "commit_changes" }?.confirmBeforeSend, true)
    }

    func testLeavesAStoredTrueAloneOnAnActionSomebodyWrote() throws {
        let source = configLines("version = 1", "", "[agent_actions.commit.commit_in_pieces]", #"display_name = "Commit in pieces""#, #"template = "commit it in pieces""#, "confirm_before_send = true", "")
        XCTAssertEqual(try parseConfig(source).agentActions.first { $0.id == "commit_in_pieces" }?.confirmBeforeSend, true)
    }

    func testKeepsTheIssueActionsSheet() throws {
        let source = configLines("version = 1", "", "[agent_actions.issue.issue_assignment]", "confirm_before_send = true", "")
        XCTAssertEqual(try parseConfig(source).agentActions.first { $0.id == "issue_assignment" }?.confirmBeforeSend, true)
    }

    func testTakesTheFilesWordAboutAnActionDevHubShips() throws {
        let source = configLines("version = 1", "", "[agent_actions.commit.commit_changes]", #"template = "commit it""#, "confirm_before_send = false", "")
        let action = try parseConfig(source).agentActions.first { $0.id == "commit_changes" }
        XCTAssertEqual(action?.template, "commit it")
        XCTAssertEqual(action?.confirmBeforeSend, false)
        XCTAssertEqual(action?.displayName, "Commit the changes")
    }

    func testTakesAnActionAwayOnlyWhenTheFileSaysSo() throws {
        let source = configLines("version = 1", "", "[agent_actions.push.push_commits]", "enabled = false", "")
        let actions = try parseConfig(source).agentActions
        XCTAssertTrue(actions.map(\.id).contains("push_commits"))
        XCTAssertEqual(actions.first { $0.id == "push_commits" }?.enabled, false)
    }

    func testReadsTheSmartButtonTriggersAndWhetherEachActionIsAButton() throws {
        let source = configLines(
            "version = 3", "", "[agent_actions.ci_failing.fix_ci]", "button = false", "",
            "[agent_actions.unresolved_review_comments.answer_reviewers]", #"display_name = "Answer the reviewers""#,
            #"template = "{{PR_URL}} has {{UNRESOLVED}} open threads""#, ""
        )
        let config = try parseConfig(source)
        let fix = config.agentActions.first { $0.id == "fix_ci" }!
        XCTAssertEqual(fix.trigger, .ciFailing)
        XCTAssertFalse(fix.button)
        XCTAssertFalse(fix.confirmBeforeSend)
        let answer = config.agentActions.first { $0.id == "answer_reviewers" }!
        XCTAssertEqual(answer.trigger, .unresolvedReviewComments)
        XCTAssertTrue(answer.button)
        XCTAssertTrue(answer.confirmBeforeSend)
        for action in Config.defaults.agentActions { XCTAssertEqual(action.button, action.trigger != .issue) }
        XCTAssertEqual(try parseConfig(configToToml(config)), config)
    }

    func testRefusesButtonOnAnIssueAction() {
        let source = configLines("version = 3", "", "[agent_actions.issue.issue_assignment]", "button = true", "")
        XCTAssertEqual(configPathOf { try parseConfig(source) }, "agent_actions.issue.issue_assignment.button")
    }

    func testRefusesATriggerDevHubHasNoRuleFor() {
        let source = configLines("version = 3", "", "[agent_actions.deploy.ship_it]", #"display_name = "Ship it""#, #"template = "ship""#, "")
        XCTAssertNotNil(configCodeOf { try parseConfig(source) })
        XCTAssertEqual(configPathOf { try parseConfig(source) }, "agent_actions.deploy")
    }

    func testPutsASecondActionUnderATriggerAfterTheOneDevHubShips() throws {
        let source = configLines("version = 1", "", "[agent_actions.commit.commit_in_pieces]", #"display_name = "Commit in pieces""#, #"template = "commit each change on its own""#, "")
        XCTAssertEqual(try parseConfig(source).agentActions.filter { $0.trigger == .commit }.map(\.id), ["commit_changes", "commit_in_pieces"])
    }

    func testOrdersATriggersActionsTheWayTheFileAsks() throws {
        let source = configLines("version = 1", "", "[agent_actions.commit.commit_in_pieces]", #"display_name = "Commit in pieces""#, #"template = "one at a time""#, "order = -1", "")
        XCTAssertEqual(try parseConfig(source).agentActions.filter { $0.trigger == .commit }.map(\.id), ["commit_in_pieces", "commit_changes"])
    }

    func testReadsAFileWrittenInTheOldArrayShapeAndRestoresWhatItDropped() throws {
        let source = configLines("version = 1", "", "[[agent_actions]]", #"id = "issue_assignment""#, #"display_name = "Work on the Issue""#, #"template = "mine, edited""#, "")
        let actions = try parseConfig(source).agentActions
        XCTAssertEqual(actions.map(\.id), [
            "issue_assignment", "commit_changes", "push_commits", "open_pull_request",
            "ready_draft_pull_request", "address_review_comments", "fix_ci", "send_ok",
        ])
        let issue = actions.first { $0.id == "issue_assignment" }
        XCTAssertEqual(issue?.template, "mine, edited")
        XCTAssertEqual(issue?.trigger, .issue)
        XCTAssertEqual(actions.first { $0.id == "push_commits" }?.trigger, .push)
        XCTAssertTrue(try configToToml(parseConfig(source)).contains("[agent_actions.commit.commit_changes]"))
    }

    func testRefusesTwoActionsWithOneIdentifier() {
        let source = configLines(
            "version = 1", "", "[agent_actions.issue.same]", #"display_name = "One""#, #"template = "a""#, "",
            "[agent_actions.commit.same]", #"display_name = "Two""#, #"template = "b""#, ""
        )
        XCTAssertEqual(configCodeOf { try parseConfig(source) }, .duplicateIdentity)
    }

    func testRefusesAnActionWithNoNameToShow() {
        let source = configLines("version = 1", "", "[[agent_actions]]", #"id = "nameless""#, #"display_name = "  ""#, #"template = "a""#, "")
        XCTAssertEqual(configCodeOf { try parseConfig(source) }, .invalidProfile)
    }

    func testRefusesAnUnknownKeyRatherThanIgnoringATypo() {
        XCTAssertEqual(configCodeOf { try parseConfig("version = 1\nnonsense = true\n") }, .unknownKey)
        XCTAssertEqual(configCodeOf { try parseConfig("version = 1\n[general]\nnope = true\n") }, .unknownKey)
        XCTAssertEqual(configCodeOf { try parseConfig("version = 1\n[appearance.terminal_theme.light]\nnope = 1\n") }, .unknownKey)
    }

    func testStillLoadsAFileWithARetiredKeyAndNamesIt() throws {
        let retired = "version = 1\n[appearance]\ncolor_scheme = \"dark\"\n"
        XCTAssertEqual(try parseConfig(retired), Config.defaults)
        let notices = ConfigParsing.retiredKeysIn(try ConfigParsing.parseText(retired))
        XCTAssertEqual(notices.map(\.key), ["appearance.color_scheme"])
        XCTAssertFalse(notices[0].replacement.isEmpty)
        XCTAssertEqual(ConfigParsing.retiredKeysIn(try ConfigParsing.parseText("version = 1\n")), [])
        XCTAssertFalse(try configOntoDocument(retired, parseConfig(retired)).contains("color_scheme"))
    }

    func testRefusesAVersionItDoesNotImplement() {
        XCTAssertEqual(configCodeOf { try parseConfig("version = \(JSString.number(SCHEMA + 1))\n") }, .unsupportedVersion)
    }

    func testReportsASyntaxErrorAsAParseDiagnostic() {
        XCTAssertEqual(configCodeOf { try parseConfig("version = \n") }, .parse)
        do {
            _ = try parseConfig("version = \n")
        } catch let error as ConfigError {
            XCTAssertEqual(error.diagnostic.location, SourceLocation(line: 2, column: 0))
        } catch { XCTFail("\(error)") }
    }

    func testRejectsARuntimeThatIsNeitherAPathNorABareCommandName() throws {
        XCTAssertEqual(configCodeOf { try parseConfig("version = 1\n[runtimes]\nshell = \"bin/zsh\"\n") }, .invalidRuntime)
        XCTAssertEqual(try parseConfig("version = 1\n[runtimes]\nshell = \"~/bin/zsh\"\n").runtimes.shell, "~/bin/zsh")
    }

    func testAllowsOnlyTheTwoTmuxArgumentsThatCannotChangeTargeting() {
        XCTAssertTrue(ConfigParsing.isSafeTmuxArgument("-u"))
        XCTAssertTrue(ConfigParsing.isSafeTmuxArgument("-2"))
        XCTAssertFalse(ConfigParsing.isSafeTmuxArgument("-L"))
        XCTAssertEqual(configCodeOf { try parseConfig("version = 1\n[runtimes]\ntmux_args = [\"-L\", \"other\"]\n") }, .forbiddenTmuxArgument)
    }

    func testValidatesTheSocketNameCharacterSet() {
        XCTAssertTrue(ConfigParsing.isValidSocketName("devhub"))
        XCTAssertFalse(ConfigParsing.isValidSocketName("dev/hub"))
        XCTAssertFalse(ConfigParsing.isValidSocketName(""))
    }

    func testRejectsAppearanceValuesOutsideTheSupportedRange() {
        XCTAssertEqual(configCodeOf { try parseConfig("version = 1\n[appearance]\nterminal_font_size = 40\n") }, .invalidAppearance)
        XCTAssertEqual(configCodeOf { try parseConfig("version = 1\n[appearance]\nsidebar_density = \"roomy\"\n") }, .invalidAppearance)
        XCTAssertEqual(configCodeOf { try parseConfig("version = 1\n[appearance]\nmode = \"midnight\"\n") }, .invalidAppearance)
        XCTAssertEqual(configCodeOf { try parseConfig("version = 1\n[appearance]\ntitle_bar = \"floating\"\n") }, .invalidAppearance)
    }

    func testTitleBarIsShownUnlessTheFileSaysOtherwise() throws {
        XCTAssertEqual(Config.defaults.appearance.titleBar, "shown")
        XCTAssertEqual(try parseConfig("version = 1\n").appearance.titleBar, "shown")
    }

    func testTitleBarIsReadKeptAndWrittenBack() throws {
        let config = try parseConfig("version = 1\n[appearance]\ntitle_bar = \"hidden\"\n")
        XCTAssertEqual(config.appearance.titleBar, "hidden")
        XCTAssertTrue(try configToToml(config).contains(#"title_bar = "hidden""#))
    }

    func testTitleBarIsReadableOnItsOwn() {
        XCTAssertEqual(ConfigParsing.titleBarMode(in: nil), .shown)
        XCTAssertEqual(ConfigParsing.titleBarMode(in: "version = 1\n"), .shown)
        XCTAssertEqual(ConfigParsing.titleBarMode(in: "version = 1\n[appearance]\ntitle_bar = \"hidden\"\n"), .hidden)
        XCTAssertEqual(ConfigParsing.titleBarMode(in: "version = 1\n[appearance]\ntitle_bar = \"shown\"\n"), .shown)
        XCTAssertEqual(ConfigParsing.titleBarMode(in: "this is not toml = = ="), .shown)
        XCTAssertEqual(ConfigParsing.titleBarMode(in: "[appearance]\ntitle_bar = 7\n"), .shown)
    }

    func testWorkbenchIsVSCodeUnlessTheFileSaysOtherwise() throws {
        XCTAssertEqual(Config.defaults.general.workbench, "vscode")
        XCTAssertEqual(try parseConfig(MINIMAL).general.workbench, "vscode")
    }

    func testWorkbenchIsReadKeptAndWrittenBack() throws {
        let config = try parseConfig("version = 1\n[general]\nworkbench = \"terminal\"\n")
        XCTAssertEqual(config.general.workbench, "terminal")
        XCTAssertTrue(try configToToml(config).contains(#"workbench = "terminal""#))
    }

    func testWorkbenchRefusesAnythingButTheTwoModes() {
        let text = "version = 1\n[general]\nworkbench = \"neovim\"\n"
        XCTAssertEqual(configCodeOf { try parseConfig(text) }, .invalidWorkbench)
        XCTAssertEqual(configPathOf { try parseConfig(text) }, "general.workbench")
        XCTAssertEqual(configCodeOf { try parseConfig("version = 1\n[general]\nworkbench = 1\n") }, .invalidType)
    }

    func testWorkbenchIsReadableOnItsOwn() {
        XCTAssertEqual(ConfigParsing.workbenchMode(in: nil), .vscode)
        XCTAssertEqual(ConfigParsing.workbenchMode(in: MINIMAL), .vscode)
        XCTAssertEqual(ConfigParsing.workbenchMode(in: "version = 1\n[general]\nworkbench = \"terminal\"\n"), .terminal)
        XCTAssertEqual(ConfigParsing.workbenchMode(in: "this is not toml = = ="), .vscode)
        XCTAssertEqual(ConfigParsing.workbenchMode(in: "[general]\nworkbench = \"emacs\"\n"), .vscode)
    }

    func testScrollsAnAgentPaneThreeLinesANotchUntilToldOtherwise() throws {
        XCTAssertEqual(Config.defaults.appearance.terminalScrollSensitivity, 3)
        let parsed = try parseConfig("version = 1\n[appearance]\nterminal_scroll_sensitivity = 5.5\n")
        XCTAssertEqual(parsed.appearance.terminalScrollSensitivity, 5.5)
        XCTAssertTrue(try configOntoDocument("version = 1\n", parsed).contains("terminal_scroll_sensitivity = 5.5"))
        for value in ["0", "-2", "1000"] {
            XCTAssertEqual(configCodeOf { try parseConfig("version = 1\n[appearance]\nterminal_scroll_sensitivity = \(value)\n") }, .invalidAppearance)
        }
    }

    func testCarriesTheThreeAppearancesAndDefaultsToFollowingTheOS() throws {
        XCTAssertEqual(Config.defaults.appearance.mode, "auto")
        for mode in ["auto", "light", "dark"] {
            let parsed = try parseConfig("version = 1\n[appearance]\nmode = \"\(mode)\"\n")
            XCTAssertEqual(parsed.appearance.mode, mode)
            XCTAssertTrue(try configOntoDocument("version = 1\n", parsed).contains("mode = \"\(mode)\""))
        }
    }

    func testKeepsTheRetiredColourSchemeRetired() throws {
        let text = "version = 1\n[appearance]\ncolor_scheme = \"dark\"\n"
        XCTAssertEqual(try parseConfig(text).appearance.mode, "auto")
        XCTAssertTrue(ConfigParsing.retiredKeysIn(try ConfigParsing.parseText(text))[0].replacement.contains("appearance.mode"))
    }

    func testTakesAnyFontFamilyCSSWouldTake() throws {
        for family in ["Menlo", "SF Mono", "JetBrains Mono, Menlo, monospace", "\"Fira Code\"", "ui-monospace"] {
            XCTAssertTrue(FontFamily.isValid(family))
            let document = "version = 1\n[appearance]\nterminal_font_family = \(TomlDocument.renderString(family))\n"
            XCTAssertEqual(try parseConfig(document).appearance.terminalFontFamily, family)
        }
    }

    func testNamesTheFontFamilyItselfWhenItIsTheValueThatIsWrong() {
        XCTAssertEqual(configCodeOf { try parseConfig(EMPTY_FONT) }, .invalidFontFamily)
        XCTAssertEqual(configPathOf { try parseConfig(EMPTY_FONT) }, "appearance.terminal_font_family")
        XCTAssertFalse(FontFamily.isValid(""))
        XCTAssertFalse(FontFamily.isValid("   "))
        XCTAssertFalse(FontFamily.isValid("Men\u{0}lo"))
        XCTAssertFalse(FontFamily.isValid(String(repeating: "M", count: FontFamily.maxLength + 1)))
        XCTAssertTrue(FontFamily.isValid(String(repeating: "M", count: FontFamily.maxLength)))
    }

    func testRejectsADuplicateIdentityInEitherArray() {
        let sources = configLines(
            "version = 1", "[[workspace_sources]]", #"type = "command""#, #"id = "one""#, #"command = ["a"]"#,
            "[[workspace_sources]]", #"type = "command""#, #"id = "one""#, #"command = ["b"]"#, ""
        )
        XCTAssertEqual(configCodeOf { try parseConfig(sources) }, .duplicateIdentity)
        XCTAssertEqual(configPathOf { try parseConfig(sources) }, "workspace_sources[1].id (also 0)")
    }

    func testRejectsAFilesystemSourceThatMixesDirectoryAndGitKinds() {
        let source = configLines("version = 1", "[[workspace_sources]]", #"type = "filesystem""#, #"id = "mixed""#, #"path = "~/dev""#, #"kinds = ["directory", "git_repository"]"#, "")
        XCTAssertEqual(configCodeOf { try parseConfig(source) }, .invalidWorkspaceKind)
    }

    func testRejectsAnEnvironmentKeyThatIsNotAnEnvironmentName() {
        let profile = configLines("version = 1", "[[agent_profiles]]", #"id = "codex""#, #"display_name = "Codex""#, #"kind = "codex""#, "[agent_profiles.env]", #""not a name" = "x""#, "")
        XCTAssertEqual(configCodeOf { try parseConfig(profile) }, .invalidEnvironmentKey)
    }
}

final class ConfigRoundTripTests: XCTestCase {
    func testReParsesToTheSameConfig() throws {
        XCTAssertEqual(try parseConfig(configToToml(Config.defaults)), Config.defaults)
    }

    func testEmptiesACollectionAndFillsItAgain() throws {
        var withSources = Config.defaults
        withSources.workspaceSources = [
            .filesystem(FilesystemSource(id: "dev", path: "~/dev", minDepth: 1, maxDepth: 2, kinds: [.gitRepository], includeHidden: false, excludeNames: [])),
            .date(DateSource(id: "daily", path: "~/daily/YYYY/MMDD", createIfMissing: true)),
        ]
        let full = try configToToml(withSources)
        let config = try parseConfig(full)
        XCTAssertFalse(config.workspaceSources.isEmpty)

        var emptiedConfig = config
        emptiedConfig.workspaceSources = []
        let emptied = try configOntoDocument(full, emptiedConfig)
        XCTAssertFalse(emptied.contains("[[workspace_sources]]"))
        XCTAssertEqual(try parseConfig(emptied).workspaceSources, [])
        XCTAssertEqual(try parseConfig(emptied).agentProfiles, config.agentProfiles)

        var refilledConfig = try parseConfig(emptied)
        refilledConfig.workspaceSources = config.workspaceSources
        XCTAssertEqual(try parseConfig(configOntoDocument(emptied, refilledConfig)), config)
    }

    func testDefaultsACursorProfileToCursorAgentNotCursor() throws {
        let source = configLines("version = 1", "", "[[agent_profiles]]", #"id = "cursor""#, #"display_name = "Cursor""#, #"kind = "cursor""#, "args = []", "", "[agent_profiles.env]", "")
        let parsed = try parseConfig(source)
        XCTAssertEqual(parsed.agentProfiles.first?.kind, .cursor)
        XCTAssertEqual(parsed.agentProfiles.first?.command, "cursor-agent")
    }

    func testLetsACursorProfileNameItsOwnCommand() throws {
        let source = configLines("version = 1", "", "[[agent_profiles]]", #"id = "cursor""#, #"display_name = "Cursor""#, #"kind = "cursor""#, #"command = "/opt/example/cursor-agent""#, "args = []", "", "[agent_profiles.env]", "")
        XCTAssertEqual(try parseConfig(source).agentProfiles.first?.command, "/opt/example/cursor-agent")
    }

    func testStillAcceptsACursorProfileLeftOnTheCustomKind() throws {
        let source = configLines("version = 1", "", "[[agent_profiles]]", #"id = "cursor""#, #"display_name = "Cursor""#, #"kind = "custom""#, #"command = "cursor-agent""#, "args = []", "", "[agent_profiles.env]", "")
        let parsed = try parseConfig(source)
        XCTAssertEqual(parsed.agentProfiles.first?.kind, .custom)
        XCTAssertEqual(parsed.agentProfiles.first?.command, "cursor-agent")
    }

    // MARK: a profile's presentation

    func profile(_ kind: String, _ presentation: String? = nil) -> String {
        var parts = ["version = 1", "", "[[agent_profiles]]", #"id = "agent""#, #"display_name = "Agent""#, "kind = \"\(kind)\""]
        if let presentation { parts.append("presentation = \"\(presentation)\"") }
        parts += ["", "[agent_profiles.env]", ""]
        return parts.joined(separator: "\n")
    }

    func current(_ source: String) -> String { source.replacingOccurrences(of: "version = 1", with: "version = 3") }

    func effective(_ source: String) throws -> AgentPresentation {
        let config = try parseConfig(source)
        return profilePresentation(config.agentProfiles[0], agents: config.agents)
    }

    func testPresentationFollowsTheAppWideDefaultWhenTheFileDoesNotSay() throws {
        XCTAssertNil(try parseConfig(current(profile("claude"))).agentProfiles.first?.presentation)
        XCTAssertEqual(try effective(current(profile("claude"))), .tui)
        let gui = current(profile("claude")).replacingOccurrences(of: "version = 3", with: "version = 3\n[agents]\ndefault_presentation = \"gui\"")
        XCTAssertEqual(try effective(gui), .gui)
    }

    func testPresentationIsATerminalForAKindWithoutAGUI() throws {
        let source = current(profile("cursor")).replacingOccurrences(of: "version = 3", with: "version = 3\n[agents]\ndefault_presentation = \"gui\"")
        XCTAssertEqual(try effective(source), .tui)
    }

    func testPresentationOverridesTheAppWideDefaultWhenTheProfileSays() throws {
        let source = current(profile("codex", "tui")).replacingOccurrences(of: "version = 3", with: "version = 3\n[agents]\ndefault_presentation = \"gui\"")
        XCTAssertEqual(try effective(source), .tui)
    }

    func testRefusesAnAppWideDefaultThatIsNeither() {
        let source = "version = 3\n[agents]\ndefault_presentation = \"sideways\"\n"
        XCTAssertEqual(configCodeOf { try parseConfig(source) }, .invalidProfile)
        XCTAssertEqual(configPathOf { try parseConfig(source) }, "agents.default_presentation")
    }

    func testTakesTheTuiEveryOlderFileWroteForTheDefaultItWasOnce() throws {
        let old = profile("claude", "tui").replacingOccurrences(of: "version = 1", with: "version = 2\n[agents]\ndefault_presentation = \"gui\"")
        XCTAssertNil(try parseConfig(old).agentProfiles.first?.presentation)
        XCTAssertEqual(try effective(old), .gui)
        XCTAssertEqual(try parseConfig(profile("claude", "gui")).agentProfiles.first?.presentation, .gui)
        let saved = try configOntoDocument(old, parseConfig(old))
        XCTAssertTrue(saved.contains("version = \(JSString.number(SCHEMA))"))
        XCTAssertFalse(saved.contains(#"presentation = "tui""#))
    }

    func testWritesTheAppWideDefaultAndNoPresentationForAProfileThatFollowsIt() throws {
        let source = current(profile("codex"))
        var config = try parseConfig(source)
        config.agents.defaultPresentation = .gui
        let saved = try configOntoDocument(source, config)
        XCTAssertTrue(saved.contains(#"default_presentation = "gui""#))
        XCTAssertFalse(saved.components(separatedBy: "\n").contains { $0.hasPrefix("presentation = ") })
        XCTAssertEqual(try effective(saved), .gui)
    }

    func testIsGUIWhenAClaudeOrCodexProfileAsksForIt() throws {
        XCTAssertEqual(try parseConfig(profile("claude", "gui")).agentProfiles.first?.presentation, .gui)
        XCTAssertEqual(try parseConfig(profile("codex", "gui")).agentProfiles.first?.presentation, .gui)
    }

    func testRefusesGUIOnACursorOrCustomProfile() {
        for kind in ["cursor", "custom"] {
            let source = kind == "custom"
                ? profile(kind, "gui").replacingOccurrences(of: #"presentation = "gui""#, with: "command = \"my-agent\"\npresentation = \"gui\"")
                : profile(kind, "gui")
            XCTAssertEqual(configCodeOf { try parseConfig(source) }, .invalidProfile, kind)
            XCTAssertEqual(configPathOf { try parseConfig(source) }, "agent_profiles[0].presentation", kind)
        }
    }

    func testRefusesAPresentationThatIsNeither() {
        let source = profile("claude", "sideways")
        XCTAssertEqual(configCodeOf { try parseConfig(source) }, .invalidProfile)
        XCTAssertEqual(configPathOf { try parseConfig(source) }, "agent_profiles[0].presentation")
    }

    func testRefusesAPresentationThatIsNotAString() {
        let source = profile("claude").replacingOccurrences(of: #"kind = "claude""#, with: "kind = \"claude\"\npresentation = true")
        XCTAssertEqual(configCodeOf { try parseConfig(source) }, .invalidType)
        XCTAssertEqual(configPathOf { try parseConfig(source) }, "agent_profiles[0].presentation")
    }

    func testPresentationIsWrittenBackAndReadBackTheSame() throws {
        let source = profile("codex")
        var config = try parseConfig(source)
        config.agentProfiles = config.agentProfiles.map { var one = $0; one.presentation = .gui; return one }
        let saved = try configOntoDocument(source, config)
        XCTAssertTrue(saved.contains(#"presentation = "gui""#))
        XCTAssertEqual(try parseConfig(saved).agentProfiles.first?.presentation, .gui)
    }

    func testPresentationIsNotWrittenAsGUIForAKindThatHasNone() throws {
        let source = profile("cursor")
        var config = try parseConfig(source)
        config.agentProfiles = config.agentProfiles.map { var one = $0; one.presentation = .gui; return one }
        XCTAssertEqual(configCodeOf { try configOntoDocument(source, config) }, .invalidProfile)
    }

    // MARK: saving over documents

    func testSwitchesAProfileToACustomRuntimeAndStillReParses() throws {
        let source = configLines(
            "version = 1", "", "[[agent_profiles]]", #"id = "codex""#, #"display_name = "Codex""#, #"kind = "codex""#, "args = []", "",
            "[agent_profiles.env]", "", "[[agent_profiles]]", #"id = "claude""#, #"display_name = "Claude""#, #"kind = "claude""#,
            "args = []", "", "[agent_profiles.env]", ""
        )
        var config = try parseConfig(source)
        config.agentProfiles = config.agentProfiles.map { profile in
            guard profile.id == "claude" else { return profile }
            var changed = profile
            changed.kind = .custom
            changed.command = "my-agent"
            return changed
        }
        let reparsed = try parseConfig(configOntoDocument(source, config))
        XCTAssertEqual(reparsed.agentProfiles.map(\.kind), [.codex, .custom])
        XCTAssertEqual(reparsed.agentProfiles[1].command, "my-agent")
    }

    func testSavesEveryFieldOfHandWrittenProfilesThatHaveNoEnvTable() throws {
        let source = configLines(
            "version = 1", "", "# mine", "[[agent_profiles]]", #"id = "codex""#, #"display_name = "Codex""#, #"kind = "codex""#, "",
            "[[agent_profiles]]", #"id = "claude""#, #"display_name = "Claude""#, #"kind = "claude""#, "",
            "[scratch]", #"daily = "~/work/YYYYMMDD""#, ""
        )
        var config = try parseConfig(source)
        let edited = [
            ConfiguredAgentProfile(
                id: "codex", displayName: "Codex, edited", kind: .claude, command: "/opt/example/claude",
                args: ["--verbose", "--model", "example"], env: ["EXAMPLE_TOKEN": "dummy", "OTHER": "2"], presentation: .gui
            ),
            ConfiguredAgentProfile(id: "claude", displayName: "Claude", kind: .custom, command: "my-agent", args: [], env: ["ONLY_THE_SECOND": "yes"], presentation: .tui),
        ]
        config.agentProfiles = edited
        let saved = try configOntoDocument(source, config)
        XCTAssertNil(saved.range(of: #"agent_profiles\.\d"#, options: .regularExpression))
        let reparsed = try parseConfig(saved)
        XCTAssertEqual(reparsed.agentProfiles, edited)
        XCTAssertEqual(reparsed.scratch.daily, "~/work/YYYYMMDD")
        XCTAssertTrue(saved.contains("# mine"))
        XCTAssertEqual(try configOntoDocument(saved, reparsed), saved)
    }

    func testSavesADocumentItDidNotChangeBackByteForByte() throws {
        let full = try configToToml(Config.defaults)
        XCTAssertEqual(try configOntoDocument(full, parseConfig(full)), full)
    }

    func testEmptiesEveryCollectionAtOnceAndStillReParses() throws {
        let full = try configToToml(Config.defaults)
        var config = try parseConfig(full)
        config.workspaceSources = []
        config.agentProfiles = []
        let reparsed = try parseConfig(configOntoDocument(full, config))
        XCTAssertEqual(reparsed.workspaceSources, [])
        XCTAssertEqual(reparsed.agentProfiles, [])
    }

    func testRemovesTheTableOfAnActionThatIsNoLongerInTheModel() throws {
        let source = configLines(
            "version = 1", "", "# why this one exists", "[agent_actions.issue.mine]", #"display_name = "Mine""#,
            #"template = "do it""#, "confirm_before_send = true", "enabled = true", "order = 1", ""
        )
        var config = try parseConfig(source)
        let original = config.agentActions
        config.agentActions = config.agentActions.map { var one = $0; if one.id == "mine" { one.id = "renamed" }; return one }
        let written = try configOntoDocument(source, config)
        XCTAssertEqual(try parseConfig(written).agentActions.map(\.id), original.map { $0.id == "mine" ? "renamed" : $0.id })
        XCTAssertFalse(written.contains("[agent_actions.issue.mine]"))
        XCTAssertFalse(written.contains("# why this one exists"))
    }

    func testKeepsTheRestOfTheFileWhenAStaleActionsTableGoes() throws {
        let source = configLines(
            "# my configuration", "version = 1", "", "[appearance]", "# I like it large", "terminal_font_size = 19", "",
            "[agent_actions.issue.gone]", #"display_name = "Gone""#, #"template = "x""#, "confirm_before_send = true", "enabled = true", "order = 9", ""
        )
        var config = try parseConfig(source)
        config.agentActions.removeAll { $0.id == "gone" }
        let written = try configOntoDocument(source, config)
        XCTAssertTrue(written.contains("# my configuration"))
        XCTAssertTrue(written.contains("# I like it large"))
        XCTAssertTrue(written.contains("terminal_font_size = 19"))
        XCTAssertFalse(written.contains("[agent_actions.issue.gone]"))
        XCTAssertEqual(try parseConfig(written).appearance.terminalFontSize, 19)
    }

    func testRoundTripsAFileWhoseActionIdsAreHandWrittenSlugs() throws {
        let source = configLines(
            "version = 1", "", "[agent_actions.issue.implement]", #"display_name = "Work on it""#, #"template = "implement {{ISSUE_URL}}""#,
            "confirm_before_send = true", "enabled = true", "order = 0", "", "[agent_actions.issue.review]", #"display_name = "Review it""#,
            #"template = "review {{ISSUE_URL}}""#, "confirm_before_send = true", "enabled = true", "order = 1", ""
        )
        let config = try parseConfig(source)
        let written = try configOntoDocument(source, config)
        XCTAssertEqual(try parseConfig(written).agentActions, config.agentActions)
        XCTAssertTrue(written.contains("[agent_actions.issue.implement]"))
        XCTAssertTrue(written.contains("[agent_actions.issue.review]"))
    }
}

final class ConfigKeyboardTests: XCTestCase {
    func testHasNoOverridesAtAllByDefault() {
        XCTAssertEqual(Config.defaults.keybindings, KeybindingsSpec(prefix: "Cmd+q", chords: [:]))
    }

    func testReadsAPrefixAndATableOfSecondStrokes() throws {
        let config = try parseConfig("\nversion = 1\n\n[keybindings]\nprefix = \"Ctrl+q\"\n\n[keybindings.chords]\n\"Shift+n\" = \"previous_workspace\"\ng = \"\"\n")
        XCTAssertEqual(config.keybindings.prefix, "Ctrl+q")
        XCTAssertEqual(config.keybindings.chords, ["Shift+n": "previous_workspace", "g": ""])
    }

    func testSurvivesARoundTripThroughTheDocument() throws {
        let config = try parseConfig("\nversion = 1\n\n[keybindings.chords]\n\"Cmd+j\" = \"next_tab\"\n")
        XCTAssertEqual(try parseConfig(configToToml(config)).keybindings, config.keybindings)
    }

    func testKeepsTheFileThePersonWroteWhenOnlyAChordChanged() throws {
        let source = "# mine\nversion = 1\n\n[keybindings.chords]\n\"Cmd+j\" = \"next_tab\"\n"
        var config = try parseConfig(source)
        config.keybindings.chords = ["Cmd+j": "previous_tab"]
        let written = try configOntoDocument(source, config)
        XCTAssertTrue(written.contains("# mine"))
        XCTAssertTrue(written.contains("previous_tab"))
    }

    func testRefusesACommandIdDevHubDoesNotHave() {
        XCTAssertEqual(configCodeOf { try parseConfig("version = 1\n[keybindings.chords]\ng = \"teleport\"\n") }, .unknownCommand)
    }

    func testRefusesAModifierThatIsNotOne() {
        XCTAssertEqual(configCodeOf { try parseConfig("version = 1\n[keybindings]\nprefix = \"Hyper+q\"\n") }, .invalidKeybinding)
    }

    func testReadsAStrokeWrittenAsACharacterOrAsShiftAndItsBase() throws {
        func command(_ config: Config, _ id: String) -> CommandId? {
            Commands.resolve(config.keybindings).bindings.first { ChordKeys.id($0.key) == id }?.commandId
        }
        XCTAssertEqual(command(try parseConfig("version = 1\n[keybindings.chords]\n\"{\" = \"next_tab\"\n"), "{"), .nextTab)
        XCTAssertEqual(command(try parseConfig("version = 1\n[keybindings.chords]\n\"Shift+[\" = \"next_tab\"\n"), "{"), .nextTab)
        for written in ["<", "Shift+,"] {
            XCTAssertEqual(command(try parseConfig("version = 1\n[keybindings.chords]\n\"\(written)\" = \"next_tab\"\n"), "<"), .nextTab, written)
        }
    }

    func testRefusesTwoSpellingsOfOneKey() {
        XCTAssertEqual(configCodeOf { try parseConfig("version = 1\n[keybindings.chords]\n\"Shift+n\" = \"next_tab\"\n\"N\" = \"previous_tab\"\n") }, .duplicateIdentity)
    }

    func testRefusesAValueThatIsNotACommandIdAtAll() {
        XCTAssertEqual(configCodeOf { try parseConfig("version = 1\n[keybindings.chords]\ng = 3\n") }, .invalidType)
    }

    func testRefusesAnUnknownKeyUnderKeybindings() {
        XCTAssertEqual(configCodeOf { try parseConfig("version = 1\n[keybindings]\nsuffix = \"x\"\n") }, .unknownKey)
    }
}

final class ConfigProjectsTests: XCTestCase {
    func projectsSetting(_ line: String) -> String { configLines("version = 1", "", "[projects]", line, "") }

    func testIsUnsetWhenTheFileDoesNotMentionIt() throws {
        XCTAssertEqual(try parseConfig(MINIMAL).projects, ProjectsConfig(directory: nil))
        XCTAssertFalse(try configToToml(Config.defaults).contains("[projects]"))
    }

    func testReadsAnAbsolutePathTildeSlashAndTildeAsWritten() throws {
        for directory in ["/srv/code", "~/dev/new", "~"] {
            let config = try parseConfig(projectsSetting("directory = \"\(directory)\""))
            XCTAssertEqual(config.projects, ProjectsConfig(directory: directory))
            XCTAssertEqual(try parseConfig(configToToml(config)), config)
        }
    }

    func testTakesNoDateTokens() throws {
        XCTAssertEqual(try parseConfig(projectsSetting(#"directory = "~/dev/YYYY""#)).projects, ProjectsConfig(directory: "~/dev/YYYY"))
    }

    func testRefusesAnEmptyOrRelativeValueNamingTheKey() {
        for directory in ["", "dev/new", "./dev", "~user/dev"] {
            let source = projectsSetting("directory = \"\(directory)\"")
            XCTAssertEqual(configCodeOf { try parseConfig(source) }, .invalidProjectDirectory, directory)
            XCTAssertEqual(configPathOf { try parseConfig(source) }, "projects.directory", directory)
        }
    }

    func testRefusesAValueThatIsNotAStringAndAKeyItDoesNotKnow() {
        XCTAssertEqual(configCodeOf { try parseConfig(self.projectsSetting("directory = 3")) }, .invalidType)
        XCTAssertEqual(configCodeOf { try parseConfig(self.projectsSetting(#"clone_into = "~/dev""#)) }, .unknownKey)
    }

    func testDropsTheTableWhenASaveUnsetsIt() throws {
        let written = projectsSetting(#"directory = "~/dev/new""#)
        var config = try parseConfig(written)
        config.projects = ProjectsConfig(directory: nil)
        let unset = try configOntoDocument(written, config)
        XCTAssertFalse(unset.contains("directory"))
        XCTAssertEqual(try parseConfig(unset).projects, ProjectsConfig(directory: nil))
    }
}

final class ConfigColourThemeTests: XCTestCase {
    let version = "version = \(JSString.number(SCHEMA))"

    func testIsVSCodesOwnDefaultsWhenTheFileSaysNothing() throws {
        XCTAssertEqual(ConfigConstants.defaultThemeDark, "Dark 2026")
        XCTAssertEqual(ConfigConstants.defaultThemeLight, "Light 2026")
        let config = try parseConfig("\(version)\n")
        XCTAssertEqual(config.appearance.themeDark, "Dark 2026")
        XCTAssertEqual(config.appearance.themeLight, "Light 2026")
        XCTAssertEqual(Config.defaults.appearance.themeDark, "Dark 2026")
    }

    func testReadsAndWritesBackTheNamesTheFileGives() throws {
        let config = try parseConfig("\(version)\n[appearance]\ntheme_dark = \"Monokai\"\ntheme_light = \" Solarized Light \"\n")
        XCTAssertEqual(config.appearance.themeDark, "Monokai")
        XCTAssertEqual(config.appearance.themeLight, "Solarized Light")
        let saved = try configToToml(config)
        XCTAssertTrue(saved.contains(#"theme_dark = "Monokai""#))
        XCTAssertTrue(saved.contains(#"theme_light = "Solarized Light""#))
    }

    func testRefusesANameThatIsNotAStringOrIsEmpty() {
        XCTAssertEqual(configPathOf { try parseConfig("\(self.version)\n[appearance]\ntheme_dark = 1\n") }, "appearance.theme_dark")
        XCTAssertEqual(configCodeOf { try parseConfig("\(self.version)\n[appearance]\ntheme_light = \"\"\n") }, .invalidAppearance)
    }

    func testIsReadableOnItsOwn() {
        XCTAssertTrue(ConfigParsing.colorThemes(in: nil) == ("Dark 2026", "Light 2026"))
        XCTAssertTrue(ConfigParsing.colorThemes(in: "\(version)\n[appearance]\ntheme_dark = \"Monokai\"\n") == ("Monokai", "Light 2026"))
        XCTAssertTrue(ConfigParsing.colorThemes(in: "not toml = = =") == ("Dark 2026", "Light 2026"))
        XCTAssertEqual(ConfigParsing.colorThemes(in: "[appearance]\ntheme_dark = 7\n").dark, "Dark 2026")
    }

    func testHasItsAppearanceReadableOnItsOwnToo() {
        XCTAssertEqual(ConfigParsing.appearanceMode(in: nil), "auto")
        XCTAssertEqual(ConfigParsing.appearanceMode(in: "[appearance]\nmode = \"dark\"\n"), "dark")
        XCTAssertEqual(ConfigParsing.appearanceMode(in: "[appearance]\nmode = \"dusk\"\n"), "auto")
        XCTAssertEqual(ConfigParsing.appearanceMode(in: "not toml = = ="), "auto")
    }
}

final class ConfigTerminalThemeTests: XCTestCase {
    let version = "version = \(JSString.number(SCHEMA))"
    var ownLight: TerminalPalette {
        var palette = TerminalPalette.defaultLight
        palette.background = "#FAFAFA"
        return palette
    }

    func testFollowsTheVSCodeThemeWhenTheFileSaysNothing() throws {
        XCTAssertEqual(try parseConfig("\(version)\n").appearance.terminalTheme, .vscode)
        XCTAssertEqual(Config.defaults.appearance.terminalTheme, .vscode)
    }

    func testFollowsItWhenTheFileSaysVSCodeAndWritesTheWordBack() throws {
        let config = try parseConfig("\(version)\n[appearance]\nterminal_theme = \"vscode\"\n")
        XCTAssertEqual(config.appearance.terminalTheme, .vscode)
        XCTAssertTrue(try configToToml(config).contains(#"terminal_theme = "vscode""#))
        XCTAssertFalse(try configToToml(config).contains("[appearance.terminal_theme"))
    }

    func testRefusesAnyOtherWord() {
        let source = "\(version)\n[appearance]\nterminal_theme = \"solarized\"\n"
        XCTAssertEqual(configCodeOf { try parseConfig(source) }, .invalidAppearance)
        XCTAssertEqual(configPathOf { try parseConfig(source) }, "appearance.terminal_theme")
    }

    func testWearsPalettesTheFileNamesFillingASchemeItLeavesOut() throws {
        let source = configLines(version, "[appearance.terminal_theme.light]", ##"background = "#FAFAFA""##, "")
        XCTAssertEqual(try parseConfig(source).appearance.terminalTheme, .palettes(TerminalPalettes(light: ownLight, dark: .defaultDark)))
    }

    func testRoundTripsPalettesAsTables() throws {
        var config = Config.defaults
        config.appearance.terminalTheme = .palettes(TerminalPalettes(light: ownLight, dark: .defaultDark))
        let text = try configToToml(config)
        XCTAssertTrue(text.contains("[appearance.terminal_theme.light]"))
        XCTAssertEqual(try parseConfig(text).appearance.terminalTheme, config.appearance.terminalTheme)
    }

    func testReadsTheBuiltInPalettesAnOlderFileSpelledOutAsTheDefaultTheyWereOnce() throws {
        var config = Config.defaults
        config.appearance.terminalTheme = .palettes(.defaults)
        let shipped = try configToToml(config)
        let older = shipped.replacingOccurrences(of: version, with: "version = 3")
        XCTAssertEqual(try parseConfig(older).appearance.terminalTheme, .vscode)
        let saved = try configOntoDocument(older, parseConfig(older))
        XCTAssertTrue(saved.contains(#"terminal_theme = "vscode""#))
        XCTAssertFalse(saved.contains("[appearance.terminal_theme"))
        XCTAssertEqual(try parseConfig(saved).appearance.terminalTheme, .vscode)
        XCTAssertEqual(try parseConfig(shipped).appearance.terminalTheme, .palettes(.defaults))
    }

    func testKeepsPalettesAnOlderFileChangedAnywhere() throws {
        let source = configLines("version = 1", "[appearance.terminal_theme.light]", ##"background = "#FAFAFA""##, "")
        XCTAssertEqual(try parseConfig(source).appearance.terminalTheme, .palettes(TerminalPalettes(light: ownLight, dark: .defaultDark)))
    }

    func testDropsTheTablesWhenASaveSwitchesToFollowingTheTheme() throws {
        let source = configLines("# mine", version, "[appearance]", "terminal_font_size = 13", "", "[appearance.terminal_theme.light]", ##"background = "#FAFAFA""##, "")
        var config = try parseConfig(source)
        config.appearance.terminalTheme = .vscode
        let saved = try configOntoDocument(source, config)
        XCTAssertTrue(saved.contains("# mine"))
        XCTAssertFalse(saved.contains("[appearance.terminal_theme"))
        XCTAssertEqual(try parseConfig(saved).appearance.terminalTheme, .vscode)
    }
}

final class ConfigUsageLimitTests: XCTestCase {
    func withAgents(_ lines: String) -> String { "version = \(JSString.number(SCHEMA))\n[agents]\n\(lines)\n" }

    func testIsOnWithTsuzuketeWhenTheFileDoesNotSay() throws {
        let agents = try parseConfig("version = \(JSString.number(SCHEMA))\n").agents
        XCTAssertTrue(agents.resumeAfterLimit)
        XCTAssertEqual(agents.resumeAfterLimitMessage, "続けて")
        XCTAssertEqual(Config.defaults.agents.resumeAfterLimitMessage, "続けて")
    }

    func testAutoCompactsByDefaultAndKeepsAnExplicitFalse() throws {
        let bare = try parseConfig("version = \(JSString.number(SCHEMA))\n[agents]\n").agents
        XCTAssertTrue(bare.autoCompactBeforeCacheExpiry)
        XCTAssertEqual(bare.autoCompactMinTokens, 100_000)
        XCTAssertEqual(bare.autoCompactLeadSeconds, 60)
        let off = try parseConfig(withAgents("auto_compact_before_cache_expiry = false\nauto_compact_min_tokens = 5000")).agents
        XCTAssertFalse(off.autoCompactBeforeCacheExpiry)
        XCTAssertEqual(off.autoCompactMinTokens, 5000)
    }

    func testReadsBothKeysAndWritesThemBackAsRead() throws {
        let source = withAgents("resume_after_limit = false\nresume_after_limit_message = \"Please go on\"")
        var config = try parseConfig(source)
        XCTAssertFalse(config.agents.resumeAfterLimit)
        XCTAssertEqual(config.agents.resumeAfterLimitMessage, "Please go on")
        config.agents.resumeAfterLimitMessage = "続けてください"
        XCTAssertEqual(try parseConfig(configOntoDocument(source, config)).agents, config.agents)
    }

    func testRefusesAnEmptyMessageNamingTheKey() {
        for message in [#""""#, #""   ""#, #""a\u0000b""#] {
            let source = withAgents("resume_after_limit_message = \(message)")
            XCTAssertEqual(configCodeOf { try parseConfig(source) }, .invalidResumeMessage, message)
            XCTAssertEqual(configPathOf { try parseConfig(source) }, "agents.resume_after_limit_message", message)
        }
    }

    func testRefusesASwitchThatIsNotTrueOrFalse() {
        let source = withAgents(#"resume_after_limit = "yes""#)
        XCTAssertEqual(configCodeOf { try parseConfig(source) }, .invalidType)
        XCTAssertEqual(configPathOf { try parseConfig(source) }, "agents.resume_after_limit")
    }
}
