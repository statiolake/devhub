// An attach transport with no tmux behind it: every surface key attaches, the
// client "starts" at once, a banner is the first output, and what is typed
// comes back as output — the frame contract (`started`, sequenced `output`,
// acknowledgements, resizes, detach) end to end, so the App's `--self-test`
// can prove a terminal surface attaches, draws, types and resizes on a CI
// runner that has no tmux, and a Linux test can drive a surface session
// against it.

import Foundation

public final class LoopbackTransport: TerminalAttachTransport, @unchecked Sendable {
    public struct Attachment: Equatable, Sendable {
        public var surfaceKey: String
        public var viewLabel: String
        public var attachmentId: String
        public var size: TerminalSize
    }

    private let lock = NSLock()
    private let banner: @Sendable (String) -> String
    private var sinks: [String: TerminalFrameSink] = [:]
    private var sequences: [String: Int] = [:]
    private var attached: [Attachment] = []
    private var detachedIds: [String] = []
    private var resized: [(attachmentId: String, size: TerminalSize)] = []
    private var typed: [String: Data] = [:]
    private var acknowledged: [String: Int] = [:]
    private var serial = 0

    public init(banner: @escaping @Sendable (String) -> String = { "DevHub loopback: \($0)\r\n" }) {
        self.banner = banner
    }

    public func attach(surfaceKey: String, viewLabel: String, size: TerminalSize, sink: @escaping TerminalFrameSink) async throws
        -> TerminalAttachReceipt
    {
        let receipt: TerminalAttachReceipt = lock.withLock {
            serial += 1
            let id = "loopback-\(serial)"
            sinks[id] = sink
            sequences[id] = 0
            attached.append(Attachment(surfaceKey: surfaceKey, viewLabel: viewLabel, attachmentId: id, size: size))
            return TerminalAttachReceipt(attachmentId: id, surfaceKey: surfaceKey, targetGeneration: 1)
        }
        // The client is up as soon as it is asked for, and says so after the
        // attach has answered, as a real one does.
        let text = banner(surfaceKey)
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.02) { [weak self] in
            guard let self else { return }
            _ = sink(.started(
                attachmentId: receipt.attachmentId, surfaceKey: surfaceKey, targetGeneration: 1, cols: size.cols, rows: size.rows))
            self.emit(receipt.attachmentId, Data(text.utf8))
        }
        return receipt
    }

    private func emit(_ attachmentId: String, _ bytes: Data) {
        let next: (TerminalFrameSink, Int)? = lock.withLock {
            guard let sink = sinks[attachmentId], let sequence = sequences[attachmentId] else { return nil }
            sequences[attachmentId] = sequence + 1
            return (sink, sequence + 1)
        }
        guard let (sink, sequence) = next else { return }
        _ = sink(.output(attachmentId: attachmentId, sequence: sequence, bytes: bytes))
    }

    public func input(_ identity: TerminalRequestIdentity, sequence: Int, _ bytes: Data) throws {
        let known: Bool = lock.withLock {
            guard sinks[identity.attachmentId] != nil else { return false }
            typed[identity.attachmentId, default: Data()].append(bytes)
            return true
        }
        if !known { throw TerminalFailure(.wrongAttachment) }
        let id = identity.attachmentId
        DispatchQueue.global().async { [weak self] in self?.emit(id, bytes) }
    }

    public func resize(_ identity: TerminalRequestIdentity, _ size: TerminalSize) throws {
        lock.withLock { resized.append((identity.attachmentId, size)) }
    }

    public func acknowledge(_ identity: TerminalRequestIdentity, sequence: Int) throws {
        lock.withLock { acknowledged[identity.attachmentId] = sequence }
    }

    public func detach(_ identity: TerminalRequestIdentity) throws {
        lock.withLock {
            sinks[identity.attachmentId] = nil
            detachedIds.append(identity.attachmentId)
        }
    }

    // MARK: What happened

    public var attachments: [Attachment] { lock.withLock { attached } }
    public var detached: [String] { lock.withLock { detachedIds } }
    public var resizes: [(attachmentId: String, size: TerminalSize)] { lock.withLock { resized } }
    public func typed(_ attachmentId: String) -> Data { lock.withLock { typed[attachmentId] ?? Data() } }
    public func acknowledgedUpTo(_ attachmentId: String) -> Int { lock.withLock { acknowledged[attachmentId] ?? 0 } }

    /// The newest attachment of a surface key that is still attached.
    public func live(_ surfaceKey: String) -> Attachment? {
        lock.withLock { attached.last { $0.surfaceKey == surfaceKey && sinks[$0.attachmentId] != nil } }
    }
}
