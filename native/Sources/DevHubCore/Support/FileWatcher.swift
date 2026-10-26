// Notice that a file changed.
//
// What counts as "changed" is the file's identity and contents as `stat` sees
// them — device, inode, size, modification time — so an editor that writes a
// new file and renames it over the old one (the usual way, and the way DevHub's
// own atomic saves work) is a change like any other, and a file that goes away
// and comes back is too.
//
// On macOS a `DispatchSource` on the file's descriptor (and on its directory,
// for the rename) wakes the watcher at once; the slow poll stays underneath it
// as the safety net, because a vnode source watches one inode and the file it
// watched can be replaced. On Linux there is no vnode source in Dispatch, so
// the poll is the watcher. Either way the callback hears one call per change
// it can see, never a call for a stat that did not move.
//
// `ConfigStore.watch` polls on its own, as the TypeScript app does; this is
// for the watchers that want to hear sooner (HEAD files, a theme being edited).

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif
import Foundation

public final class FileWatcher: @unchecked Sendable {
    /// What `stat` says about a file, or that it is not there.
    struct Signature: Equatable {
        var exists: Bool
        var device: UInt64 = 0
        var inode: UInt64 = 0
        var size: Int64 = 0
        var modifiedNanoseconds: Int64 = 0

        static func of(_ path: String) -> Signature {
            var info = stat()
            guard stat(path, &info) == 0 else { return Signature(exists: false) }
            #if canImport(Darwin)
            let seconds = Int64(info.st_mtimespec.tv_sec), nanos = Int64(info.st_mtimespec.tv_nsec)
            #else
            let seconds = Int64(info.st_mtim.tv_sec), nanos = Int64(info.st_mtim.tv_nsec)
            #endif
            return Signature(
                exists: true,
                device: UInt64(info.st_dev),
                inode: UInt64(info.st_ino),
                size: Int64(info.st_size),
                modifiedNanoseconds: seconds * 1_000_000_000 + nanos
            )
        }
    }

    public let path: String
    private let interval: Double
    private let onChange: @Sendable () -> Void
    private let queue = DispatchQueue(label: "devhub.filewatcher")
    private var last: Signature
    private var timer: DispatchSourceTimer?
    #if canImport(Darwin)
    private var sources: [DispatchSourceFileSystemObject] = []
    #endif

    /// Watch `path`, polling every `interval` seconds (the safety net on macOS,
    /// the watcher itself on Linux). `onChange` is called on a private queue.
    public init(path: String, interval: Double = 2, onChange: @escaping @Sendable () -> Void) {
        self.path = path
        self.interval = interval
        self.onChange = onChange
        self.last = Signature.of(path)
    }

    public func start() {
        queue.async { [self] in
            last = Signature.of(path)
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(50))
            timer.setEventHandler { [weak self] in self?.check() }
            timer.resume()
            self.timer = timer
            #if canImport(Darwin)
            armSources()
            #endif
        }
    }

    public func stop() {
        queue.sync {
            timer?.cancel()
            timer = nil
            #if canImport(Darwin)
            for source in sources { source.cancel() }
            sources = []
            #endif
        }
    }

    deinit {
        timer?.cancel()
        #if canImport(Darwin)
        for source in sources { source.cancel() }
        #endif
    }

    /// Compare with the last look; call back once if it moved. On the queue.
    private func check() {
        let now = Signature.of(path)
        guard now != last else { return }
        last = now
        #if canImport(Darwin)
        armSources()
        #endif
        onChange()
    }

    #if canImport(Darwin)
    /// A vnode source on the file (writes, deletes, renames) and one on its
    /// directory (a file renamed into place), re-made after every change
    /// because the inode they watch may be the one that was replaced.
    private func armSources() {
        for source in sources { source.cancel() }
        sources = []
        for target in [path, (path as NSString).deletingLastPathComponent] {
            let fd = open(target, O_EVTONLY)
            guard fd >= 0 else { continue }
            let source = DispatchSource.makeFileSystemObjectSource(
                fileDescriptor: fd,
                eventMask: [.write, .delete, .rename, .extend, .attrib, .link, .revoke],
                queue: queue
            )
            source.setEventHandler { [weak self] in self?.check() }
            source.setCancelHandler { close(fd) }
            source.resume()
            sources.append(source)
        }
    }
    #endif
}
