// Port of apps/desktop/src/model/invariant.ts

/// A fact DevHub believed about itself, found to be false.
///
/// Raised anywhere — the model's coordinator included, for a completion of an
/// operation it never started — and never drawn: the app crashes on it,
/// because the stack at the moment the assumption broke is the whole diagnosis.
public struct InvariantViolation: Error, Equatable, CustomStringConvertible, Sendable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var description: String { "InvariantViolation: \(message)" }
}
