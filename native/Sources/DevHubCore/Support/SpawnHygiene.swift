// What a child DevHub starts may inherit: its three standard streams, and
// nothing else.
//
// A descriptor of DevHub's that a child inherits stays open for as long as
// that child (or anything it forks) lives, whatever DevHub does with its own
// copy. A pipe's write end held by a host or a `tail -f` means the reader
// never sees the end of the stream; a descriptor DevHub has closed under a
// dispatch source but a child still holds keeps an epoll registration alive
// that libdispatch has already let go of. Every spawner in Core uses this, so
// no child can hold on to what another part of DevHub opened between its
// `pipe` and its `fcntl(FD_CLOEXEC)`.

import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

enum SpawnHygiene {
    #if canImport(Darwin)
    /// Every descriptor not named by a file action is closed in the child.
    static let spawnFlags = Int32(POSIX_SPAWN_CLOEXEC_DEFAULT)
    #else
    static let spawnFlags: Int32 = 0

    private typealias CloseFromAction = @convention(c) (UnsafeMutablePointer<posix_spawn_file_actions_t>, Int32) -> Int32
    /// `posix_spawn_file_actions_addclosefrom_np` (glibc 2.34): every
    /// descriptor from 3 up is closed in the child.
    private static let closeFromAction: CloseFromAction? = {
        guard let handle = dlopen(nil, RTLD_NOW),
              let symbol = dlsym(handle, "posix_spawn_file_actions_addclosefrom_np") else { return nil }
        return unsafeBitCast(symbol, to: CloseFromAction.self)
    }()
    #endif

    /// Add what closes every inherited descriptor from 3 up to a spawn's file
    /// actions (Linux); on macOS `spawnFlags` does it.
    #if canImport(Darwin)
    static func closeInherited(_ actions: inout posix_spawn_file_actions_t?) {}
    #else
    static func closeInherited(_ actions: inout posix_spawn_file_actions_t) {
        if let closeFromAction { _ = closeFromAction(&actions, 3) }
    }
    #endif

    typealias CloseFrom = @convention(c) (Int32) -> Void
    #if canImport(Glibc)
    /// `closefrom` (glibc 2.34).
    private static let closeFromCall: CloseFrom? = {
        guard let handle = dlopen(nil, RTLD_NOW), let symbol = dlsym(handle, "closefrom") else { return nil }
        return unsafeBitCast(symbol, to: CloseFrom.self)
    }()
    #endif

    /// The highest descriptor a forked child may have to close, worked out
    /// before the fork (nothing but async-signal-safe calls after it).
    static func descriptorCeiling() -> Int32 {
        var limit = rlimit()
        #if canImport(Glibc)
        let resource = __rlimit_resource_t(RLIMIT_NOFILE.rawValue)
        #else
        let resource = RLIMIT_NOFILE
        #endif
        guard getrlimit(resource, &limit) == 0 else { return 1024 }
        return Int32(clamping: min(UInt64(limit.rlim_cur), 65_536))
    }

    /// Prepared before a `fork`: what `closeInheritedAfterFork` calls.
    struct AfterFork {
        fileprivate let closeFrom: CloseFrom?
        fileprivate let ceiling: Int32
    }

    static func prepareForFork() -> AfterFork {
        #if canImport(Glibc)
        AfterFork(closeFrom: closeFromCall, ceiling: descriptorCeiling())
        #else
        AfterFork(closeFrom: nil, ceiling: descriptorCeiling())
        #endif
    }

    /// In a forked child, before `exec`: close every descriptor from 3 up.
    /// Only async-signal-safe calls.
    static func closeInheritedAfterFork(_ prepared: AfterFork) {
        if let closeFrom = prepared.closeFrom {
            closeFrom(3)
            return
        }
        var fd: Int32 = 3
        while fd < prepared.ceiling {
            _ = close(fd)
            fd += 1
        }
    }
}
