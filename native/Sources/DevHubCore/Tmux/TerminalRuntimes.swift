// Port of apps/desktop/src/main/shell/terminalRuntimes.ts.
//
// One tmux adapter per machine, and one place that says so.
//
// There is one tmux server per machine, DevHub owns one socket on each of
// them, and `TmuxTerminalRuntime` speaks to exactly one server — so there is
// one adapter per machine and it is built the same way for every machine: its
// `$HOME` read from that machine, the configured shell resolved on it, its
// tmux obtained from it, and every command sent through its `exec`.
//
// The cache is not an optimisation: an adapter *owns* things — the in-flight
// bring-up per socket, the accepted tmux version, the operation gate a socket
// transition holds — and two of them for one machine would be two gates. It
// caches the *task* rather than the value, so two attaches that arrive
// together on a machine DevHub has not spoken to yet produce one adapter.

import Foundation

/// The parts of `[runtimes]` the tmux adapter is built from
/// (`RuntimeConfig` in `model/config.ts`; WP1's `Config` maps onto this).
public struct TmuxRuntimeSettings: Sendable, Equatable {
    /// `runtimes.tmux`.
    public var tmux: String
    /// `runtimes.shell`.
    public var shell: String
    /// `runtimes.tmux_args`.
    public var tmuxArgs: [String]

    public init(tmux: String = "tmux", shell: String = "/bin/zsh", tmuxArgs: [String] = []) {
        self.tmux = tmux
        self.shell = shell
        self.tmuxArgs = tmuxArgs
    }

    public static let defaults = TmuxRuntimeSettings()
}

public final class TerminalRuntimes: @unchecked Sendable {
    public struct Options: Sendable {
        /// The settings as they are now; nil before any config was accepted.
        public var settings: TmuxRuntimeSettings?
        /// `runtimes.tmux_socket_name`.
        public var effectiveSocketName: String
        /// `<configDirectory>/tmux.conf` on this Mac — the one user tmux
        /// config, profile-aware because the config directory is.
        public var userTmuxConfigPath: String
        /// This DevHub's control socket, on this Mac; read only to name a
        /// directory on *another* machine.
        public var controlSocketPath: String
        public var log: (@Sendable (String) -> Void)?
        public var count: (@Sendable (String) -> Void)?

        public init(
            settings: TmuxRuntimeSettings?,
            effectiveSocketName: String,
            userTmuxConfigPath: String,
            controlSocketPath: String,
            log: (@Sendable (String) -> Void)? = nil,
            count: (@Sendable (String) -> Void)? = nil
        ) {
            self.settings = settings
            self.effectiveSocketName = effectiveSocketName
            self.userTmuxConfigPath = userTmuxConfigPath
            self.controlSocketPath = controlSocketPath
            self.log = log
            self.count = count
        }
    }

    private let options: Options
    private let lock = NSLock()
    private var adapters: [RuntimeId: Task<TmuxTerminalRuntime, any Error>] = [:]
    private var socketName: String

    public init(_ options: Options) {
        self.options = options
        socketName = options.effectiveSocketName
    }

    /// The adapter for one machine, built if this is the first time it is
    /// asked for.
    public func adapter(for host: any MachineRuntime) async throws -> TmuxTerminalRuntime {
        let task: Task<TmuxTerminalRuntime, any Error> = lock.withLock {
            if let existing = adapters[host.id] { return existing }
            let built = Task { [self] in try await build(host) }
            adapters[host.id] = built
            return built
        }
        do {
            return try await task.value
        } catch {
            // A machine that could not be reached must not leave a failure in
            // the cache: a host that came back would never be tried again.
            lock.withLock {
                if adapters[host.id] == task { adapters[host.id] = nil }
            }
            throw error
        }
    }

    /// Every adapter that has been built, for shutdown and for a reading.
    public func live() async -> [TmuxTerminalRuntime] {
        let pending = lock.withLock { Array(adapters.values) }
        var built: [TmuxTerminalRuntime] = []
        for task in pending {
            if let adapter = try? await task.value { built.append(adapter) }
        }
        return built
    }

    /// Let go of a machine no Workspace is on any more. The tmux sessions on it
    /// stay: that is the point of the runtime.
    public func forget(_ machine: RuntimeId) {
        lock.withLock { _ = adapters.removeValue(forKey: machine) }
    }

    /// The socket every adapter is on, changed for all of them at once.
    public func setEffectiveSocket(_ name: SocketName) async {
        lock.withLock { socketName = name.rawValue }
        for adapter in await live() { adapter.setEffectiveSocket(name) }
    }

    private func build(_ host: any MachineRuntime) async throws -> TmuxTerminalRuntime {
        let settings = options.settings
        // The machine's own environment, asked of the machine.
        let environment = try await host.environment()
        let searchPath = environment["PATH"] ?? ""
        let configuredTmux = settings?.tmux ?? "tmux"
        let configuredShell = settings?.shell ?? "/bin/zsh"
        async let home = host.home()
        async let scratch = host.scratchDirectory()
        // Not `resolveProgram`: which tmux a machine runs is that machine's
        // answer to give.
        async let tmux = host.tmuxProgram(configuredTmux, searchPath: searchPath)
        async let shell = host.resolveProgram(configuredShell, searchPath: searchPath)
        let (resolvedHome, resolvedScratch, resolvedTmux, resolvedShell) = try await (home, scratch, tmux, shell)
        let executable: RuntimeExecutable
        var tmuxEnvironment: [String: String] = [:]
        switch resolvedTmux {
        case .unavailable(let reason):
            executable = .unavailable(reason: reason)
        case .resolved(let path, let environment):
            executable = .resolved(ResolvedExecutable(path: path, basename: TerminalRuntimes.basename(configuredTmux)))
            tmuxEnvironment = environment
        }
        return TmuxTerminalRuntime(TmuxTerminalRuntimeOptions(
            context: RuntimeLaunchContext(home: resolvedHome, environment: environment),
            tmux: executable,
            tmuxEnvironment: tmuxEnvironment,
            shell: resolvedShell.path.map { ResolvedExecutable(path: $0, basename: TerminalRuntimes.basename(configuredShell)) },
            tmuxArgs: settings?.tmuxArgs ?? [],
            effectiveSocketName: lock.withLock { socketName },
            // Only for a machine that is not this one, derived rather than
            // reported, so a session created before the first window on that
            // host still has the right PATH.
            paneBinDirectory: host.id.isLocal
                ? nil
                : TerminalLauncher.remoteCliBinDirectory(home: resolvedHome, controlSocketPath: options.controlSocketPath),
            bootstrapDirectory: resolvedScratch,
            // The path on *this* Mac: the adapter asks the machine on every
            // bring-up, so a config written after DevHub started is applied.
            userTmuxConfigSource: options.userTmuxConfigPath,
            host: host,
            log: options.log,
            count: options.count
        ))
    }

    static func basename(_ configured: String) -> String {
        configured.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? configured
    }
}

extension TmuxRuntimeSettings {
    /// The settings the config's `[runtimes]` table states.
    public init(_ runtimes: RuntimeConfig) {
        self.init(tmux: runtimes.tmux, shell: runtimes.shell, tmuxArgs: runtimes.tmuxArgs)
    }
}
