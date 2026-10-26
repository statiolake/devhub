// Port of apps/desktop/src/model/scratchDay.ts and the folder-making half of
// apps/desktop/src/main/shell/scratchDay.ts (`scratchDay`, `ScratchFollower`).
// The Workspace the TS `scratchDay` wraps the folder in is the model's (WP2):
// here the answer is the folder and why it could not be made.
//
// Scratch is today's daily folder: `[scratch] daily` in `settings.toml`.
//
// The setting is a path in the one date language DevHub has, `DateTemplate` —
// the same tokens a `workspace_sources` entry of type `date` takes (`YYYY`,
// `MM`, `DD`, `MMDD`, …, `[...]` for literal text). The default is
// `~/junk/YYYYMMDD`.
//
// What makes a value refused (`problem`) is the date language's own two
// mistakes — an unclosed bracket, a token hiding inside a word — plus one of
// Scratch's: it has to name *a day*. A path that names no date is one folder
// forever, and one with `HH` or `mm` in it names a new folder every hour or
// minute; neither is today's folder, and both are refused rather than quietly
// producing a Scratch that moves when nobody expects it.

import Foundation

/// Why a `daily` value is refused.
public enum ScratchDailyProblem: Equatable, Sendable {
    case notAPath
    case unbalancedBrackets
    case ambiguous(segment: String)
    case notOneDay
}

public enum ScratchDaily {
    public static let defaultTemplate = ConfigConstants.defaultScratchDaily

    /// What is wrong with this `daily` value, if anything.
    public static func problem(_ template: String) -> ScratchDailyProblem? {
        if template.isEmpty || template.contains("\0") || (!template.hasPrefix("/") && !template.hasPrefix("~/")) {
            return .notAPath
        }
        if !DateTemplate.bracketsBalance(template) { return .unbalancedBrackets }
        if let ambiguity = DateTemplate.ambiguity(template) { return .ambiguous(segment: ambiguity.segment) }
        // One folder per day: the same all day long, and a different one tomorrow.
        let morning = LocalMoment(year: 2001, month: 2, day: 3, hour: 0, minute: 0, second: 0)
        let night = LocalMoment(year: 2001, month: 2, day: 3, hour: 23, minute: 59, second: 59)
        let tomorrow = LocalMoment(year: 2001, month: 2, day: 4, hour: 0, minute: 0, second: 0)
        let today = DateTemplate.expand(template, now: morning)
        if DateTemplate.expand(template, now: night) != today || DateTemplate.expand(template, now: tomorrow) == today {
            return .notOneDay
        }
        return nil
    }

    /// Today's folder as the setting spells it, `~` still unexpanded.
    ///
    /// Throws on a value `problem` would refuse: the settings reader refuses
    /// those first, so one arriving here is a broken invariant.
    public static func path(_ template: String, now: LocalMoment) throws -> String {
        if problem(template) != nil {
            throw InvariantViolation("scratch.daily is not a valid template: \(template)")
        }
        return DateTemplate.expand(template, now: now)
    }

    /// `~/…` against this machine's home; an absolute path as it is.
    public static func expandHome(_ path: String, home: String) -> String {
        if path == "~" { return home }
        if path.hasPrefix("~/") {
            var trimmed = home
            while trimmed.hasSuffix("/") { trimmed.removeLast() }
            return trimmed + path.dropFirst()
        }
        return path
    }

    /// The first instant of the local day after `now`.
    ///
    /// Built from the local calendar rather than by adding 24 hours, so a day
    /// that is 23 or 25 hours long (a DST change) still ends at its own midnight.
    public static func nextLocalMidnight(_ now: Date, timeZone: TimeZone = .current) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let start = calendar.startOfDay(for: now)
        return calendar.date(byAdding: .day, value: 1, to: start) ?? now.addingTimeInterval(86_400)
    }
}

/// Today's Scratch folder, made on disk.
public struct ScratchFolder: Equatable, Sendable {
    /// The folder: canonical when it was made, as the setting spells it (with
    /// `~` expanded) when it could not be.
    public let path: String
    /// Why the folder is not there, when it could not be made.
    public let failure: String?

    /// Make today's folder under `daily` and resolve it.
    ///
    /// A folder that cannot be made is not a reason for DevHub not to start,
    /// and not a thing to hide: the answer comes back with the path as the
    /// setting spells it and `failure` says why, and the caller marks the row
    /// unavailable and reports the sentence — so the row says what is wrong in
    /// the place it is wrong.
    public static func make(daily: String, now: Date, home: String) throws -> ScratchFolder {
        let path = ScratchDaily.expandHome(try ScratchDaily.path(daily, now: LocalMoment(now)), home: home)
        let fm = FileManager.default
        do {
            try fm.createDirectory(atPath: path, withIntermediateDirectories: true)
            let canonical = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
            var isDirectory: ObjCBool = false
            guard fm.fileExists(atPath: canonical, isDirectory: &isDirectory), isDirectory.boolValue else {
                throw ScratchFolderError(message: "\(canonical) is not a folder")
            }
            return ScratchFolder(path: canonical, failure: nil)
        } catch {
            return ScratchFolder(path: path, failure: "Today's Scratch folder \(path) could not be made: \(failureText(error))")
        }
    }

    struct ScratchFolderError: Error, CustomStringConvertible {
        let message: String
        var description: String { message }
    }
}

/// The sentence a failure is told with: its own description, not Foundation's
/// boilerplate around it.
func failureText(_ error: Error) -> String {
    guard type(of: error) is NSError.Type else { return String(describing: error) }
    let ns = error as NSError
    if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
        return underlying.localizedDescription
    }
    return ns.localizedDescription
}

/// Keeps Scratch on today's folder under the `daily` DevHub is running on.
///
/// Launch is not here: the model is built with today's Scratch already in it.
/// From then on, every moment that can change the answer — a new day, a wake
/// (a timer cannot see a midnight slept through), settings accepted with a
/// different `daily` — works it out again from the clock and the current
/// `daily` and hands it to `adopt`; adopting the same folder twice is a no-op,
/// so asking too often costs nothing and asking too rarely is the only way to
/// be wrong.
public actor ScratchFollower {
    private var daily: String
    private let home: String
    private let adopt: @Sendable (ScratchFolder) async -> Void
    private let clock: @Sendable () -> Date
    private var timer: Task<Void, Never>?

    public init(
        daily: String,
        home: String,
        clock: @escaping @Sendable () -> Date = { Date() },
        adopt: @escaping @Sendable (ScratchFolder) async -> Void
    ) {
        self.daily = daily
        self.home = home
        self.clock = clock
        self.adopt = adopt
    }

    /// Aim at the next midnight. Launch already made today's Scratch.
    public func start() { arm() }

    /// Settings were accepted — from the Settings window or from the file. A
    /// different `daily` names a different folder for today, and that folder
    /// is Scratch from now on; the old one stays as an ordinary row.
    public func settingsAccepted(daily: String) async {
        if daily == self.daily { return }
        self.daily = daily
        await catchUp()
    }

    /// A Mac asleep across midnight wakes to a timer aimed at a moment that has passed.
    public func resumed() async { await catchUp() }

    public func stop() {
        timer?.cancel()
        timer = nil
    }

    private func catchUp() async {
        arm()
        await followToday()
    }

    private func arm() {
        stop()
        let now = clock()
        let delay = max(0, ScratchDaily.nextLocalMidnight(now).timeIntervalSince(now))
        timer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            await self.fired()
        }
    }

    private func fired() async {
        timer = nil
        arm()
        await followToday()
    }

    private func followToday() async {
        guard let folder = try? ScratchFolder.make(daily: daily, now: clock(), home: home) else { return }
        await adopt(folder)
    }
}
