// Port of apps/desktop/src/shell/components/sidebar/promptCacheFacts.ts.
//
// An Agent's prompt cache, as the line its tooltip draws (S-13).

import Foundation

public enum PromptCacheFacts {
    /// Below this share of its TTL left, the cache line is drawn in the
    /// waiting colour.
    static let lowFraction = 0.2

    static func ttl(_ seconds: Double) -> String {
        seconds.truncatingRemainder(dividingBy: 3600) == 0
            ? "\(JsonValue.javaScriptNumber(seconds / 3600))h"
            : "\(JsonValue.javaScriptNumber((seconds / 60).rounded(.toNearestOrAwayFromZero)))m"
    }

    /// Time left, at the precision a countdown wants: minutes, then seconds in
    /// the last one.
    public static func timeLeft(_ ms: Double) -> String {
        let seconds = max(0, Int((ms / 1000).rounded(.up)))
        if seconds < 60 { return "\(seconds)s" }
        let minutes = Int((Double(seconds) / 60).rounded(.up))
        return minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m" : "\(minutes)m"
    }

    public static func tokenCount(_ tokens: Double) -> String {
        if tokens >= 1_000_000 { return "\(toFixed(tokens / 1_000_000, 1))M" }
        if tokens >= 1000 { return "\(Int((tokens / 1000).rounded(.toNearestOrAwayFromZero)))k" }
        return JsonValue.javaScriptNumber(tokens)
    }

    /// Warm: how long until it goes cold, against its TTL, and how well it has
    /// been used. Cold: what the next message will cost to cache again.
    /// Nothing at all for an Agent with no cache to speak of.
    public static func facts(_ cache: PromptCache?, now: Double) -> [RowFact] {
        guard let cache else { return [] }
        var stats: [String] = []
        if let ratio = cache.hitRatio { stats.append("hit \(Int((ratio * 100).rounded(.toNearestOrAwayFromZero)))%") }
        stats.append("misses \(cache.misses)")
        let left = cache.expiresAt.map { $0 - now } ?? 0
        if left > 0 {
            let low = left < cache.ttlSeconds * 1000 * lowFraction
            let lifetime = "\(ttl(cache.ttlSeconds)) TTL\(cache.ttlKnown ? "" : ", assumed")"
            var parts = ["Cache: warm", "\(timeLeft(left)) left (\(lifetime))"]
            if let compact = cache.autoCompactAt { parts.append("auto-compact in \(timeLeft(compact - now))") }
            parts += stats
            return [RowFact(
                icon: .checksPending,
                text: parts.joined(separator: " · "),
                spoken: "Prompt cache warm, \(timeLeft(left)) left",
                style: .muted,
                tone: low ? .waiting : .unknown
            )]
        }
        var parts = ["Cache: cold"]
        if let tokens = cache.recacheTokens { parts.append("next message re-caches \(tokenCount(tokens)) tokens") }
        parts += stats
        return [RowFact(icon: .checksPending, text: parts.joined(separator: " · "), spoken: "Prompt cache cold", style: .muted, tone: .unknown)]
    }

    /// `Number.prototype.toFixed(digits)` for a non-negative finite number:
    /// the exact decimal value of the double, rounded half up — not printf's
    /// half-to-even (1.25 is "1.3", as JavaScript writes it).
    static func toFixed(_ value: Double, _ digits: Int) -> String {
        let exact = String(format: "%.60f", value)
        guard let dot = exact.firstIndex(of: ".") else { return exact }
        let whole = Array(exact[..<dot])
        let fraction = Array(exact[exact.index(after: dot)...])
        var kept = whole + Array(fraction.prefix(digits))
        let next = fraction.count > digits ? fraction[digits] : "0"
        if next >= "5" {
            var index = kept.count - 1
            while index >= 0 {
                if kept[index] == "9" { kept[index] = "0"; index -= 1; continue }
                kept[index] = Character(String((kept[index].wholeNumberValue ?? 0) + 1))
                break
            }
            if index < 0 { kept.insert("1", at: 0) }
        }
        let wholeCount = kept.count - digits
        let text = String(kept[..<wholeCount]) + (digits > 0 ? "." + String(kept[wholeCount...]) : "")
        return text
    }
}
