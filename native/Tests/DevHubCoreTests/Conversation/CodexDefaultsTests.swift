// Port of apps/desktop/src/model/codexDefaults.test.ts and the Codex part of
// apps/desktop/src/shell/conversation/settingPickers.test.tsx.

import XCTest

@testable import DevHubCore

final class CodexDefaultsTests: XCTestCase {
    private func toml(_ text: String) throws -> TomlTable { try TomlDocument.parseValue(text) }

    func testIsCodexsOwnWhenNothingNamesOne() {
        let defaults = codexDefaults(CodexDefaultInputs(config: nil, args: []))
        XCTAssertEqual(defaults.model, CliDefault(source: .builtIn))
        XCTAssertEqual(defaults.effort, CliDefault(source: .builtIn))
        XCTAssertEqual(defaults.cli, .codex)
    }

    func testReadsTheTopLevelOfConfigToml() throws {
        let defaults = codexDefaults(
            CodexDefaultInputs(config: try toml("model = \"gpt-a\"\nmodel_reasoning_effort = \"high\"\n"), args: []))
        XCTAssertEqual(defaults.model, CliDefault(value: "gpt-a", source: .layer(.user)))
        XCTAssertEqual(defaults.effort, CliDefault(value: "high", source: .layer(.user)))
    }

    func testPutsTheSelectedProfilesTableBeforeTheTopLevel() throws {
        let config = try toml(
            """
            model = "gpt-a"
            model_reasoning_effort = "high"
            profile = "fast"
            [profiles.fast]
            model = "gpt-b"
            [profiles.slow]
            model = "gpt-c"
            """)
        let defaults = codexDefaults(CodexDefaultInputs(config: config, args: []))
        XCTAssertEqual(defaults.model, CliDefault(value: "gpt-b", source: .layer(.user)))
        XCTAssertEqual(defaults.effort, CliDefault(value: "high", source: .layer(.user)))
        XCTAssertEqual(
            codexDefaults(CodexDefaultInputs(config: config, args: ["-c", "profile=slow"])).model,
            CliDefault(value: "gpt-c", source: .layer(.user)))
    }

    func testPutsACOverrideAmongTheProfilesArgumentsFirst() throws {
        let defaults = codexDefaults(
            CodexDefaultInputs(
                config: try toml("model = \"gpt-a\""),
                args: ["-c", #"model="gpt-z""#, "--config", "model_reasoning_effort=low"]))
        XCTAssertEqual(defaults.model, CliDefault(value: "gpt-z", source: .argument))
        XCTAssertEqual(defaults.effort, CliDefault(value: "low", source: .argument))
    }

    func testReadsAnOverridesValueAsTomlElseAsItsTextTheLastOneWinning() {
        XCTAssertEqual(overrideValue(["-c", "model=gpt-a"], "model"), "gpt-a")
        XCTAssertEqual(overrideValue(["-c", #"model = "gpt-b""#], "model"), "gpt-b")
        XCTAssertEqual(overrideValue(["-c", "model=gpt-a", "--config=model=gpt-c"], "model"), "gpt-c")
        XCTAssertNil(overrideValue(["-c", "model_provider=x"], "model"))
        XCTAssertNil(overrideValue(["-c"], "model"))
    }

    func testSelectsAProfileByOverrideBeforeTheFilesOwnKey() throws {
        XCTAssertEqual(
            selectedCodexProfile(CodexDefaultInputs(config: try toml("profile = \"a\""), args: ["-c", "profile=b"])), "b")
        XCTAssertEqual(selectedCodexProfile(CodexDefaultInputs(config: try toml("profile = \"a\""), args: [])), "a")
        XCTAssertNil(selectedCodexProfile(CodexDefaultInputs(config: nil, args: [])))
    }

    // MARK: making a Codex default

    private let PERSONAL = [
        "# my settings",
        #"model = "gpt-a" # the usual"#,
        #"approval_policy = "on-request""#,
        "",
        "[mcp_servers.docs]",
        #"command = "docs-mcp""#,
        "",
        #"[projects."/work/app"]"#,
        #"trust_level = "trusted""#,
        "",
    ].joined(separator: "\n")

    func testWritesAFileThatIsNotThere() throws {
        XCTAssertEqual(try withCodexUserDefault(nil, .model, "gpt-b"), "model = \"gpt-b\"\n")
        XCTAssertEqual(
            try toml(try withCodexUserDefault(nil, .effort, "xhigh")), ["model_reasoning_effort": "xhigh"])
    }

    func testChangesTheOneValueKeepingCommentsTablesAndTheRest() throws {
        XCTAssertEqual(
            try withCodexUserDefault(PERSONAL, .model, "gpt-b"),
            PERSONAL.replacingOccurrences(of: #"model = "gpt-a""#, with: #"model = "gpt-b""#))
    }

    func testAddsAnEffortAtTheTopLevelAboveEveryTable() throws {
        let written = try withCodexUserDefault(PERSONAL, .effort, "low")
        let parsed = try toml(written)
        XCTAssertEqual(parsed["model_reasoning_effort"], "low")
        XCTAssertEqual(parsed["mcp_servers"], ["docs": ["command": "docs-mcp"]])
        let effort = try XCTUnwrap(written.range(of: "model_reasoning_effort"))
        let table = try XCTUnwrap(written.range(of: "[mcp_servers.docs]"))
        XCTAssertLessThan(effort.lowerBound, table.lowerBound)
        XCTAssertTrue(written.contains("# my settings"))
        XCTAssertTrue(written.contains("# the usual"))
    }

    func testWritesIntoTheSelectedProfilesTableAsCodexsOwnPickerDoes() throws {
        let text = "\(PERSONAL)\n[profiles.fast]\nmodel = \"gpt-mini\"\n"
        let written = try toml(try withCodexUserDefault(text, .effort, "minimal", profile: "fast"))
        XCTAssertEqual(written["profiles"], ["fast": ["model": "gpt-mini", "model_reasoning_effort": "minimal"]])
        XCTAssertNil(written["model_reasoning_effort"])
        XCTAssertEqual(
            try toml(try withCodexUserDefault(PERSONAL, .model, "gpt-c", profile: "new"))["profiles"],
            ["new": ["model": "gpt-c"]])
    }

    func testRefusesAFileItCannotReadAndAnEmptyValue() {
        XCTAssertThrowsError(try withCodexUserDefault("model = ", .model, "gpt-b")) {
            XCTAssertTrue("\($0)".contains("not valid TOML, so DevHub leaves it as it is"), "\($0)")
        }
        XCTAssertThrowsError(try withCodexUserDefault(nil, .model, " ")) {
            XCTAssertTrue("\($0)".contains("cannot be empty"), "\($0)")
        }
    }

    // MARK: on this machine's disk

    func testReadsAndWritesConfigTomlUnderCodexHomeAndSaysWhere() async throws {
        let home = scratchDirectory("codex-defaults", self)
        let codex = "\(home)/.codex"
        try FileManager.default.createDirectory(atPath: codex, withIntermediateDirectories: true)
        try "# mine\nprofile = \"fast\"\n\n[profiles.fast]\nmodel = \"gpt-mini\"\n".write(
            toFile: "\(codex)/config.toml", atomically: true, encoding: .utf8)
        let runtime = LocalRuntime(environment: { [:] }, home: { home })
        let profile = SessionProfile(kind: .codex, command: "codex", args: [], env: [:])

        var defaults = try await readCodexDefaults(runtime, profile: profile)
        XCTAssertEqual(defaults.savedIn, "[profiles.fast] in ~/.codex/config.toml")
        XCTAssertEqual(defaults.model, CliDefault(value: "gpt-mini", source: .layer(.user)))
        XCTAssertEqual(defaults.effort, CliDefault(source: .builtIn))

        try await writeCodexDefault(runtime, profile: profile, .effort, "high")
        defaults = try await readCodexDefaults(runtime, profile: profile)
        XCTAssertEqual(defaults.effort, CliDefault(value: "high", source: .layer(.user)))
        let text = try String(contentsOfFile: "\(codex)/config.toml", encoding: .utf8)
        XCTAssertTrue(text.hasPrefix("# mine\n"), text)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: codex), ["config.toml"])
    }

    // MARK: the pickers' marks and words

    private let models = [
        SettingChoice(id: "gpt-a", label: "gpt-a", builtInDefault: true), SettingChoice(id: "gpt-b", label: "gpt-b"),
    ]
    private let efforts = ["low", "medium", "high", "xhigh"].map {
        SettingChoice(id: $0, label: $0, builtInDefault: $0 == "medium")
    }

    func testMarksCodexsOwnDefaultModelAndEffortWhenConfigTomlNamesNone() {
        XCTAssertEqual(SettingPickerModel.defaultRow(models, CliDefault(source: .builtIn))?.id, "gpt-a")
        XCTAssertEqual(SettingPickerModel.defaultRow(efforts, CliDefault(source: .builtIn))?.id, "medium")
        XCTAssertEqual(
            SettingPickerModel.defaultRow(models, CliDefault(value: "gpt-b", source: .layer(.user)))?.id, "gpt-b")
    }

    func testOffersEveryEffortAndSaysWhereAChangeGoes() {
        let defaults = CliDefaults(
            cli: .codex, savedIn: "~/.codex/config.toml", model: CliDefault(value: "gpt-a", source: .layer(.user)),
            effort: CliDefault(value: "low", source: .layer(.user)))
        let offer = SettingPickerModel.known(.effort, defaults)!
        XCTAssertNil(SettingPickerModel.notSavable(.effort, SettingChoice(id: "xhigh", label: "xhigh"), offer))
        XCTAssertTrue(
            SettingPickerModel.makeDefaultTip(.model, models[1], offer).contains("in ~/.codex/config.toml"))
        XCTAssertEqual(SettingPickerModel.defaultTip(offer), "New sessions start on this: set by ~/.codex/config.toml")
        let claude = CliDefaults(model: CliDefault(source: .builtIn), effort: CliDefault(value: "high", source: .builtIn))
        XCTAssertNotNil(
            SettingPickerModel.notSavable(
                .effort, SettingChoice(id: "max", label: "max"), SettingPickerModel.known(.effort, claude)!))
    }

    func testSaysWhenACOverrideAmongTheProfilesArgumentsDecidesTheDefault() {
        let defaults = CliDefaults(
            cli: .codex, savedIn: "~/.codex/config.toml", model: CliDefault(value: "gpt-b", source: .argument),
            effort: CliDefault(source: .builtIn))
        let offer = SettingPickerModel.known(.model, defaults)!
        XCTAssertEqual(SettingPickerModel.defaultRow(models, offer.known)?.id, "gpt-b")
        XCTAssertTrue(
            SettingPickerModel.makeDefaultTip(.model, models[0], offer).contains(
                "arguments (-c) sets the default now"))
        XCTAssertEqual(
            SettingPickerModel.defaultTip(SettingPickerModel.known(.effort, defaults)!),
            "New sessions start on this: Codex's own default")
    }
}
