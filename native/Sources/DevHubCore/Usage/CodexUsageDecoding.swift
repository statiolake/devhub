// The parts of apps/desktop/src/main/agent/conversation/codex/decode.ts the
// usage reader needs: the JSON-RPC envelope of one `codex app-server` line,
// `account/read`'s answer, and the `RateLimitSnapshot` of
// `account/rateLimits/read` (and of `account/rateLimits/updated`).
//
// The Codex adapter's decoder (`Conversation/Codex/CodexDecode.swift`) is the
// one reader of these lines; this namespace is the usage reader's way in to
// it, so both read them with the same paths and the same "expected …, got …"
// mismatches.

import Foundation

public enum CodexUsageDecoding {
    /// A JSON-RPC id, as app-server writes it.
    public typealias RpcId = CodexRpcId

    /// One line off app-server's stdout.
    public typealias Message = CodexMessage

    public typealias AccountReading = CodexAccountReading

    /// One line off app-server's stdout (`decodeLine`).
    public static func decodeLine(_ line: String, version: String? = nil) throws -> Message {
        try codexDecodeLine(CodexReader(version: version), line)
    }

    public static func accountResponse(_ value: JsonValue?, version: String? = nil) throws -> AccountReading {
        try codexAccountResponse(CodexReader(version: version), value)
    }

    /// The windows of a `rateLimits` snapshot (`at` "params" for
    /// `account/rateLimits/updated`, "result" for `account/rateLimits/read`).
    public static func rateLimits(_ value: JsonValue?, at: String = "params", version: String? = nil) throws -> [RateLimit] {
        try codexRateLimits(CodexReader(version: version), value, at: at)
    }
}
