// Text handling the way the TS app's JavaScript strings did it.
//
// A Swift `String` compares and splits by grapheme cluster, so `"\r\n"` is one
// `Character` and `components(separatedBy: "\n")` does not cut it. tmux's
// answers and a pane's screen are cut by the byte DevHub framed them with, as
// `String.prototype.split` cuts them; every split in the tmux runtime and the
// screen rules goes through here.

import Foundation

extension String {
    /// `split(separator)` as JavaScript does it, for a one-scalar separator:
    /// every occurrence cuts, empty pieces are kept.
    func scalarSplit(_ separator: Unicode.Scalar) -> [String] {
        var pieces: [String] = []
        var current = String.UnicodeScalarView()
        for scalar in unicodeScalars {
            if scalar == separator {
                pieces.append(String(current))
                current = String.UnicodeScalarView()
            } else {
                current.append(scalar)
            }
        }
        pieces.append(String(current))
        return pieces
    }

    /// Whether the text ends with this scalar.
    func scalarHasSuffix(_ scalar: Unicode.Scalar) -> Bool { unicodeScalars.last == scalar }

    /// Whether the text starts with this scalar.
    func scalarHasPrefix(_ scalar: Unicode.Scalar) -> Bool { unicodeScalars.first == scalar }

    /// The text without its first `count` scalars.
    func scalarDropFirst(_ count: Int = 1) -> String { String(String.UnicodeScalarView(unicodeScalars.dropFirst(count))) }

    /// The text without its last `count` scalars.
    func scalarDropLast(_ count: Int = 1) -> String { String(String.UnicodeScalarView(unicodeScalars.dropLast(count))) }

    /// Whether the text contains this scalar.
    func scalarContains(_ scalar: Unicode.Scalar) -> Bool { unicodeScalars.contains(scalar) }
}
