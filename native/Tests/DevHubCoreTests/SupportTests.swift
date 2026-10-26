import XCTest
@testable import DevHubCore

final class SHA256Tests: XCTestCase {
    func testKnownVectors() {
        XCTAssertEqual(SHA256.hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(SHA256.hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertEqual(
            SHA256.hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        )
        // Multi-block, non-ASCII.
        XCTAssertEqual(SHA256.hex(String(repeating: "あ", count: 100)).count, 64)
    }

    func testTmuxNamesMatchTheTypeScriptApp() {
        // sha256("/Users/me/src/app") computed with Node's crypto.
        let root = "/Users/me/src/app"
        let digest = SHA256.hex(root)
        XCTAssertEqual(TmuxNames.workspaceSession(root: root), "ws-" + digest.prefix(20))
        XCTAssertTrue(TmuxNames.isWorkspaceSession("ws-" + digest.prefix(32), root: root))
        XCTAssertFalse(TmuxNames.isWorkspaceSession("ws-" + digest.prefix(12), root: root))
        XCTAssertEqual(TmuxNames.agentSession(agentId: "abc"), "ag-abc")
        XCTAssertEqual(TmuxNames.neovimSocketName(workspaceId: "w").count, 12 + ".sock".count)
    }
}

final class ProfileLocationsTests: XCTestCase {
    func testDefaultProfileIsTheTypeScriptAppsLocations() throws {
        let p = try ProfileLocations.current(environment: [:], home: "/Users/me")
        XCTAssertTrue(p.isDefault)
        XCTAssertEqual(p.applicationName, "DevHub")
        XCTAssertEqual(p.cliCommandName, "devhub")
        XCTAssertEqual(p.dataDirectory, "/Users/me/Library/Application Support/DevHub")
        XCTAssertEqual(p.userDataDirectory, "/Users/me/Library/Application Support/DevHub/editor")
        XCTAssertEqual(p.configDirectory, "/Users/me/.config/devhub")
        XCTAssertEqual(p.tmuxSocketName, "devhub")
        XCTAssertEqual(p.controlSocketPath, "/Users/me/Library/Application Support/DevHub/editor/devhub/control.sock")
        XCTAssertEqual(p.stateFilePath, "/Users/me/Library/Application Support/DevHub/editor/devhub/state.json")
        XCTAssertEqual(p.settingsFilePath, "/Users/me/.config/devhub/settings.toml")
    }

    func testNamedProfileIsDisjoint() throws {
        let p = try ProfileLocations.current(
            environment: ["DEVHUB_PROFILE": "native-dev", "XDG_CONFIG_HOME": "/x/cfg"],
            home: "/Users/me"
        )
        XCTAssertFalse(p.isDefault)
        XCTAssertEqual(p.applicationName, "DevHub Native Dev")
        XCTAssertEqual(p.cliCommandName, "devhub-native-dev")
        XCTAssertEqual(p.dataDirectory, "/Users/me/Library/Application Support/DevHub Native Dev")
        XCTAssertEqual(p.configDirectory, "/x/cfg/devhub-native-dev")
        XCTAssertEqual(p.tmuxSocketName, "devhub-native-dev")
    }

    func testRelativeXdgIsIgnoredAndBadNamesRefused() throws {
        let p = try ProfileLocations.current(environment: ["XDG_CONFIG_HOME": "rel"], home: "/h")
        XCTAssertEqual(p.configDirectory, "/h/.config/devhub")
        XCTAssertThrowsError(try ProfileLocations.current(environment: ["DEVHUB_PROFILE": "Bad"], home: "/h"))
        XCTAssertThrowsError(try ProfileLocations.current(environment: ["DEVHUB_PROFILE": "1x"], home: "/h"))
    }

    func testPathJoin() {
        XCTAssertEqual(Path.join("/a/", "/b", "", "c"), "/a/b/c")
        XCTAssertEqual(Path.join("a"), "a")
    }
}

final class ProcessRunnerTests: XCTestCase {
    func testRunsAndCollectsOutput() async throws {
        let sh = try XCTUnwrap(ProcessRunner.resolveExecutable("sh", searchPath: "/bin:/usr/bin"))
        let output = try await ProcessRunner().run(sh, ["-c", "printf out; printf err >&2; exit 3"])
        XCTAssertEqual(output.status, 3)
        XCTAssertEqual(output.stdoutText, "out")
        XCTAssertEqual(output.stderrText, "err")
    }

    func testStdinIsDelivered() async throws {
        let cat = try XCTUnwrap(ProcessRunner.resolveExecutable("cat", searchPath: "/bin:/usr/bin"))
        let output = try await ProcessRunner().run(cat, [], stdin: Data("hello".utf8))
        XCTAssertEqual(output.stdoutText, "hello")
        XCTAssertTrue(output.succeeded)
    }

    func testTimeout() async throws {
        let sleep = try XCTUnwrap(ProcessRunner.resolveExecutable("sleep", searchPath: "/bin:/usr/bin"))
        do {
            _ = try await ProcessRunner().run(sleep, ["5"], timeout: 0.3)
            XCTFail("expected a timeout")
        } catch let error as ProcessRunnerError {
            guard case .timedOut = error else { return XCTFail("\(error)") }
        }
    }

    func testMissingExecutable() async {
        do {
            _ = try await ProcessRunner().run("/nonexistent/devhub-test", [])
            XCTFail("expected a launch failure")
        } catch {
            XCTAssertTrue(error is ProcessRunnerError)
        }
    }
}

final class VersionTests: XCTestCase {
    func testDescription() {
        XCTAssertTrue(DevHubVersion.description.hasPrefix("DevHub "))
        XCTAssertTrue(DevHubVersion.description.contains("native"))
    }
}
