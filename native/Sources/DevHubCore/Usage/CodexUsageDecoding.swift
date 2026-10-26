// The parts of apps/desktop/src/main/agent/conversation/codex/decode.ts the
// usage reader needs: the JSON-RPC envelope of one `codex app-server` line,
// `account/read`'s answer, and the `RateLimitSnapshot` of
// `account/rateLimits/read` (and of `account/rateLimits/updated`).
//
// Kept under one namespace so the Codex adapter (WP6) can take them over as
// they are: the same paths, the same "expected …, got …" mismatches.

import Foundation

public enum CodexUsageDecoding {
    /// A JSON-RPC id, as app-server writes it.
    public enum RpcId: Hashable, Sendable, CustomStringConvertible {
        case number(Double)
        case string(String)

        public var description: String {
            switch self {
            case .number(let value): return JsonValue.javaScriptNumber(value)
            case .string(let text): return text
            }
        }
    }

    /// One line off app-server's stdout.
    public enum Message: Equatable, Sendable {
        case response(id: RpcId, result: JsonValue?)
        case error(id: RpcId?, code: Double, message: String, data: JsonValue)
        case notification(method: String, params: JsonValue?)
        case request(id: RpcId, method: String, params: JsonValue?)
        /// The host's restart mark between two servers' output.
        case restart
    }

    /// Reads fields, failing with the path and the CLI's version.
    struct Reader {
        let version: String?

        func fail(_ path: String, _ expected: String) -> ProtocolMismatch {
            ProtocolMismatch(path: path, expected: expected, agentVersion: version)
        }

        func mismatch(_ path: String, _ expected: String, _ value: JsonValue?) -> ProtocolMismatch {
            fail(path, "\(expected), got \(Self.describe(value))")
        }

        static func describe(_ value: JsonValue?) -> String {
            switch value {
            case nil: return "a undefined"
            case .null?: return "null"
            case .array?: return "an array"
            case .bool?: return "a boolean"
            case .number?: return "a number"
            case .string?: return "a string"
            case .object?: return "a object"
            }
        }

        func fields(_ value: JsonValue?, _ path: String) throws -> JsonObject {
            guard let object = value?.objectValue else { throw mismatch(path, "an object", value) }
            return object
        }

        func string(_ o: JsonObject, _ key: String, _ path: String) throws -> String {
            guard let text = o[key]?.stringValue else { throw mismatch("\(path).\(key)", "a string", o[key]) }
            return text
        }

        func number(_ o: JsonObject, _ key: String, _ path: String) throws -> Double {
            guard let number = o[key]?.numberValue else { throw mismatch("\(path).\(key)", "a number", o[key]) }
            return number
        }

        func nullableNumber(_ o: JsonObject, _ key: String, _ path: String) throws -> Double? {
            guard let value = o[key], value != .null else { return nil }
            guard let number = value.numberValue else { throw mismatch("\(path).\(key)", "a number or null", value) }
            return number
        }

        func boolean(_ o: JsonObject, _ key: String, _ path: String) throws -> Bool {
            guard let value = o[key]?.boolValue else { throw mismatch("\(path).\(key)", "a boolean", o[key]) }
            return value
        }

        func rpcId(_ o: JsonObject, _ key: String, _ path: String) throws -> RpcId {
            switch o[key] {
            case .number(let value)?: return .number(value)
            case .string(let text)?: return .string(text)
            default: throw mismatch("\(path).\(key)", "a string or number id", o[key])
            }
        }
    }

    /// One line off app-server's stdout (`decodeLine`).
    public static func decodeLine(_ line: String, version: String? = nil) throws -> Message {
        let r = Reader(version: version)
        let value: JsonValue
        do {
            value = try JsonValue.parse(line)
        } catch {
            throw r.fail("line", "JSON, got \(String(line.prefix(200))) (\(error))")
        }
        let o = try r.fields(value, "message")
        if o["type"]?.stringValue == "devhub_restart" { return .restart }
        if o["method"] != nil {
            let method = try r.string(o, "method", "message")
            let params = o["params"]
            if o["id"] != nil { return .request(id: try r.rpcId(o, "id", "message"), method: method, params: params) }
            return .notification(method: method, params: params)
        }
        if o["error"] != nil {
            let error = try r.fields(o["error"], "message.error")
            let id: RpcId? = o["id"] == .null ? nil : try r.rpcId(o, "id", "message")
            return .error(
                id: id,
                code: try r.number(error, "code", "message.error"),
                message: try r.string(error, "message", "message.error"),
                data: error["data"] ?? .null
            )
        }
        if o["result"] != nil {
            return .response(id: try r.rpcId(o, "id", "message"), result: o["result"])
        }
        throw r.fail("message", "a request, notification or response, got \(String(line.prefix(200)))")
    }

    /// `account/read`'s answer: the kind of sign-in, or `nil` when there is
    /// none. A string rather than a closed set: a kind a newer Codex adds is
    /// still a sign-in, and only the usage reader asks which one it is.
    public struct AccountReading: Equatable, Sendable {
        public var account: String?
        public var requiresOpenaiAuth: Bool
    }

    public static func accountResponse(_ value: JsonValue?, version: String? = nil) throws -> AccountReading {
        let r = Reader(version: version)
        let o = try r.fields(value, "result")
        let account: String?
        if let raw = o["account"], raw != .null {
            account = try r.string(try r.fields(raw, "result.account"), "type", "result.account")
        } else {
            account = nil
        }
        return AccountReading(account: account, requiresOpenaiAuth: try r.boolean(o, "requiresOpenaiAuth", "result"))
    }

    /// The `rateLimits` snapshot of `account/rateLimits/updated`'s params, or —
    /// `at` "result" — of `account/rateLimits/read`'s result: the windows,
    /// primary before secondary. A window that is null is left out: "not
    /// reported this time", never "cleared".
    public static func rateLimits(_ value: JsonValue?, at: String = "params", version: String? = nil) throws -> [RateLimit] {
        let r = Reader(version: version)
        let o = try r.fields(value, at)
        let snapshot = try r.fields(o["rateLimits"], "\(at).rateLimits")
        return try ["primary", "secondary"].compactMap { slot in
            guard let raw = snapshot[slot], raw != .null else { return nil }
            let path = "\(at).rateLimits.\(slot)"
            let w = try r.fields(raw, path)
            let minutes = try r.nullableNumber(w, "windowDurationMins", path)
            let resetsAt = try r.nullableNumber(w, "resetsAt", path)
            return RateLimit(
                window: minutes.map(rateLimitWindowName) ?? slot,
                durationMinutes: minutes,
                usedPercent: try r.number(w, "usedPercent", path),
                // Unix seconds on the wire, as Codex's core protocol keeps it.
                resetsAt: resetsAt.map { $0 * 1000 }
            )
        }
    }
}
