// Lines out of a stream of byte chunks.
//
// Everything DevHub reads from a child or a socket line by line — the control
// socket's one JSON object per line, a CLI's stream-json, a journal followed
// with `tail` — arrives as chunks that do not respect line ends. This joins and
// splits them the way Node's `readline` does for those readers: on `\n`, with a
// `\r` before it dropped, a final line without a newline delivered at the end,
// and bytes decoded as UTF-8 only once a whole line is in hand (a multi-byte
// character split across two chunks is not mangled).

import Foundation

/// Splits chunks into lines; the incremental core of `AsyncLineReader`.
public struct LineSplitter: Sendable {
    private var pending: [UInt8] = []
    /// A line longer than this is delivered in pieces rather than held for ever.
    public let maxLineBytes: Int

    public init(maxLineBytes: Int = 64 * 1024 * 1024) {
        self.maxLineBytes = maxLineBytes
    }

    /// The whole lines `chunk` completes.
    public mutating func push(_ chunk: Data) -> [String] {
        var lines: [String] = []
        for byte in chunk {
            if byte == 0x0A {
                lines.append(take())
            } else {
                pending.append(byte)
                if pending.count >= maxLineBytes { lines.append(take()) }
            }
        }
        return lines
    }

    /// The last line, when the stream ended without a newline.
    public mutating func finish() -> String? {
        pending.isEmpty ? nil : take()
    }

    private mutating func take() -> String {
        if pending.last == 0x0D { pending.removeLast() }
        let line = String(decoding: pending, as: UTF8.self)
        pending.removeAll(keepingCapacity: true)
        return line
    }
}

/// The lines of an asynchronous sequence of chunks.
public struct AsyncLineReader<Base: AsyncSequence & Sendable>: AsyncSequence, Sendable where Base.Element == Data {
    public typealias Element = String
    let base: Base
    let maxLineBytes: Int

    public init(_ base: Base, maxLineBytes: Int = 64 * 1024 * 1024) {
        self.base = base
        self.maxLineBytes = maxLineBytes
    }

    public struct AsyncIterator: AsyncIteratorProtocol {
        var base: Base.AsyncIterator
        var splitter: LineSplitter
        var ready: [String] = []
        var done = false

        public mutating func next() async throws -> String? {
            while ready.isEmpty {
                if done { return nil }
                if let chunk = try await base.next() {
                    ready = splitter.push(chunk)
                } else {
                    done = true
                    if let last = splitter.finish() { ready = [last] }
                }
            }
            return ready.removeFirst()
        }
    }

    public func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator(base: base.makeAsyncIterator(), splitter: LineSplitter(maxLineBytes: maxLineBytes))
    }
}

extension AsyncSequence where Self: Sendable, Element == Data {
    /// This stream's lines.
    public var textLines: AsyncLineReader<Self> { AsyncLineReader(self) }
}
