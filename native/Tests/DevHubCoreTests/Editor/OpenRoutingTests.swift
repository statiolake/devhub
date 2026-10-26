// Port of apps/desktop/src/main/cli/route.test.ts, resolve.test.ts,
// canonical.test.ts and waitReturn.test.ts.

import Foundation
import XCTest
@testable import DevHubCore

private func workspace(_ id: String, _ root: String, _ machine: String, _ agents: [String] = []) -> RoutableWorkspace {
    RoutableWorkspace(workspaceId: id, root: root, machine: machine, agents: agents)
}

private func route(_ path: String, _ machine: String, _ workspaces: [RoutableWorkspace], _ origin: String? = nil)
    -> OpenDestination
{
    try! OpenRouting.routeOpen(path, machine: machine, workspaces: workspaces, origin: origin)
}

final class OpenRoutingTests: XCTestCase {
    // MARK: where an open lands

    func testGoesToTheWorkspaceWhoseRootContainsThePath() {
        let open = route("/work/alpha/src/main.ts", "local", [
            workspace("alpha", "/work/alpha", "local"), workspace("beta", "/work/beta", "local"),
        ])
        XCTAssertEqual(open, .workspace(workspace("alpha", "/work/alpha", "local"), reason: .containing))
    }

    func testGoesToTheDeepestWorkspaceWhenTheyAreNested() {
        let open = route("/work/alpha/inner/f.ts", "local", [
            workspace("outer", "/work/alpha", "local"), workspace("inner", "/work/alpha/inner", "local"),
        ])
        XCTAssertEqual(open, .workspace(workspace("inner", "/work/alpha/inner", "local"), reason: .containing))
    }

    func testKeepsAPaneInYesterdaysScratchOnYesterdaysFolderAfterMidnight() {
        let open = [
            workspace("yesterday", "/data/junk/20260922", "local"), workspace("today", "/data/junk/20260923", "local"),
        ]
        XCTAssertEqual(route("/elsewhere/f.ts", "local", open, "local\tyesterday\tnone"), .workspace(open[0], reason: .origin))
        XCTAssertEqual(route("/elsewhere/f.ts", "local", open), .scratch(reason: .noContainingWorkspace))
    }

    func testGoesToScratchWhenNoOpenWorkspaceContainsThePath() {
        XCTAssertEqual(
            route("/elsewhere/notes.md", "local", [workspace("alpha", "/work/alpha", "local")]),
            .scratch(reason: .noContainingWorkspace))
        XCTAssertEqual(route("/work/alpha/f.ts", "local", []), .scratch(reason: .noContainingWorkspace))
    }

    // MARK: two machines with the same root

    let both = [workspace("here", "/srv/app", "local"), workspace("there", "/srv/app", "ssh:build-host")]

    func testRoutesALocalPathToTheLocalWorkspaceAndAHostsToTheHosts() {
        XCTAssertEqual(route("/srv/app/src/main.ts", "local", both), .workspace(both[0], reason: .containing))
        XCTAssertEqual(route("/srv/app/src/main.ts", "ssh:build-host", both), .workspace(both[1], reason: .containing))
    }

    func testGivesTheSameAnswerWhateverOrderTheWorkspacesAreListedIn() {
        let reversed = Array(both.reversed())
        XCTAssertEqual(route("/srv/app/f.ts", "local", reversed), route("/srv/app/f.ts", "local", both))
        XCTAssertEqual(route("/srv/app/f.ts", "ssh:build-host", reversed), route("/srv/app/f.ts", "ssh:build-host", both))
    }

    func testSendsAPathOnAThirdMachineToScratch() {
        XCTAssertEqual(route("/srv/app/f.ts", "ssh:other-host", both), .scratch(reason: .noContainingWorkspace))
    }

    // MARK: an open that says which Workspace it came from

    let alpha = workspace("alpha-id", "/work/alpha", "local")
    let beta = workspace("beta-id", "/work/beta", "local")
    let fromAlpha = "local\talpha-id\tnone"

    func testLandsInThatWindowWhetherOrNotAWorkspaceContainsThePath() {
        XCTAssertEqual(route("/etc/hosts", "local", [alpha, beta], fromAlpha), .workspace(alpha, reason: .origin))
        XCTAssertEqual(route("/work/beta/x.ts", "local", [alpha, beta], fromAlpha), .workspace(alpha, reason: .origin))
    }

    func testLandsInScratchWhenTheTerminalIsScratchsOwn() {
        XCTAssertEqual(route("/work/alpha/f.ts", "local", [alpha, beta], "local\tscratch\tnone"), .scratch(reason: .origin))
    }

    func testFallsThroughWhenTheOriginsWindowIsGone() {
        XCTAssertEqual(
            route("/work/beta/x.ts", "local", [alpha, beta], "local\tclosed-id\tnone"), .workspace(beta, reason: .containing))
        XCTAssertEqual(
            route("/etc/hosts", "local", [alpha, beta], "local\tclosed-id\tnone"), .scratch(reason: .noContainingWorkspace))
    }

    func testIgnoresAnOriginWhoseMachineDisagreesWithTheWorkspaces() {
        XCTAssertEqual(
            route("/work/beta/x.ts", "local", [alpha, beta], "ssh:build-host\talpha-id\tnone"),
            .workspace(beta, reason: .containing))
    }

    func testIgnoresAnOriginThatIsNotTheShapeDevHubWrites() {
        for malformed in ["", "local", "local\talpha-id", "local\talpha-id\tnone\textra", "\t\t"] {
            XCTAssertEqual(route("/etc/hosts", "local", [alpha, beta], malformed), .scratch(reason: .noContainingWorkspace), malformed)
        }
    }

    func testLandsInARemoteWorkspacesWindowForAPaneOnThatHost() {
        let remote = workspace("remote-id", "/srv/app", "ssh:build-host")
        XCTAssertEqual(
            route("/etc/hosts", "ssh:build-host", [alpha, remote], "ssh:build-host\tremote-id\tnone"),
            .workspace(remote, reason: .origin))
    }

    // MARK: an open that came from an Agent's own pane

    func testGoesBesideThatAgentInItsWorkspacesEditor() {
        let agentAlpha = workspace("alpha-id", "/work/alpha", "local", ["agent-id"])
        let open = [agentAlpha, beta]
        XCTAssertEqual(route("/work/alpha/f.ts", "local", open, "local\talpha-id\tagent-id"), .besideAgent(agentAlpha, agentId: "agent-id"))
        XCTAssertEqual(route("/work/beta/x.ts", "local", open, "local\talpha-id\tagent-id"), .besideAgent(agentAlpha, agentId: "agent-id"))
        XCTAssertEqual(route("/etc/hosts", "local", open, "local\talpha-id\tgone-id"), .workspace(agentAlpha, reason: .origin))
        XCTAssertEqual(route("/etc/hosts", "local", open, "local\tbeta-id\tagent-id"), .workspace(beta, reason: .origin))
        XCTAssertEqual(route("/etc/hosts", "local", open, "local\talpha-id\tnone"), .workspace(agentAlpha, reason: .origin))
        XCTAssertEqual(route("/etc/hosts", "local", open, "local\talpha-id\tagent-id").reason, .originAgent)
    }

    // MARK: where a file link in a GUI Agent's conversation opens

    func testAConversationLinkOpensBesideTheAgentOrInTheContainingWorkspace() throws {
        let alpha = workspace("alpha", "/work/alpha", "local", ["agent-1"])
        let beta = workspace("beta", "/work/beta", "local")
        func link(_ path: String, _ machine: String = "local", _ open: [RoutableWorkspace]? = nil, _ ws: String = "alpha",
            _ agent: String = "agent-1") throws -> OpenDestination
        {
            try OpenRouting.routeAgentOpen(
                path, machine: machine, workspaces: open ?? [alpha, beta], agentWorkspaceId: ws, agentId: agent)
        }
        XCTAssertEqual(try link("/work/alpha/src/a.ts"), .besideAgent(alpha, agentId: "agent-1"))
        XCTAssertEqual(try link("/work/beta/b.ts"), .workspace(beta, reason: .containing))
        XCTAssertEqual(try link("/elsewhere/c.ts"), .besideAgent(alpha, agentId: "agent-1"))
        let remote = workspace("remote", "/srv/app", "ssh:box", ["agent-2"])
        let local = workspace("local-app", "/srv/app", "local")
        XCTAssertEqual(
            try link("/srv/app/x.ts", "ssh:box", [local, remote], "remote", "agent-2"),
            .besideAgent(remote, agentId: "agent-2"))
        XCTAssertThrowsError(try link("/elsewhere/c.ts", "local", [beta])) { error in
            XCTAssertTrue("\(error)".contains("not open"))
        }
    }

    // MARK: resolve.ts

    func testWhichWorkspaceAPathBelongsTo() {
        let roots = ["/work/alpha", "/work/beta", "/work/alpha/nested"]
        XCTAssertEqual(PathResolution.workspaceRoot(for: "/work/alpha/src/main.ts", roots: roots), "/work/alpha")
        XCTAssertEqual(PathResolution.workspaceRoot(for: "/work/beta", roots: roots), "/work/beta")
        XCTAssertEqual(PathResolution.workspaceRoot(for: "/work/alpha/nested/deep/file.txt", roots: roots), "/work/alpha/nested")
        XCTAssertNil(PathResolution.workspaceRoot(for: "/elsewhere/file.txt", roots: roots))
        XCTAssertNil(PathResolution.workspaceRoot(for: "/work/alpha-two/file.txt", roots: roots))
        XCTAssertFalse(PathResolution.contains("/work/alpha", "/work/alpha-two"))
        XCTAssertNil(PathResolution.workspaceRoot(for: "/work/alpha/file.txt", roots: []))
    }

    func testExpandingWhatWasTyped() {
        XCTAssertEqual(PathResolution.expand("src/main.ts", cwd: "/work/alpha", home: "/home/dev"), "/work/alpha/src/main.ts")
        XCTAssertEqual(PathResolution.expand("~", cwd: "/work", home: "/home/dev"), "/home/dev")
        XCTAssertEqual(PathResolution.expand("~/notes.md", cwd: "/work", home: "/home/dev"), "/home/dev/notes.md")
        XCTAssertEqual(PathResolution.expand("./~weird", cwd: "/work", home: "/home/dev"), "/work/./~weird")
        XCTAssertEqual(PathResolution.expand("/etc/hosts", cwd: "/work", home: "/home/dev"), "/etc/hosts")
    }

    func testNormalizeIsPosixNormalize() {
        let cases: [(String, String)] = [
            ("/srv/app/.", "/srv/app"), ("/srv/app/..", "/srv"), ("/srv/app/../lib", "/srv/lib"), ("/srv/lib/", "/srv/lib/"),
            ("/..", "/"), ("/", "/"), ("a/..", "."), ("a/../", "./"), ("../x", "../x"), ("//a//b", "/a/b"), ("", "."),
            ("/home/d/x", "/home/d/x"), ("/a/./b/../../c", "/c"),
        ]
        for (input, expected) in cases {
            XCTAssertEqual(PathResolution.normalize(input), expected, input)
        }
    }

    // MARK: canonical.ts

    func testCanonicalisingAPathTheCLIWasGiven() async throws {
        let scratch = try wp7SocketDirectory("canonical")
        defer { wp7RemoveDirectory(scratch) }
        let real = try localRealpath(scratch)
        try FileManager.default.createDirectory(atPath: real + "/project/src", withIntermediateDirectories: true)
        _ = FileManager.default.createFile(atPath: real + "/project/src/main.ts", contents: Data())
        try FileManager.default.createSymbolicLink(atPath: real + "/link", withDestinationPath: real + "/project")
        let here = LocalPathMachine()

        let through = try await PathCanonicalisation.canonicalise(here, real + "/link/src/main.ts")
        XCTAssertEqual(through, ResolvedPath(path: real + "/project/src/main.ts", exists: true, isDirectory: false))
        let folder = try await PathCanonicalisation.canonicalise(here, real + "/link")
        XCTAssertEqual(folder, ResolvedPath(path: real + "/project", exists: true, isDirectory: true))
        let missing = try await PathCanonicalisation.canonicalise(here, real + "/link/src/new.ts")
        XCTAssertEqual(missing, ResolvedPath(path: real + "/project/src/new.ts", exists: false, isDirectory: false))
        let deeper = try await PathCanonicalisation.canonicalise(here, real + "/link/a/b/c.ts")
        XCTAssertEqual(deeper, ResolvedPath(path: real + "/project/a/b/c.ts", exists: false, isDirectory: false))
    }

    /// A machine answered by hand: canonicalising asks it and never this one.
    private struct FakeMachine: PathMachine {
        let kinds: [String: PathMachineKind]
        let links: [String: String]
        func stat(_ path: String) async throws -> PathMachineKind { kinds[path] ?? .absent }
        func realpath(_ path: String) async throws -> String { links[path] ?? path }
    }

    func testAsksThatMachineAndNeverThisOne() async throws {
        let host = FakeMachine(
            kinds: ["/srv": .directory, "/srv/app": .directory, "/data/app": .directory, "/data/app/x.ts": .file],
            links: ["/srv/app": "/data/app", "/srv/app/x.ts": "/data/app/x.ts"])
        let file = try await PathCanonicalisation.canonicalise(host, "/srv/app")
        XCTAssertEqual(file, ResolvedPath(path: "/data/app", exists: true, isDirectory: true))
        // A path that exists here but not there is absent.
        let absent = try await PathCanonicalisation.canonicalise(host, "/srv/app/new/thing.ts")
        XCTAssertEqual(absent, ResolvedPath(path: "/data/app/new/thing.ts", exists: false, isDirectory: false))
        let atRoot = try await PathCanonicalisation.canonicalise(FakeMachine(kinds: ["/": .directory], links: [:]), "/nothing")
        XCTAssertEqual(atRoot.path, "/nothing")
    }

    // MARK: waitReturn.ts

    private struct Selection: Equatable, Sendable {
        let context: String
        let presentation: String
    }

    private let a = Selection(context: "workspace:1111", presentation: "full")
    private let b = Selection(context: "workspace:2222", presentation: "full")
    private let agentBeside = Selection(context: "agent:3333", presentation: "beside")
    private let marker = "/tmp/devhub-wait-abc/marker"

    func testGoesBackToWhatWasSelectedBeforeTheOpen() {
        var returns = WaitSelectionReturns<Selection>()
        returns.push(marker, before: a, produced: b)
        XCTAssertEqual(returns.take(marker, current: b), a)
    }

    func testStaysPutWhenTheSelectionHasMovedOn() {
        var returns = WaitSelectionReturns<Selection>()
        returns.push(marker, before: a, produced: b)
        XCTAssertNil(returns.take(marker, current: agentBeside))
        var presentation = WaitSelectionReturns<Selection>()
        presentation.push(marker, before: a, produced: b)
        XCTAssertNil(presentation.take(marker, current: Selection(context: b.context, presentation: "beside")))
    }

    func testGoesBackToAnAgentShownTheWayItWasShown() {
        var returns = WaitSelectionReturns<Selection>()
        returns.push(marker, before: agentBeside, produced: b)
        XCTAssertEqual(returns.take(marker, current: b), agentBeside)
    }

    func testKnowsNothingAboutAMarkerItWasNeverToldAboutAndForgetsAWaitOnceEnded() {
        var returns = WaitSelectionReturns<Selection>()
        XCTAssertNil(returns.take(marker, current: a))
        returns.push(marker, before: a, produced: b)
        XCTAssertNil(returns.take(marker, current: agentBeside))
        XCTAssertEqual(returns.count, 0)
        XCTAssertNil(returns.take(marker, current: b))
    }

    func testKeepsNestedWaitsApartAndNeverUndoesALaterWaitsArrangement() {
        var returns = WaitSelectionReturns<Selection>()
        returns.push("/outer", before: a, produced: b)
        returns.push("/inner", before: b, produced: agentBeside)
        // The outer ends first: the inner's arrangement stands, nothing restored.
        XCTAssertNil(returns.take("/outer", current: agentBeside))
        XCTAssertEqual(returns.take("/inner", current: agentBeside), b)

        var nested = WaitSelectionReturns<Selection>()
        nested.push("/outer", before: a, produced: b)
        nested.push("/inner", before: b, produced: agentBeside)
        // Innermost first restores each in turn.
        XCTAssertEqual(nested.take("/inner", current: agentBeside), b)
        XCTAssertEqual(nested.take("/outer", current: b), a)
    }

    func testRestoresNothingWhenTheOpenChangedNothing() {
        var returns = WaitSelectionReturns<Selection>()
        returns.push(marker, before: agentBeside, produced: agentBeside)
        XCTAssertNil(returns.take(marker, current: agentBeside))
    }

    func testAWaitThatArrangedNothingStillCountsAsInFlight() {
        var returns = WaitSelectionReturns<Selection>()
        returns.push("/first", before: a, produced: b)
        returns.push("/second", before: b, produced: b)
        XCTAssertNil(returns.take("/first", current: b))
    }
}
