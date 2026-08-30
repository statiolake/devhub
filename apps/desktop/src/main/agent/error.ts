/**
 * Bounded, content-free AgentRuntime errors.
 *
 * Ported 1:1 from `src-tauri/src/agent/error.rs`. No provider response, path,
 * command, token, environment value, or agent content is stored in this type;
 * `toString()` renders only the stable summary, so an error can be logged
 * anywhere without leaking a user's session.
 */

import { PortError, PortErrorCode } from "./ports.js";

/** Stable local failure categories. */
export enum AgentRuntimeErrorCode {
	InvalidProfile = "invalidProfile",
	MissingExecutable = "missingExecutable",
	BootstrapFailed = "bootstrapFailed",
	ProtocolMismatch = "protocolMismatch",
	CapabilityMismatch = "capabilityMismatch",
	Unavailable = "unavailable",
	Disconnected = "disconnected",
	Timeout = "timeout",
	Cancelled = "cancelled",
	Conflict = "conflict",
	ProviderRejected = "providerRejected",
	ProviderNotFound = "providerNotFound",
	CleanupPending = "cleanupPending",
	BoundedInput = "boundedInput",
	Internal = "internal",
}

/**
 * Provider-private, bounded classification for launch diagnosis.
 *
 * Raw provider codes and messages are discarded at the transport boundary.
 * This enum never crosses the AgentRuntime/core port seam.
 */
export enum ProviderErrorCategory {
	AgentNameTaken = "agentNameTaken",
	AgentPaneBusy = "agentPaneBusy",
	AgentPaneNotFound = "agentPaneNotFound",
	AgentPaneUnavailable = "agentPaneUnavailable",
	AgentStartInputFailed = "agentStartInputFailed",
	InvalidRequest = "invalidRequest",
	Other = "other",
}

const SUMMARIES: Record<AgentRuntimeErrorCode, string> = {
	[AgentRuntimeErrorCode.InvalidProfile]: "invalid profile",
	[AgentRuntimeErrorCode.MissingExecutable]: "Herdr executable unavailable",
	[AgentRuntimeErrorCode.BootstrapFailed]: "Herdr bootstrap failed",
	[AgentRuntimeErrorCode.ProtocolMismatch]: "Herdr protocol mismatch",
	[AgentRuntimeErrorCode.CapabilityMismatch]: "Herdr capability mismatch",
	[AgentRuntimeErrorCode.Unavailable]: "Agent runtime unavailable",
	[AgentRuntimeErrorCode.Disconnected]: "Agent runtime disconnected",
	[AgentRuntimeErrorCode.Timeout]: "Agent runtime timed out",
	[AgentRuntimeErrorCode.Cancelled]: "Agent operation cancelled",
	[AgentRuntimeErrorCode.Conflict]: "Agent runtime ownership conflict",
	[AgentRuntimeErrorCode.ProviderRejected]: "Agent provider rejected operation",
	[AgentRuntimeErrorCode.ProviderNotFound]: "Agent provider resource is gone",
	[AgentRuntimeErrorCode.CleanupPending]: "Agent cleanup pending",
	[AgentRuntimeErrorCode.BoundedInput]: "Agent input exceeded the safety bound",
	[AgentRuntimeErrorCode.Internal]: "Agent runtime internal failure",
};

export function summaryOf(code: AgentRuntimeErrorCode): string {
	return SUMMARIES[code];
}

export class AgentRuntimeError extends Error {
	readonly code: AgentRuntimeErrorCode;
	readonly providerCategory: ProviderErrorCategory | undefined;

	constructor(
		code: AgentRuntimeErrorCode,
		providerCategory?: ProviderErrorCategory,
	) {
		super(SUMMARIES[code]);
		this.name = "AgentRuntimeError";
		this.code = code;
		this.providerCategory = providerCategory;
		// Node renders a thrown Error by its stack. Keep the stack free of the
		// call site's captured provider strings by dropping it entirely: the
		// code is the whole diagnostic this type is allowed to carry.
		this.stack = `AgentRuntimeError: ${SUMMARIES[code]}`;
	}

	get portCode(): PortErrorCode {
		switch (this.code) {
			case AgentRuntimeErrorCode.ProtocolMismatch:
			case AgentRuntimeErrorCode.CapabilityMismatch:
				return PortErrorCode.Incompatible;
			case AgentRuntimeErrorCode.Conflict:
				return PortErrorCode.Conflict;
			case AgentRuntimeErrorCode.Timeout:
				return PortErrorCode.TimedOut;
			case AgentRuntimeErrorCode.Cancelled:
				return PortErrorCode.Cancelled;
			case AgentRuntimeErrorCode.Unavailable:
			case AgentRuntimeErrorCode.MissingExecutable:
			case AgentRuntimeErrorCode.Disconnected:
				return PortErrorCode.Unavailable;
			default:
				return PortErrorCode.Failed;
		}
	}

	toPortError(): PortError {
		return new PortError(this.portCode);
	}
}

export function agentError(
	code: AgentRuntimeErrorCode,
	providerCategory?: ProviderErrorCategory,
): AgentRuntimeError {
	return new AgentRuntimeError(code, providerCategory);
}

/**
 * The one place an unknown throw becomes a bounded adapter error. Anything
 * that is not already an `AgentRuntimeError` is opaque and is reported as an
 * internal failure rather than being rendered.
 */
export function asAgentError(value: unknown): AgentRuntimeError {
	return value instanceof AgentRuntimeError
		? value
		: agentError(AgentRuntimeErrorCode.Internal);
}

/** Node's socket/filesystem error codes, classified without their messages. */
export function classifyIo(value: unknown): AgentRuntimeError {
	const code = (value as NodeJS.ErrnoException | undefined)?.code;
	switch (code) {
		case "ENOENT":
		case "ECONNREFUSED":
		case "ECONNRESET":
		case "EPIPE":
		case "ENOTCONN":
		case "EOF":
			return agentError(AgentRuntimeErrorCode.Disconnected);
		case "ETIMEDOUT":
		case "EAGAIN":
			return agentError(AgentRuntimeErrorCode.Timeout);
		default:
			return agentError(AgentRuntimeErrorCode.Unavailable);
	}
}
