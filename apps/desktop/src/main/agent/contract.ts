/**
 * Versioned, provider-local Herdr contract values.
 *
 * Ported 1:1 from the Tauri app's `src-tauri/src/agent/contract.rs`, with one
 * deliberate change: the pinned CLI version is `0.8.2` rather than `0.8.1`,
 * because that is the Herdr release this port is built and verified against.
 * The JSON API protocol is still 20 (`herdr api schema --json` reports it).
 */

/** The one named Herdr session owned by DevHub. */
export const HERDR_SESSION_NAME = "devhub-session";
/** Exact Herdr CLI version accepted by this adapter. */
export const HERDR_VERSION = "0.8.2";
/** Exact Herdr JSON API protocol accepted by this adapter. */
export const HERDR_PROTOCOL_VERSION = 20;

/**
 * Capability names are adapter-internal labels. They are deliberately not
 * exposed in domain or UI contracts.
 */
const REQUIRED_CAPABILITIES = [
	"session.snapshot",
	"events.subscribe",
	"workspace.create",
	"workspace.list",
	"workspace.close",
	"tab.create",
	"tab.list",
	"pane.create",
	"pane.list",
	"pane.get",
	"pane.close",
	"pane.send_input",
	"agent.start:codex",
	"agent.start:claude",
	"terminal.control",
] as const;

export function expectedVersion(): string {
	return HERDR_VERSION;
}

export function expectedProtocol(): number {
	return HERDR_PROTOCOL_VERSION;
}

export function requiredCapabilities(): readonly string[] {
	return REQUIRED_CAPABILITIES;
}
