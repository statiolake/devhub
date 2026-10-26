import Foundation

/// The few JavaScript string and number behaviours ported logic relies on.
///
/// The TypeScript app's rules are written against JS semantics — what
/// `String.prototype.trim` strips, what `String(number)` prints — and a port
/// that used Swift's nearest equivalent would agree on every ordinary input and
/// disagree on the odd one (a `U+FEFF` in a display name, `1e-7` written back
/// into `settings.toml`). These are the exact behaviours, in one place.
public enum JSString {
    /// What `String.prototype.trim` removes: ECMAScript WhiteSpace and
    /// LineTerminator code points.
    public static func isWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        case 0x2000...0x200A:
            return true
        default:
            return false
        }
    }

    /// `text.trim()`.
    public static func trim(_ text: String) -> String {
        let scalars = Array(text.unicodeScalars)
        var start = 0
        var end = scalars.count
        while start < end, isWhitespace(scalars[start]) { start += 1 }
        while end > start, isWhitespace(scalars[end - 1]) { end -= 1 }
        var view = String.UnicodeScalarView()
        view.append(contentsOf: scalars[start..<end])
        return String(view)
    }

    /// `text.trimStart()`.
    public static func trimStart(_ text: String) -> String {
        let scalars = Array(text.unicodeScalars)
        var start = 0
        while start < scalars.count, isWhitespace(scalars[start]) { start += 1 }
        var view = String.UnicodeScalarView()
        view.append(contentsOf: scalars[start...])
        return String(view)
    }

    /// `String(value)` for a JS number (`Number.prototype.toString()`).
    ///
    /// Integers print without a fraction, the shortest round-trip digits are
    /// used, and the exponent form starts at 1e21 and below 1e-6, exactly as
    /// ECMAScript's Number::toString specifies.
    public static func number(_ value: Double) -> String {
        if value.isNaN { return "NaN" }
        if value.isInfinite { return value < 0 ? "-Infinity" : "Infinity" }
        if value == 0 { return "0" }
        if value < 0 { return "-" + number(-value) }
        // Swift's description is the shortest round-trip representation; take
        // its digits and decimal exponent and lay them out the JS way.
        let (digits, exponent) = shortestDigits(value)
        let k = digits.count
        let n = exponent // value = 0.digits × 10^n
        if k <= n && n <= 21 {
            return digits + String(repeating: "0", count: n - k)
        }
        if 0 < n && n <= 21 {
            let cut = digits.index(digits.startIndex, offsetBy: n)
            return String(digits[..<cut]) + "." + String(digits[cut...])
        }
        if -6 < n && n <= 0 {
            return "0." + String(repeating: "0", count: -n) + digits
        }
        let e = n - 1
        let sign = e < 0 ? "-" : "+"
        let mantissa = k == 1 ? digits : String(digits.prefix(1)) + "." + String(digits.dropFirst())
        return "\(mantissa)e\(sign)\(abs(e))"
    }

    /// The shortest decimal digits of a positive finite double and the
    /// exponent `n` with value = 0.d1d2… × 10^n.
    static func shortestDigits(_ value: Double) -> (String, Int) {
        var text = "\(value)" // e.g. "1.5", "1e-07", "1.2345e+21", "100.0"
        var exponent = 0
        if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            exponent = Int(text[text.index(after: e)...]) ?? 0
            text = String(text[..<e])
        }
        var integerPart = text
        var fractionPart = ""
        if let dot = text.firstIndex(of: ".") {
            integerPart = String(text[..<dot])
            fractionPart = String(text[text.index(after: dot)...])
        }
        var digits = integerPart + fractionPart
        var pointPosition = integerPart.count + exponent
        // Strip leading zeros (moving the point) and trailing zeros.
        while digits.hasPrefix("0") && digits.count > 1 {
            digits.removeFirst()
            pointPosition -= 1
        }
        while digits.hasSuffix("0") && digits.count > 1 { digits.removeLast() }
        return (digits, pointPosition)
    }

    /// Whether `value` is an integer the way `Number.isInteger` says.
    public static func isInteger(_ value: Double) -> Bool {
        value.isFinite && value.rounded(.towardZero) == value
    }

    /// The UTF-16 length, which is what `string.length` counts.
    public static func length(_ text: String) -> Int { text.utf16.count }

    /// `[...text].length`: code points.
    public static func codePointCount(_ text: String) -> Int { text.unicodeScalars.count }
}
