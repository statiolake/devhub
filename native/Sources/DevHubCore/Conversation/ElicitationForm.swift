// Port of apps/desktop/src/model/elicitationForm.ts
//
// The form of an MCP elicitation: what a server asks the person to fill in
// before it goes on, as fields the card draws and the adapter reads back.
//
// MCP restricts an elicitation's `requestedSchema` to a flat object of
// primitive properties — text, a number, a yes/no, a choice of one or of
// several — so a field is one of those four. A schema with no properties is a
// plain confirmation: a form of no fields, accepted with nothing in it.
//
// The card holds what is typed as the strings its controls give
// (`FormValues`); `formContent` is the one reading of them, used by the card
// to say what is wrong before it sends and by the adapter to build the reply.

import Foundation

public struct FormField: Hashable, Sendable {
    /// The property's name: the key its value is sent under.
    public var key: String
    /// The schema's title, else the key.
    public var label: String
    public var description: String?
    public var required: Bool
    public var input: FormInput

    public init(key: String, label: String, description: String?, required: Bool, input: FormInput) {
        self.key = key
        self.label = label
        self.description = description
        self.required = required
        self.input = input
    }
}

public enum TextFormat: String, Hashable, Sendable {
    case email, uri, date
    case dateTime = "date-time"
}

public enum FormInput: Hashable, Sendable {
    case text(format: TextFormat?, minLength: Double?, maxLength: Double?, default: String?)
    case number(integer: Bool, minimum: Double?, maximum: Double?, default: Double?)
    case boolean(default: Bool?)
    /// `multiple`: several may be chosen (an array property), else one.
    /// `default`: the values chosen to begin with.
    case choice(multiple: Bool, options: [FormOption], minItems: Double?, maxItems: Double?, default: [String])
}

public struct FormOption: Hashable, Sendable {
    /// What is sent.
    public var value: String
    /// How it reads: its title, else the value.
    public var label: String

    public init(value: String, label: String) {
        self.value = value
        self.label = label
    }
}

/// What the card's controls hold, by field key: a text or number field's
/// words, a yes/no as `"true"` or `"false"`, a single choice's value (`""`
/// for none), a multiple choice's values.
public typealias FormValues = [String: AnswerValue]

/// The controls' values before the person touches them: the schema's defaults.
public func initialValues(_ fields: [FormField]) -> FormValues {
    var values: FormValues = [:]
    for field in fields {
        switch field.input {
        case .text(_, _, _, let initial):
            values[field.key] = .one(initial ?? "")
        case .number(_, _, _, let initial):
            values[field.key] = .one(initial.map(JsonValue.javaScriptNumber) ?? "")
        case .boolean(let initial):
            values[field.key] = .one((initial ?? false) ? "true" : "false")
        case .choice(let multiple, _, _, _, let initial):
            values[field.key] = multiple ? .many(initial) : .one(initial.first ?? "")
        }
    }
    return values
}

/// A value no control of the field could hold: the caller's mistake, not the person's.
public struct FormValueRefused: Error, CustomStringConvertible, Equatable {
    public let message: String
    public var description: String { message }
}

/// The reply's `content` from what is filled in, and what is wrong with it by
/// field key — empty when it can be sent. A field left empty is left out of
/// the content, and is a problem only when it is required.
public func formContent(_ fields: [FormField], _ values: FormValues) throws
    -> (content: JsonObject, problems: [String: String])
{
    var content = JsonObject()
    var problems: [String: String] = [:]
    for field in fields {
        switch try readField(field, values[field.key]) {
        case .problem(let problem): problems[field.key] = problem
        case .value(let value): if let value { content[field.key] = value }
        }
    }
    return (content, problems)
}

private enum FieldRead {
    case value(JsonValue?)
    case problem(String)
}

private func describe(_ raw: AnswerValue?) -> String {
    switch raw {
    case nil: return "undefined"
    case .one(let value): return JsonValue.quoted(value)
    case .many(let values): return JsonValue.array(values.map(JsonValue.string)).jsonText
    }
}

private func n(_ value: Double) -> String { JsonValue.javaScriptNumber(value) }

private func readField(_ field: FormField, _ raw: AnswerValue?) throws -> FieldRead {
    if case .choice(true, let options, let minItems, let maxItems, _) = field.input {
        guard case .many(let chosen) = raw else {
            throw FormValueRefused(message: "field \(field.key) takes a list of choices, got \(describe(raw))")
        }
        for value in chosen { try offered(field, options, value) }
        if chosen.isEmpty { return field.required ? .problem("Required") : .value(nil) }
        if let minItems, Double(chosen.count) < minItems { return .problem("Choose at least \(n(minItems))") }
        if let maxItems, Double(chosen.count) > maxItems { return .problem("Choose at most \(n(maxItems))") }
        return .value(.array(chosen.map(JsonValue.string)))
    }
    guard case .one(let raw) = raw else {
        throw FormValueRefused(message: "field \(field.key) takes one value, got \(describe(raw))")
    }
    if case .boolean = field.input {
        guard raw == "true" || raw == "false" else {
            throw FormValueRefused(message: "field \(field.key) is a yes/no, got \(JsonValue.quoted(raw))")
        }
        return .value(.bool(raw == "true"))
    }
    var text = raw
    if case .text = field.input {} else { text = jsTrim(raw) }
    if text.isEmpty { return field.required ? .problem("Required") : .value(nil) }
    switch field.input {
    case .text(_, let minLength, let maxLength, _):
        let length = Double(text.utf16.count)
        if let minLength, length < minLength { return .problem("At least \(n(minLength)) characters") }
        if let maxLength, length > maxLength { return .problem("At most \(n(maxLength)) characters") }
        return .value(.string(text))
    case .number(let integer, let minimum, let maximum, _):
        guard let number = javaScriptNumberOf(text), number.isFinite else { return .problem("Not a number") }
        if integer && number != number.rounded() { return .problem("A whole number") }
        if let minimum, number < minimum { return .problem("At least \(n(minimum))") }
        if let maximum, number > maximum { return .problem("At most \(n(maximum))") }
        return .value(.number(number))
    case .choice(_, let options, _, _, _):
        try offered(field, options, text)
        return .value(.string(text))
    case .boolean:
        fatalError("unreachable: a yes/no is read above")
    }
}

private func offered(_ field: FormField, _ options: [FormOption], _ value: String) throws {
    if !options.contains(where: { $0.value == value }) {
        throw FormValueRefused(message: "field \(field.key) offers no choice \(JsonValue.quoted(value))")
    }
}

/// `String.prototype.trim`: whitespace and line terminators off both ends.
func jsTrim(_ text: String) -> String {
    JSString.trim(text)
}

/// `Number(text)` for a trimmed, non-empty text: decimal, hex (`0x`), binary
/// (`0b`), octal (`0o`), `Infinity`; nil where JavaScript gives NaN.
func javaScriptNumberOf(_ text: String) -> Double? {
    let trimmed = jsTrim(text)
    if trimmed.isEmpty { return 0 }
    let lower = trimmed.lowercased()
    for (prefix, radix) in [("0x", 16), ("0b", 2), ("0o", 8)] where lower.hasPrefix(prefix) {
        guard let value = UInt64(lower.dropFirst(2), radix: radix) else { return nil }
        return Double(value)
    }
    switch trimmed {
    case "Infinity", "+Infinity": return .infinity
    case "-Infinity": return -.infinity
    default: break
    }
    // Decimal literal: digits, an optional point, an optional exponent.
    let pattern = #"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$"#
    guard trimmed.range(of: pattern, options: .regularExpression) != nil else { return nil }
    return Double(trimmed)
}
