// Port of apps/desktop/src/main/cli/canonical.ts
//
// The one canonical spelling of a path, on the machine the path is on.
//
// Every Workspace root in the model is a `realpath`, so every path compared
// against one has to be a `realpath` too — two spellings of one folder is how
// a Workspace gets opened twice, and how a file inside a Workspace gets
// decided to be outside it.
//
// **On the machine the path is on.** A host's `/srv/app/src` has a host's
// symlinks in it, and resolving it here answers about this disk. So the
// filesystem this reaches is a `PathMachine`: this Mac (`LocalPathMachine`)
// or, later, a host's runtime (WP12).

import Foundation

public struct ResolvedPath: Equatable, Sendable {
    /// Canonical as far as the filesystem goes.
    public let path: String
    public let exists: Bool
    public let isDirectory: Bool

    public init(path: String, exists: Bool, isDirectory: Bool) {
        self.path = path
        self.exists = exists
        self.isDirectory = isDirectory
    }
}

/// What a path is on a machine, following symlinks.
public enum PathMachineKind: Equatable, Sendable {
    case absent
    case file
    case directory
    case other
}

/// As much of a machine as canonicalising needs: two questions, so a test can
/// answer them by hand and so this states exactly what it touches.
public protocol PathMachine: Sendable {
    func stat(_ path: String) async throws -> PathMachineKind
    func realpath(_ path: String) async throws -> String
}

/// This machine's filesystem.
public struct LocalPathMachine: PathMachine {
    public init() {}

    public func stat(_ path: String) async throws -> PathMachineKind {
        localPathKind(path)
    }

    public func realpath(_ path: String) async throws -> String {
        try localRealpath(path)
    }
}

/// `stat(2)` following symlinks, as a kind.
func localPathKind(_ path: String) -> PathMachineKind {
    var info = stat()
    guard stat(path, &info) == 0 else { return .absent }
    switch info.st_mode & S_IFMT {
    case S_IFDIR: return .directory
    case S_IFREG: return .file
    default: return .other
    }
}

func localRealpath(_ path: String) throws -> String {
    guard let resolved = realpath(path, nil) else {
        throw UnixStream.Failure(operation: "realpath", code: errno, path: path)
    }
    defer { free(resolved) }
    return String(cString: resolved)
}

public enum PathCanonicalisation {
    /// Canonicalise a path that may not exist yet.
    ///
    /// `realpath` refuses a path with a missing component, and a path DevHub
    /// is being asked to *create* is exactly that. So the deepest existing
    /// ancestor is resolved — that is where the symlinks are — and the missing
    /// tail is appended to it unchanged. A path that exists takes the first
    /// branch and is a plain `realpath`, which is what every Workspace root in
    /// the model already is.
    public static func canonicalise(_ machine: any PathMachine, _ path: String) async throws -> ResolvedPath {
        if try await machine.stat(path) != .absent {
            let resolved = try await machine.realpath(path)
            // Re-read after resolving, because what a symlink points at is what
            // the caller is about to open.
            return ResolvedPath(
                path: resolved, exists: true, isDirectory: try await machine.stat(resolved) == .directory)
        }
        let parent = dirname(path)
        if parent == path {
            throw ManagedNeovimError("cannot resolve \(path)")
        }
        let base = String(path.dropFirst(parent == "/" ? 1 : parent.count + 1))
        let resolvedParent = try await canonicalise(machine, parent)
        return ResolvedPath(path: join(resolvedParent.path, base), exists: false, isDirectory: false)
    }

    /// `path.posix.dirname`.
    static func dirname(_ path: String) -> String {
        if path.isEmpty { return "." }
        var trimmed = Substring(path)
        while trimmed.count > 1 && trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard let slash = trimmed.lastIndex(of: "/") else { return "." }
        if slash == trimmed.startIndex { return "/" }
        var parent = trimmed[..<slash]
        while parent.count > 1 && parent.hasSuffix("/") { parent.removeLast() }
        return String(parent)
    }

    /// `path.posix.join` of two parts.
    static func join(_ a: String, _ b: String) -> String {
        PathResolution.normalize(b.isEmpty ? a : a + "/" + b)
    }
}
