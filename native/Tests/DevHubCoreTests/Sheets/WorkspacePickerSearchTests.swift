// Port of apps/desktop/src/main/shell/workspacePicker.test.ts, and of the pool
// half of WorkspacePicker.tsx.
import XCTest
@testable import DevHubCore

final class WorkspacePickerSearchTests: XCTestCase {
    var root = ""

    override func setUp() {
        root = NSTemporaryDirectory() + "picker-\(UUID().uuidString.prefix(8))"
        try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: root)
    }

    func mkdir(_ parts: String...) {
        try? FileManager.default.createDirectory(atPath: ([root] + parts).joined(separator: "/"), withIntermediateDirectories: true)
    }

    func config(_ sources: [WorkspaceSource]) -> Config {
        var config = Config.defaults
        config.workspaceSources = sources
        return config
    }

    func directories(_ id: String, _ path: String, min: Double = 1, max: Double = 1) -> WorkspaceSource {
        .filesystem(FilesystemSource(id: id, path: path, minDepth: min, maxDepth: max, kinds: [.directory], includeHidden: false, excludeNames: []))
    }

    func run(_ config: Config, query: String = "", now: Date = Date()) async -> [WorkspacePickerEvent] {
        let events = Guarded<[WorkspacePickerEvent]>([])
        await WorkspacePickerSearch.run(config, query: query, now: now, home: root) { event in events.with { $0.append(event) } }
        return events.with { $0 }
    }

    func candidates(_ events: [WorkspacePickerEvent]) -> [WorkspacePickerCandidate] {
        events.compactMap { if case let .candidate(candidate) = $0 { return candidate } else { return nil } }
    }

    func testTagsEveryCandidateWithTheSourceThatNamedItAndItsRank() async {
        mkdir("alpha", "one")
        mkdir("beta", "two")
        let events = await run(config([directories("a", "\(root)/alpha"), directories("b", "\(root)/beta")]))
        let found = candidates(events).sorted { $0.path < $1.path }
        XCTAssertEqual(found.map(\.path), ["\(root)/alpha/one", "\(root)/beta/two"])
        XCTAssertEqual(found.map(\.sourceId), ["a", "b"])
        XCTAssertEqual(found.map(\.sourceRank), [0, 1])
        guard case .started(2)? = events.first, case .completed(2, 0, false)? = events.last else {
            return XCTFail("\(events)")
        }
    }

    func testLetsBothSourcesOfferAPathTheyBothNameAndThePoolKeepsTheEarlier() async {
        mkdir("shared")
        let events = await run(config([directories("first", root), directories("second", root)]))
        XCTAssertEqual(candidates(events).count, 2)
        var pool = WorkspacePickerPool()
        for candidate in candidates(events).sorted(by: { $0.sourceRank > $1.sourceRank }) { pool.add(candidate) }
        XCTAssertEqual(pool.candidates.count, 1)
        XCTAssertEqual(pool.candidates[0].sourceRank, 0)
    }

    func testSaysWhichFoldersAreWorktrees() async throws {
        mkdir("repository", ".git")
        mkdir("worktree")
        try "gitdir: ../repository/.git/worktrees/worktree\n".write(toFile: "\(root)/worktree/.git", atomically: true, encoding: .utf8)
        mkdir("plain")
        let found = candidates(await run(config([directories("all", root)]))).sorted { $0.path < $1.path }
        XCTAssertEqual(found.map(\.worktree), [false, false, true])
        let kinds = WorkspaceSource.filesystem(FilesystemSource(
            id: "git", path: root, minDepth: 1, maxDepth: 1, kinds: [.gitRepository], includeHidden: false, excludeNames: []))
        let repositories = await run(config([kinds]))
        XCTAssertEqual(candidates(repositories).map(\.path), ["\(root)/repository"])
    }

    func testSkipsHiddenAndExcludedNamesAndWalksToTheDepthItWasGiven() async {
        mkdir(".hidden")
        mkdir("node_modules")
        mkdir("code", "deep")
        let source = WorkspaceSource.filesystem(FilesystemSource(
            id: "all", path: root, minDepth: 2, maxDepth: 2, kinds: [.directory], includeHidden: false, excludeNames: ["node_modules"]))
        let walked = await run(config([source]))
        XCTAssertEqual(candidates(walked).map(\.path), ["\(root)/code/deep"])
    }

    func testAQueryOffersOnlyWhatItMatches() async {
        mkdir("devhub")
        mkdir("gizmo")
        let matched = await run(config([directories("all", root)]), query: "dvh")
        XCTAssertEqual(candidates(matched).map(\.label), ["devhub"])
    }

    func testADateSourceOffersTodaysFolderAndOneNothingHasMadeYet() async {
        let now = DateComponents(calendar: Calendar.current, year: 2026, month: 9, day: 1, hour: 23, minute: 59, second: 59).date!
        let template = "[\(root)]/YYYY/MMDD"
        let missing = await run(config([.date(DateSource(id: "daily", path: template, createIfMissing: true))]), now: now)
        XCTAssertEqual(candidates(missing).map(\.path), ["\(root)/2026/0901"])
        XCTAssertEqual(candidates(missing).map(\.missing), [true])
        XCTAssertFalse(missing.contains { if case .sourceError = $0 { return true } else { return false } })
        let quiet = await run(config([.date(DateSource(id: "daily", path: template, createIfMissing: false))]), now: now)
        XCTAssertEqual(candidates(quiet), [])
        mkdir("2026", "0901")
        let there = await run(config([.date(DateSource(id: "daily", path: template, createIfMissing: false))]), now: now)
        XCTAssertEqual(candidates(there).map(\.missing), [false])
    }

    func testACommandSourceOffersTheAbsolutePathsItPrints() async {
        let source = WorkspaceSource.command(CommandSource(id: "cmd", command: ["/bin/sh", "-c", "echo /a/one; echo relative; echo; echo /b/two"]))
        let found = candidates(await run(config([source])))
        XCTAssertEqual(found.map(\.path), ["/a/one", "/b/two"])
        XCTAssertEqual(found.map(\.label), ["one", "two"])
    }

    func testASourceThatFailsIsOneSourceFailingNotTheSearch() async {
        mkdir("alpha")
        let events = await run(config([
            .command(CommandSource(id: "broken", command: ["/bin/sh", "-c", "exit 3"])),
            directories("missing-root", "\(root)/nowhere"),
            directories("good", root),
        ]))
        let errors = events.filter { if case .sourceError = $0 { return true } else { return false } }
        XCTAssertEqual(errors.count, 2)
        XCTAssertEqual(candidates(events).map(\.path), ["\(root)/alpha"])
    }

    func testACommandThatOutlivesItsTimeoutIsKilled() async {
        let started = Date()
        let events = await run(config([.command(CommandSource(id: "slow", command: ["/bin/sh", "-c", "sleep 30"], timeoutMs: 200))]))
        XCTAssertLessThan(Date().timeIntervalSince(started), 10)
        XCTAssertTrue(events.contains { if case .sourceError("slow", _, _) = $0 { return true } else { return false } })
    }

    func testACancelledSearchSaysSoAndKillsWhatIsRunning() async {
        let events = Guarded<[WorkspacePickerEvent]>([])
        let source = WorkspaceSource.command(CommandSource(id: "slow", command: ["/bin/sh", "-c", "sleep 30"], timeoutMs: 30_000))
        let root = self.root
        let config = self.config([source])
        let task = Task {
            await WorkspacePickerSearch.run(config, query: "", home: root) { event in events.with { $0.append(event) } }
        }
        try? await Task.sleep(nanoseconds: 200_000_000)
        let started = Date()
        task.cancel()
        await task.value
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        XCTAssertEqual(events.with { $0.last }, .cancelled)
    }

    func testTheFoldersACloneCouldGoIntoAreTheParentsOfWhatTheSourcesFind() async throws {
        mkdir("code", "alpha")
        mkdir("code", "beta")
        mkdir("work", "gamma")
        let parents = try await WorkspacePickerSearch.parentDirectories(config([directories("all", root, min: 2, max: 2)]), home: root)
        XCTAssertEqual(parents.sorted(), ["\(root)/code", "\(root)/work"])
        mkdir("second", "b")
        mkdir("first", "a")
        let ordered = try await WorkspacePickerSearch.parentDirectories(
            config([directories("one", "\(root)/first"), directories("two", "\(root)/second")]), home: root)
        XCTAssertEqual(ordered, ["\(root)/first", "\(root)/second"])
        let none = try await WorkspacePickerSearch.parentDirectories(config([]), home: root)
        XCTAssertEqual(none, [])
    }

    func testThePoolOnlyEverGrowsAndReadsDownTheSources() {
        var pool = WorkspacePickerPool()
        func candidate(_ path: String, _ rank: Int) -> WorkspacePickerCandidate {
            WorkspacePickerCandidate(path: path, label: path, score: 1, sourceId: "s\(rank)", sourceRank: rank, missing: false, worktree: false)
        }
        XCTAssertTrue(pool.add(candidate("/b", 1)))
        XCTAssertTrue(pool.add(candidate("/a", 0)))
        XCTAssertTrue(pool.add(candidate("/c", 1)))
        XCTAssertFalse(pool.add(candidate("/b", 2)))
        XCTAssertEqual(pool.candidates.map(\.path), ["/a", "/b", "/c"])
        XCTAssertTrue(pool.add(candidate("/c", 0)))
        XCTAssertEqual(pool.candidates.map(\.path), ["/a", "/c", "/b"])
        var missing = candidate("/today", 0)
        missing.missing = true
        pool.add(missing)
        XCTAssertEqual(pool.items.first { $0.id == "/today" }?.detail, .path("/today", suffix: " — not created yet"))
    }

    func testThePickerSaysWhetherThereAreNoSourcesOrNothingFound() {
        let none = SheetRows.workspacePicker(pool: WorkspacePickerPool(), busy: false, sourceCount: 0)
        XCTAssertTrue(none.emptyNoItems!.hasPrefix("No workspace sources yet."))
        let nothing = SheetRows.workspacePicker(pool: WorkspacePickerPool(), busy: false, sourceCount: 2)
        XCTAssertEqual(nothing.emptyNoItems, "No workspaces found in the configured sources.")
        XCTAssertEqual(none.pinned.map(\.label), ["New Project…", "Clone Project…", "Other…"])
    }
}
