// Port of apps/desktop/src/main/agent/conversation/elicitation.ts
//
// An MCP elicitation, as both CLIs pass one on: a server asking the person
// something through the Agent. Each adapter reads its CLI's request into an
// `Elicitation` and writes an `ElicitationReply` back in its CLI's words;
// everything between — the card's subject, which answers it offers, what each
// answer means — is decided here, once, so a Claude elicitation and a Codex
// one are the same card answered by the same rule.
//
// The rule: an elicitation is accepted by submitting its form, whatever fields
// it has (none makes it a plain confirmation, accepted with nothing filled in;
// a page to visit is accepted with no content at all). When the CLI offers to
// remember the acceptance — for this session, or always — each offer is a
// further way to accept, after the form's own. Declining and cancelling come
// last.
//
// The form's schema is MCP's `requestedSchema`, the same for both CLIs, so it
// is read here too (`formFields`), failing through the adapter's own reader so
// a mismatch names the CLI's version.

import Foundation

/// How long an acceptance may be remembered, as MCP tool approvals name it.
public enum Remember: String, Hashable, Sendable {
    case session, always
}

public struct Elicitation: Hashable, Sendable {
    public var server: String
    public var message: String
    /// The page to visit, for a URL elicitation; its form then has no fields.
    public var url: String?
    public var fields: [FormField]
    /// How long the CLI offers to remember an acceptance, in the order
    /// offered. Only a plain confirmation (a form of no fields) is offered any.
    public var remember: [Remember]

    public init(server: String, message: String, url: String?, fields: [FormField], remember: [Remember]) {
        self.server = server
        self.message = message
        self.url = url
        self.fields = fields
        self.remember = remember
    }
}

public enum ElicitationAction: String, Hashable, Sendable {
    case accept, decline, cancel
}

/// What the person answered, before the adapter spells it in its CLI's words.
public struct ElicitationReply: Hashable, Sendable {
    public var action: ElicitationAction
    /// What was filled in, for an accepted form; nil for a page to visit, a decline, a cancel.
    public var content: JsonObject?
    /// How long the acceptance is to be remembered, when the person chose that.
    public var remember: Remember?
}

private func rememberChoice(_ remember: Remember) -> RequestChoice {
    switch remember {
    case .session:
        return RequestChoice(id: "remember:session", label: "Accept for this session", tone: .allow, takesText: false)
    case .always:
        return RequestChoice(id: "remember:always", label: "Always accept", tone: .allow, takesText: false)
    }
}

private let DECLINE = RequestChoice(id: "decline", label: "Decline", tone: .deny, takesText: false)
private let CANCEL = RequestChoice(id: "cancel", label: "Cancel", tone: .neutral, takesText: false)

/// The card's subject; its fields are the form the card draws.
public func elicitationSubject(_ elicitation: Elicitation) -> RequestSubject {
    .elicitation(server: elicitation.server, message: elicitation.message, url: elicitation.url, fields: elicitation.fields)
}

/// The answers beside the form's own Accept, which the card puts first: each
/// way of remembering the acceptance the CLI offers, then Decline and Cancel.
public func elicitationChoices(_ elicitation: Elicitation) -> [RequestChoice] {
    elicitation.remember.map(rememberChoice) + [DECLINE, CANCEL]
}

/// What an answer to the card means. An answer the card could not have given
/// — a choice it did not offer, a form sent unfinished — is the caller's
/// mistake, and throws.
public func elicitationReply(_ elicitation: Elicitation, _ answer: RequestAnswer, request: String) throws
    -> ElicitationReply
{
    switch answer {
    case .answers(let values, _):
        let (content, problems) = try formContent(elicitation.fields, Dictionary(values, uniquingKeysWith: { $1 }))
        if !problems.isEmpty {
            let described = JsonValue.object(
                JsonObject(elicitation.fields.compactMap { field in problems[field.key].map { (field.key, JsonValue.string($0)) } })
            ).jsonText
            throw AdapterRefusal("the form of elicitation \(request) was sent unfinished: \(described)")
        }
        return ElicitationReply(action: .accept, content: elicitation.url == nil ? content : nil, remember: nil)
    case .choice(let choiceId, let text):
        if text != nil {
            throw AdapterRefusal("choice \(choiceId) of elicitation \(request) takes no text")
        }
        if let remember = elicitation.remember.first(where: { rememberChoice($0).id == choiceId }) {
            if !elicitation.fields.isEmpty || elicitation.url != nil {
                throw AdapterRefusal(
                    "elicitation \(request) offers to remember an acceptance, but is not a plain confirmation")
            }
            return ElicitationReply(action: .accept, content: JsonObject(), remember: remember)
        }
        switch choiceId {
        case DECLINE.id: return ElicitationReply(action: .decline, content: nil, remember: nil)
        case CANCEL.id: return ElicitationReply(action: .cancel, content: nil, remember: nil)
        default:
            throw AdapterRefusal("elicitation \(request) has no choice \(JsonValue.quoted(choiceId))")
        }
    }
}

// MARK: - The form's schema

/// What the schema is read through: the adapter's reader, whose failure names the CLI's version.
public protocol SchemaReader {
    func fail(_ path: String, _ expected: String) -> ProtocolMismatch
}

/// A form's fields from its schema (MCP's `requestedSchema`, a flat object
/// of primitive properties), in the schema's order.
public func formFields(_ reader: SchemaReader, _ value: JsonValue?, _ path: String) throws -> [FormField] {
    let r = SchemaRead(reader: reader)
    let schema = try r.fields(value, path)
    _ = try r.oneOf(schema, "type", path, ["object"])
    let required = Set(try r.strings(schema, "required", path) ?? [])
    let properties = try r.fields(schema["properties"], "\(path).properties")
    return try properties.map { key, property in
        let at = "\(path).properties.\(key)"
        let p = try r.fields(property, at)
        return FormField(
            key: key,
            label: try r.string(p, "title", at) ?? key,
            description: try r.string(p, "description", at),
            required: required.contains(key),
            input: try formInput(r, p, at))
    }
}

private func formInput(_ r: SchemaRead, _ p: JsonObject, _ at: String) throws -> FormInput {
    let type = try r.oneOf(p, "type", at, ["string", "number", "integer", "boolean", "array"])
    switch type {
    case "string":
        let byDefault = try r.string(p, "default", at)
        let chosen = byDefault.map { [$0] } ?? []
        if p["oneOf"] != nil {
            return .choice(multiple: false, options: try constOptions(r, p, "oneOf", at), minItems: nil, maxItems: nil, default: chosen)
        }
        if p["enum"] != nil {
            let names = try r.strings(p, "enumNames", at)
            let options = try r.list(p, "enum", at).enumerated().map { index, each in
                let value = try r.item(each, "\(at).enum[\(index)]")
                return FormOption(value: value, label: names.flatMap { index < $0.count ? $0[index] : nil } ?? value)
            }
            return .choice(multiple: false, options: options, minItems: nil, maxItems: nil, default: chosen)
        }
        let format: TextFormat?
        if p["format"] == nil || p["format"] == .null {
            format = nil
        } else {
            format = TextFormat(rawValue: try r.oneOf(p, "format", at, ["email", "uri", "date", "date-time"]))
        }
        return .text(
            format: format, minLength: try r.number(p, "minLength", at), maxLength: try r.number(p, "maxLength", at),
            default: byDefault)
    case "number", "integer":
        return .number(
            integer: type == "integer", minimum: try r.number(p, "minimum", at), maximum: try r.number(p, "maximum", at),
            default: try r.number(p, "default", at))
    case "boolean":
        return .boolean(default: try r.boolean(p, "default", at))
    default:  // array
        let items = try r.fields(p["items"], "\(at).items")
        let options: [FormOption]
        if items["anyOf"] != nil {
            options = try constOptions(r, items, "anyOf", "\(at).items")
        } else {
            options = try r.list(items, "enum", "\(at).items").enumerated().map { index, each in
                let value = try r.item(each, "\(at).items.enum[\(index)]")
                return FormOption(value: value, label: value)
            }
        }
        return .choice(
            multiple: true, options: options, minItems: try r.number(p, "minItems", at),
            maxItems: try r.number(p, "maxItems", at), default: try r.strings(p, "default", at) ?? [])
    }
}

/// Options given as `{ const, title }`.
private func constOptions(_ r: SchemaRead, _ o: JsonObject, _ key: String, _ path: String) throws -> [FormOption] {
    try r.list(o, key, path).enumerated().map { index, option in
        let at = "\(path).\(key)[\(index)]"
        let c = try r.fields(option, at)
        return FormOption(value: try r.item(c["const"], "\(at).const"), label: try r.item(c["title"], "\(at).title"))
    }
}

/// The few readings a schema takes. A key that is absent and one that is
/// `null` read the same, as nil; a key of the wrong type fails.
private struct SchemaRead {
    let reader: SchemaReader

    func mismatch(_ path: String, _ expected: String, _ value: JsonValue?) -> ProtocolMismatch {
        let got: String
        switch value {
        case nil: got = "a undefined"
        case .null?: got = "null"
        case .array?: got = "an array"
        case .object?: got = "a object"
        case .string?: got = "a string"
        case .number?: got = "a number"
        case .bool?: got = "a boolean"
        }
        return reader.fail(path, "\(expected), got \(got)")
    }

    func fields(_ value: JsonValue?, _ path: String) throws -> JsonObject {
        guard case .object(let object)? = value else { throw mismatch(path, "an object", value) }
        return object
    }

    func oneOf(_ o: JsonObject, _ key: String, _ path: String, _ values: [String]) throws -> String {
        if case .string(let value)? = o[key], values.contains(value) { return value }
        throw mismatch("\(path).\(key)", "one of \(values.joined(separator: " | "))", o[key])
    }

    func item(_ value: JsonValue?, _ path: String) throws -> String {
        guard case .string(let text)? = value else { throw mismatch(path, "a string", value) }
        return text
    }

    func string(_ o: JsonObject, _ key: String, _ path: String) throws -> String? {
        guard let value = o[key], value != .null else { return nil }
        return try item(value, "\(path).\(key)")
    }

    func number(_ o: JsonObject, _ key: String, _ path: String) throws -> Double? {
        guard let value = o[key], value != .null else { return nil }
        guard case .number(let number) = value else { throw mismatch("\(path).\(key)", "a number", value) }
        return number
    }

    func boolean(_ o: JsonObject, _ key: String, _ path: String) throws -> Bool? {
        guard let value = o[key], value != .null else { return nil }
        guard case .bool(let flag) = value else { throw mismatch("\(path).\(key)", "a boolean", value) }
        return flag
    }

    func list(_ o: JsonObject, _ key: String, _ path: String) throws -> [JsonValue] {
        guard case .array(let items)? = o[key] else { throw mismatch("\(path).\(key)", "an array", o[key]) }
        return items
    }

    func strings(_ o: JsonObject, _ key: String, _ path: String) throws -> [String]? {
        guard let value = o[key], value != .null else { return nil }
        return try list(o, key, path).enumerated().map { index, each in try item(each, "\(path).\(key)[\(index)]") }
    }
}
