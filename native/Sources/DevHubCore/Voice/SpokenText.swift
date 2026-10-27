// Port of apps/desktop/src/model/spokenText.ts, and of the pure half of
// apps/desktop/src/shell/conversation/dictation.ts.
//
// Where dictated words meet other words, and whether a space goes between.
// Two places join text that was spoken: the recogniser's segments, and the
// composer putting a transcript in among what was already typed. Both follow
// one rule: Latin text meets with a space, and wherever either side is
// Japanese (or Chinese) it meets with none, because those scripts have no
// spaces to put back. Text that already has whitespace at the seam needs no
// more.

import Foundation

public enum SpokenText {
    private static let cjkScripts = TextPattern("[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]")

    /// Han, kana, and the CJK punctuation and full-width forms written with them.
    public static func isCjk(_ character: Character) -> Bool {
        guard let scalar = character.unicodeScalars.first else { return false }
        let code = scalar.value
        return cjkScripts.matches(String(character)) || (0x3000...0x303F).contains(code) || (0xFF00...0xFFEF).contains(code)
    }

    /// Whether `before` and `after` meet with a space.
    public static func needsSpace(_ before: Character?, _ after: Character?) -> Bool {
        guard let before, let after else { return false }
        return !isCjk(before) && !isCjk(after) && !before.isWhitespace && !after.isWhitespace
    }

    /// `joinSpoken`: `text` and `more` as one, with a space only where needed.
    public static func join(_ text: String, _ more: String) -> String {
        if more.isEmpty { return text }
        if text.isEmpty { return more }
        return needsSpace(text.last, more.first) ? "\(text) \(more)" : "\(text)\(more)"
    }
}

/// What the composer does with dictated words (`dictation.ts`).
public enum DictationText {
    /// How the shortcut is written wherever it is named.
    public static let key = "⌘⇧M"
    public static let microphoneDeniedTitle = "Microphone access is denied."
    public static let voiceFailedTitle = "Voice input failed."

    /// Where the next committed words of a dictation go, and the text as it
    /// was when the last went in. `start` to `end` is replaced: the selection,
    /// the first time; empty after. Offsets are in UTF-16 units, as a text
    /// view's selection is.
    public struct Anchor: Equatable, Sendable {
        public var start: Int
        public var end: Int
        public var text: String

        public init(start: Int, end: Int, text: String) {
            self.start = start
            self.end = end
            self.text = text
        }
    }

    /// `shiftAnchor`: where `at`, an index into `before`, is in `after` —
    /// `before` with one stretch of it replaced. An index before the change
    /// stays; one after it moves with the text after it; one inside the
    /// change goes to the end of what replaced it.
    public static func shiftAnchor(_ before: String, _ after: String, _ at: Int) -> Int {
        if before == after { return at }
        let b = Array(before.utf16), a = Array(after.utf16)
        var prefix = 0
        let shortest = min(b.count, a.count)
        while prefix < shortest && b[prefix] == a[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < shortest - prefix && b[b.count - 1 - suffix] == a[a.count - 1 - suffix] { suffix += 1 }
        if at <= prefix { return at }
        if at >= b.count - suffix { return at + a.count - b.count }
        return a.count - suffix
    }

    /// `insertDictation`: `words` in place of `[start, end)`, and where the
    /// caret goes after them. A space is added at a seam only where
    /// `needsSpace` says one belongs.
    public static func insert(_ text: String, start: Int, end: Int, words: String) -> (text: String, caret: Int) {
        if words.isEmpty { return (text, end) }
        let units = Array(text.utf16)
        let before = String(decoding: units[0..<min(start, units.count)], as: UTF16.self)
        let after = String(decoding: units[min(end, units.count)...], as: UTF16.self)
        let lead = SpokenText.needsSpace(before.last, words.first) ? " " : ""
        let trail = SpokenText.needsSpace(words.last, after.first) ? " " : ""
        let inserted = "\(lead)\(words)\(trail)"
        return ("\(before)\(inserted)\(after)", before.utf16.count + inserted.utf16.count)
    }

    /// `placeDictation`: `words` put in at `anchor` in `text`, allowing for
    /// edits since; and where the next words go.
    public static func place(_ text: String, anchor: Anchor, words: String) -> (text: String, caret: Int, anchor: Anchor) {
        let length = text.utf16.count
        let start = min(length, shiftAnchor(anchor.text, text, anchor.start))
        let end = max(start, min(length, shiftAnchor(anchor.text, text, anchor.end)))
        let next = insert(text, start: start, end: end, words: words)
        return (next.text, next.caret, Anchor(start: next.caret, end: next.caret, text: next.text))
    }
}

/// Which language the recogniser listens for (`VoiceLanguage`).
public enum VoiceLanguage: String, CaseIterable, Sendable {
    case ja, en, auto

    /// In the order the label cycles through them, the default first.
    public static let cycle: [VoiceLanguage] = [.ja, .en, .auto]
    public static let defaultLanguage = VoiceLanguage.ja

    public var label: String {
        switch self {
        case .auto: return "Auto"
        case .ja: return "日本語"
        case .en: return "English"
        }
    }

    /// The language after this one, for the label that cycles through them.
    public var next: VoiceLanguage {
        let index = Self.cycle.firstIndex(of: self) ?? 0
        return Self.cycle[(index + 1) % Self.cycle.count]
    }

    /// A saved choice, or the default.
    public static func saved(_ value: String?) -> VoiceLanguage {
        value.flatMap(VoiceLanguage.init(rawValue:)) ?? defaultLanguage
    }
}

/// The audio a recording is turned into (`ipc/voice.ts`).
public enum VoiceAudio {
    /// The sample rate Whisper is trained on, and the only one accepted.
    public static let sampleRate = 16_000
    /// The longest recording transcribed: dictation is a message, not a meeting.
    public static let maxSeconds = 300

    /// `downsample`: each output sample is the mean of the input samples its
    /// interval covers (a box filter).
    public static func downsample(_ samples: [Float], from fromRate: Double, to toRate: Double = Double(sampleRate)) -> [Float] {
        if fromRate == toRate { return samples }
        precondition(fromRate > toRate, "cannot upsample from \(fromRate) Hz to \(toRate) Hz")
        let ratio = fromRate / toRate
        let length = Int((Double(samples.count) / ratio).rounded(.down))
        return (0..<length).map { i in
            let start = Int((Double(i) * ratio).rounded(.down))
            let end = min(samples.count, Int((Double(i + 1) * ratio).rounded(.down)))
            guard end > start else { return 0 }
            var sum: Float = 0
            for j in start..<end { sum += samples[j] }
            return sum / Float(end - start)
        }
    }

    /// Float samples in [-1, 1] as 16-bit little-endian PCM bytes, clipped.
    public static func pcm16(_ samples: [Float]) -> [UInt8] {
        var bytes: [UInt8] = []
        bytes.reserveCapacity(samples.count * 2)
        for sample in samples {
            let clipped = max(-1, min(1, sample))
            // `Math.round`: half up, towards +∞.
            let value = Int16(((clipped < 0 ? clipped * 0x8000 : clipped * 0x7FFF) + 0.5).rounded(.down))
            let bits = UInt16(bitPattern: value)
            bytes.append(UInt8(bits & 0xFF))
            bytes.append(UInt8(bits >> 8))
        }
        return bytes
    }

    /// The loudness of a chunk, 0 to 1, for the button's pulse.
    public static func level(_ samples: [Float]) -> Double {
        guard !samples.isEmpty else { return 0 }
        var sum: Double = 0
        for sample in samples { sum += Double(sample) * Double(sample) }
        return min(1, (sum / Double(samples.count)).squareRoot() * 6)
    }
}

/// `downsample` for a recording that arrives in pieces: what does not fill a
/// whole output sample is kept for the next piece, so the pieces join with no
/// click and no drift.
public struct StreamingDownsampler: Sendable {
    private var carry: [Float] = []
    private var consumed = 0
    private var made = 0
    private let fromRate: Double
    private let toRate: Double

    public init(from fromRate: Double, to toRate: Double = Double(VoiceAudio.sampleRate)) {
        precondition(fromRate >= toRate, "cannot upsample from \(fromRate) Hz to \(toRate) Hz")
        self.fromRate = fromRate
        self.toRate = toRate
    }

    public mutating func push(_ samples: [Float]) -> [Float] {
        if fromRate == toRate { return samples }
        let input = carry + samples
        let ratio = fromRate / toRate
        var out: [Float] = []
        while true {
            let start = Int((Double(made) * ratio).rounded(.down)) - consumed
            let end = Int((Double(made + 1) * ratio).rounded(.down)) - consumed
            if end > input.count { break }
            var sum: Float = 0
            if end > start { for j in start..<end { sum += input[j] } }
            out.append(end > start ? sum / Float(end - start) : 0)
            made += 1
        }
        let keepFrom = Int((Double(made) * ratio).rounded(.down)) - consumed
        carry = Array(input[keepFrom...])
        consumed += keepFrom
        return out
    }
}
