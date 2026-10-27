// Port of apps/desktop/src/main/voice/dictationStream.ts.
//
// One dictation as it is spoken: the recording so far, the utterances found
// in it, what of it is committed, and the tentative words of the utterance
// being spoken.
//
// Whisper is not a streaming recogniser, so streaming is done around it:
//
// - The recording is cut into *utterances* as it arrives (`Segmenter`): a
//   hysteresis energy test per 20 ms frame. An utterance starts after 200 ms
//   loud enough to be speech and ends after 400 ms quiet enough to be
//   silence; it keeps 300 ms either side; one shorter than 0.8 s is dropped;
//   one that runs 10 s without a pause is cut at its quietest moment in its
//   second half.
// - Each finished utterance is transcribed once, with the full decoder, and
//   that text is *committed*: it never changes.
// - While an utterance is still being spoken it is transcribed from its start
//   now and then for the tentative text — only when the recogniser is idle
//   and at least a second more has come in since the last time.
//
// The threshold follows the noise floor of the last few seconds (three times
// its 20th percentile), between a minimum and fixed maxima. Committed text is
// passed back as the prompt for what follows. A recogniser that is not `live`
// is only run once, at the end.

import Foundation

/// What has been heard so far in one dictation: `committed` only ever grows;
/// `tentative` is the words since the last pause, which may be rewritten.
public struct VoiceUpdate: Equatable, Sendable {
    public var committed: String
    public var tentative: String

    public init(committed: String, tentative: String) {
        self.committed = committed
        self.tentative = tentative
    }
}

public struct VadTuning: Equatable, Sendable {
    public var startSeconds = 0.2
    public var endSeconds = 0.4
    public var paddingSeconds = 0.3
    public var minUtteranceSeconds = 0.8
    public var maxUtteranceSeconds = 10.0
    public var startLevel = 0.03
    public var endLevel = 0.02
    public var minLevel = 0.01
    public var floorSeconds = 3.0
    /// A tentative pass needs at least this much new audio since the last one.
    public var partialEverySeconds = 1.0

    public init() {}
}

/// A stretch of the recording, in frames: `[start, end)`.
public struct Utterance: Equatable, Sendable {
    public var start: Int
    public var end: Int
    /// Cut because it ran too long, not at a pause.
    public var forced: Bool
}

public enum VoiceLevels {
    /// 20 ms, in samples.
    public static let frame = Int((Double(VoiceAudio.sampleRate) * 0.02).rounded())

    /// RMS of each whole 20 ms frame, 0 to 1.
    public static func frameLevels(_ samples: ArraySlice<Int16>) -> [Double] {
        let frames = samples.count / frame
        let base = samples.startIndex
        return (0..<frames).map { f in
            var sum: Double = 0
            for i in (base + f * frame)..<(base + (f + 1) * frame) {
                let v = Double(samples[i]) / 32768
                sum += v * v
            }
            return (sum / Double(frame)).squareRoot()
        }
    }

    /// The start and end thresholds over a noise floor.
    public static func thresholds(_ floor: Double, _ tuning: VadTuning) -> (start: Double, end: Double) {
        let start = max(tuning.minLevel, min(floor * 3, tuning.startLevel))
        return (start, start * tuning.endLevel / tuning.startLevel)
    }

    static func frames(_ seconds: Double) -> Int {
        max(1, Int((seconds * Double(VoiceAudio.sampleRate) / Double(frame)).rounded()))
    }
}

/// The utterances in a recording, frame by frame as it arrives.
public struct Segmenter: Sendable {
    private var levels: [Double] = []
    private let tuning: VadTuning
    private let startFrames: Int
    private let endFrames: Int
    private let paddingFrames: Int
    private let minFrames: Int
    private let maxFrames: Int
    private let floorFrames: Int
    private var loud = 0
    private var quiet = 0
    private var speechFrom: Int?
    private var lastVoice = 0
    private var lastEnd = 0

    public init(_ tuning: VadTuning = VadTuning()) {
        self.tuning = tuning
        startFrames = VoiceLevels.frames(tuning.startSeconds)
        endFrames = VoiceLevels.frames(tuning.endSeconds)
        paddingFrames = Int((tuning.paddingSeconds * Double(VoiceAudio.sampleRate) / Double(VoiceLevels.frame)).rounded())
        minFrames = VoiceLevels.frames(tuning.minUtteranceSeconds)
        maxFrames = max(minFrames, VoiceLevels.frames(tuning.maxUtteranceSeconds))
        floorFrames = VoiceLevels.frames(tuning.floorSeconds)
    }

    /// Frames fed so far.
    public var length: Int { levels.count }

    /// Where the utterance being spoken starts, padding included.
    public var open: Int? { speechFrom }

    /// The noise floor: the 20th-percentile level of the last `floorSeconds`.
    public func floor() -> Double {
        let recent = levels.suffix(floorFrames).sorted()
        return recent.isEmpty ? 0 : recent[Int(Double(recent.count) * 0.2)]
    }

    public mutating func feed(_ level: Double) -> Utterance? {
        let (start, end) = VoiceLevels.thresholds(floor(), tuning)
        let f = levels.count
        levels.append(level)
        guard let from = speechFrom else {
            loud = level >= start ? loud + 1 : 0
            if loud >= startFrames {
                speechFrom = max(lastEnd, f + 1 - loud - paddingFrames)
                lastVoice = f
                quiet = 0
            }
            return nil
        }
        if level >= end {
            lastVoice = f
            quiet = 0
        } else {
            quiet += 1
        }
        if quiet >= endFrames { return close(min(lastVoice + 1 + paddingFrames, f + 1)) }
        if f + 1 - from >= maxFrames { return split(f + 1) }
        return nil
    }

    /// The recording has ended: the utterance being spoken ends with it,
    /// however short.
    public mutating func flush() -> Utterance? {
        guard let from = speechFrom else { return nil }
        let utterance = Utterance(start: from, end: levels.count, forced: false)
        speechFrom = nil
        lastEnd = utterance.end
        return utterance
    }

    private mutating func close(_ endFrame: Int) -> Utterance? {
        let start = speechFrom!
        speechFrom = nil
        loud = 0
        lastEnd = endFrame
        return endFrame - start >= minFrames ? Utterance(start: start, end: endFrame, forced: false) : nil
    }

    /// Cut at the quietest frame of the second half; the rest is the next utterance.
    private mutating func split(_ endFrame: Int) -> Utterance {
        let start = speechFrom!
        var cut = start + (endFrame - start) / 2
        var f = cut
        while f < endFrame {
            if levels[f] < levels[cut] { cut = f }
            f += 1
        }
        speechFrom = cut
        lastEnd = cut
        return Utterance(start: start, end: cut, forced: true)
    }
}

/// One dictation, fed as it is recorded.
public actor DictationStream {
    private var samples: [Int16] = []
    private var segmenter: Segmenter
    private var pending: [(start: Int, end: Int)] = []
    private var first: Int?
    private var last = 0
    private var lastPartialAt = 0
    private var committed = ""
    private var tentative = ""
    private var busy: Task<Void, Never>?
    private var closed = false
    private var failure: Error?
    private let transcriber: any Transcriber
    private let language: VoiceLanguage
    private let onUpdate: @Sendable (VoiceUpdate) -> Void
    private let tuning: VadTuning

    public init(
        transcriber: any Transcriber, language: VoiceLanguage, tuning: VadTuning = VadTuning(),
        onUpdate: @escaping @Sendable (VoiceUpdate) -> Void
    ) {
        self.transcriber = transcriber
        self.language = language
        self.onUpdate = onUpdate
        self.tuning = tuning
        segmenter = Segmenter(tuning)
    }

    /// Seconds recorded so far.
    public var seconds: Double { Double(samples.count) / Double(VoiceAudio.sampleRate) }

    /// More of the recording, as 16-bit little-endian bytes.
    public func push(_ pcm: [UInt8]) {
        if closed { return }
        let count = pcm.count / 2
        samples.reserveCapacity(samples.count + count)
        for i in 0..<count {
            samples.append(Int16(bitPattern: UInt16(pcm[2 * i]) | (UInt16(pcm[2 * i + 1]) << 8)))
        }
        let done = segmenter.length
        let levels = VoiceLevels.frameLevels(samples[(done * VoiceLevels.frame)...])
        for level in levels {
            if let utterance = segmenter.feed(level) { found(utterance) }
        }
        pump()
    }

    /// The recording has ended: wait for what is running, transcribe what is
    /// left, and answer everything committed.
    public func finish() async throws -> String {
        closed = true
        while let running = busy { await running.value }
        if let failure { throw failure }
        if let rest = segmenter.flush() { found(rest, end: samples.count) }
        if transcriber.live {
            while !pending.isEmpty {
                let span = pending.removeFirst()
                try await final(span)
            }
        } else if let first {
            try await final((first, last))
        }
        tentative = ""
        onUpdate(VoiceUpdate(committed: committed, tentative: ""))
        return committed
    }

    /// Throw it away: nothing more is transcribed or reported.
    public func cancel() { closed = true }

    private func found(_ utterance: Utterance, end: Int? = nil) {
        let span = (start: utterance.start * VoiceLevels.frame, end: end ?? utterance.end * VoiceLevels.frame)
        if first == nil { first = span.start }
        last = span.end
        if transcriber.live { pending.append(span) }
    }

    private func options(partial: Bool) -> TranscribeOptions {
        TranscribeOptions(language: language, prompt: committed.isEmpty ? nil : String(committed.suffix(200)), partial: partial)
    }

    private func bytes(_ slice: ArraySlice<Int16>) -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(slice.count * 2)
        for sample in slice {
            let bits = UInt16(bitPattern: sample)
            out.append(UInt8(bits & 0xFF))
            out.append(UInt8(bits >> 8))
        }
        return out
    }

    private func final(_ span: (start: Int, end: Int)) async throws {
        let audio = bytes(samples[span.start..<min(span.end, samples.count)])
        let words = try await transcriber.transcribe(audio, options(partial: false))
        // Applied even after the recording ended: `finish` transcribes only what comes after it.
        committed = SpokenText.join(committed, words)
        tentative = ""
        if !closed { report() }
    }

    /// Start the next transcription, if one is due and none is running.
    private func pump() {
        if busy != nil || closed || !transcriber.live || failure != nil { return }
        guard let job = next() else { return }
        busy = Task {
            do {
                try await job()
            } catch {
                // A partial that failed fails the dictation: the final pass
                // would fail the same way.
                if self.failure == nil { self.failure = error }
            }
            self.busy = nil
            self.pump()
        }
    }

    private func next() -> (() async throws -> Void)? {
        if !pending.isEmpty {
            let span = pending.removeFirst()
            return { try await self.final(span) }
        }
        guard let open = segmenter.open else { return nil }
        let from = max(open * VoiceLevels.frame, lastPartialAt)
        if Double(samples.count - from) < tuning.partialEverySeconds * Double(VoiceAudio.sampleRate) { return nil }
        let at = samples.count
        lastPartialAt = at
        let audio = bytes(samples[(open * VoiceLevels.frame)..<at])
        return {
            let words = try await self.transcriber.transcribe(audio, self.options(partial: true))
            self.partialAnswered(words)
        }
    }

    private func partialAnswered(_ words: String) {
        if closed { return }
        tentative = words
        report()
    }

    private func report() {
        onUpdate(VoiceUpdate(committed: committed, tentative: tentative))
    }
}
