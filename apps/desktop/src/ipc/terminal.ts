/**
 * The versioned terminal wire contract: attach, detach and their refusals.
 *
 * Ported from the Tauri app's `src-tauri/src/terminal/contract.rs`. What a
 * control client and its page say to each other once it is attached is
 * `terminalControl.ts`'s, over the page's port to the pty host.
 *
 * The contract carries only the semantic surface key and the opaque attachment
 * handle. Workspace paths, shells, and client processes are main-process
 * values and stop there.
 *
 * Nothing here may import Electron, Node, or the DOM: the file is compiled into
 * the main process, the preload, and the page alike.
 */

import type { ControlRequest } from "./terminalControl.js";

export const TERMINAL_PROTOCOL_VERSION = 1 as const;
export const MAX_ATTACH_REQUEST_BYTES = 16 * 1024;
export const MAX_SURFACE_KEY_BYTES = 256;
export const MAX_ATTACHMENT_ID_BYTES = 64;
export const MAX_ERROR_SUMMARY_BYTES = 256;
export const MIN_COLS = 1;
export const MAX_COLS = 500;
export const MIN_ROWS = 1;
export const MAX_ROWS = 500;
export const MAX_PIXEL = 10_000;
/** Generations travel as a Number: the exact safe-integer ceiling. */
export const MAX_TARGET_GENERATION = 9_007_199_254_740_991;

export type TerminalErrorCode =
	| "invalid_request"
	| "invalid_surface"
	| "surface_unavailable"
	| "stale_target"
	| "wrong_attachment"
	| "attachment_limit"
	| "session_unavailable"
	| "pty_unavailable"
	| "invalid_resize"
	| "channel_closed"
	| "runtime_unavailable"
	| "runtime_timed_out"
	| "runtime_incompatible"
	| "workspace_closing"
	| "workspace_root_missing"
	| "workspace_root_inaccessible"
	| "host_restarted"
	| "internal";

export interface TerminalError {
	readonly code: TerminalErrorCode;
	readonly summary: string;
}

export type ExitReason = "eof" | "detached" | "childExited";

const ERROR_SUMMARIES: Readonly<Record<TerminalErrorCode, string>> = {
	invalid_request: "The terminal request is invalid.",
	invalid_surface: "The selected terminal surface is invalid.",
	surface_unavailable: "The selected terminal surface is unavailable.",
	stale_target: "The terminal target is stale.",
	wrong_attachment: "The terminal attachment is not owned by this view.",
	attachment_limit: "This terminal surface already has an attachment.",
	session_unavailable: "The terminal session is unavailable.",
	pty_unavailable: "The terminal client could not be attached.",
	invalid_resize: "The terminal size is invalid.",
	channel_closed: "The terminal view is disconnected.",
	runtime_unavailable: "The terminal runtime is unavailable.",
	runtime_timed_out: "The terminal runtime did not answer in time.",
	runtime_incompatible: "This version of tmux is not supported.",
	workspace_closing: "This workspace is closing.",
	workspace_root_missing: "The workspace folder no longer exists.",
	workspace_root_inaccessible: "The workspace folder cannot be read.",
	host_restarted: "The terminal host restarted. Reconnecting.",
	internal: "The terminal runtime could not complete the request.",
};

/**
 * Fit a summary inside the bound the wire keeps it to.
 *
 * A search list is as long as the user's PATH, and a sentence the wire refuses
 * would turn a legible failure into an unrelated framing error — the failure
 * about the failure, which is the worst outcome of the three.
 */
function boundedSummary(summary: string): string {
	const encoder = new TextEncoder();
	if (encoder.encode(summary).byteLength <= MAX_ERROR_SUMMARY_BYTES) {
		return summary;
	}
	const ellipsis = "…";
	const budget = MAX_ERROR_SUMMARY_BYTES - encoder.encode(ellipsis).byteLength;
	let kept = "";
	let bytes = 0;
	// Whole code points, so the truncation can never split one and produce a
	// string whose byte length the decoder measures differently.
	for (const character of summary) {
		const width = encoder.encode(character).byteLength;
		if (bytes + width > budget) break;
		kept += character;
		bytes += width;
	}
	return kept + ellipsis;
}

/**
 * The one failure type the terminal raises.
 *
 * It is an `Error` so a rejected request keeps a stack on the way to the root
 * handler, and it carries the wire code so the page can render exactly what the
 * main process decided instead of re-deriving a reason from a message.
 */
export interface TerminalFailureOptions extends ErrorOptions {
	/**
	 * A sentence that replaces the code's stock summary on the wire.
	 *
	 * Only for a failure whose stock words leave out the whole diagnostic — a
	 * runtime that is unavailable because a *named* executable was not found in
	 * *named* directories. It is composed from DevHub's own configuration, never
	 * from provider output; see `PortFailure.detail`.
	 */
	readonly summary?: string;
}

export class TerminalFailure extends Error {
	readonly code: TerminalErrorCode;
	readonly summary: string;

	constructor(code: TerminalErrorCode, options?: TerminalFailureOptions) {
		// The wire carries only the code and its summary. The cause stays on
		// this side, where the log and the root handler can still read why.
		const summary = boundedSummary(options?.summary ?? ERROR_SUMMARIES[code]);
		super(summary, { cause: options?.cause });
		this.name = "TerminalFailure";
		this.code = code;
		this.summary = summary;
	}

	/** The wire projection: the code and the summary, nothing else. */
	toWire(): TerminalError {
		return { code: this.code, summary: this.summary };
	}
}

export interface TerminalSize {
	readonly cols: number;
	readonly rows: number;
	readonly pixelWidth: number;
	readonly pixelHeight: number;
}

export interface TerminalAttachRequest extends TerminalSize {
	readonly schemaVersion: 1;
	readonly surfaceKey: string;
	/**
	 * Must be zero on attach. Main allocates the opaque attachment generation
	 * after resolving the active semantic surface.
	 */
	readonly targetGeneration: 0;
}

export interface TerminalAttachReceipt {
	readonly schemaVersion: 1;
	readonly attachmentId: string;
	readonly surfaceKey: string;
	readonly targetGeneration: number;
}

export type TerminalReceipt = TerminalAttachReceipt;

export interface TerminalDetachRequest {
	readonly schemaVersion: 1;
	readonly surfaceKey: string;
	readonly attachmentId: string;
	readonly targetGeneration: number;
}

/**
 * Channel names. Requests are `invoke`/`handle`; the rest are main's pushes.
 */
export const TERMINAL_CHANNELS = {
	attach: "devhub:terminal:attach",
	detach: "devhub:terminal:detach",
	/**
	 * Page → main: "Restart Terminals". The pty host is started afresh and
	 * every page is told (`revived`); the tmux sessions are untouched.
	 */
	restart: "devhub:terminal:restart",
	/**
	 * Main → page: the page's `MessagePort` to the pty host of a generation
	 * (`main/ptyHost/`). A control client the host runs talks to its page
	 * there; attach and detach stay main's.
	 */
	port: "devhub:terminal:port",
	/** Main → page: the pty host of a generation ended; its clients are gone. */
	restarted: "devhub:terminal:restarted",
	/**
	 * Main → every page: the terminals were restarted (`restart`). A surface
	 * that could not attach (`pty_unavailable`) attaches again.
	 */
	revived: "devhub:terminal:revived",
} as const;

/**
 * What main answers an attach with: the result, and for a client the pty host
 * runs, the generation of the host whose port carries it. The preload makes a
 * `TerminalResult` of it for the page.
 */
export interface TerminalAttachReply {
	readonly result: TerminalResult<TerminalAttachReceipt>;
	readonly hosted?: number;
}

/**
 * What a terminal request replies.
 *
 * The wire code is the whole point of the contract's error type, and an
 * exception thrown across `invoke` arrives as a message with no structure. So a
 * refusal travels as a value and is turned back into a thrown failure in
 * exactly one place — the preload — which is the page's root for it.
 */
export type TerminalResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: TerminalError };

/**
 * The surface the preload puts on `window.devhub.terminal`.
 *
 * Every call is addressed by `channelId`: the page's identity for one mounted
 * terminal surface. It is what lets one page hold several surfaces at once and
 * still have each request and each message belong to exactly one of them.
 *
 * A refusal comes back as a `TerminalResult`, not as a thrown error: a custom
 * error class does not survive the context bridge with its code intact, and the
 * code is the contract. The page's client is where a refusal becomes a throw.
 */
export interface DevhubTerminalApi {
	/** `onMessage`: the client's `ControlToPage` news, in order. */
	attach(
		channelId: string,
		request: TerminalAttachRequest,
		onMessage: (message: unknown) => void,
	): Promise<TerminalResult<TerminalAttachReceipt>>;
	/** A control client's request (`terminalControl.ts`). */
	control(
		channelId: string,
		request: ControlRequest,
	): Promise<TerminalResult<void>>;
	detach(
		channelId: string,
		request: TerminalDetachRequest,
	): Promise<TerminalResult<void>>;
	/** "Restart Terminals": the pty host started afresh (`TERMINAL_CHANNELS.restart`). */
	restart(): Promise<void>;
	/** The terminals were restarted (`TERMINAL_CHANNELS.revived`); the unsubscribe. */
	onRevived(listener: () => void): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const expected = new Set(keys);
	const actual = Object.keys(value);
	return (
		actual.length === keys.length && actual.every((key) => expected.has(key))
	);
}

function utf8Length(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

// --- Validation -----------------------------------------------------------
//
// Every validator below is the exact rule the Rust enforced, with the same
// error code, so a request rejected on one side is rejected on the other.

export function validateSchema(schemaVersion: unknown): void {
	if (schemaVersion !== TERMINAL_PROTOCOL_VERSION) {
		throw new TerminalFailure("invalid_request");
	}
}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const WORKSPACE_TERMINAL_SURFACE_PREFIX = "workspace-terminal:";
/**
 * An Agent's surface.
 *
 * An Agent is a tmux session like the other two, so it is a key this channel
 * answers about rather than a channel of its own. It is listed here because
 * the grammar is checked at the wire, before anything resolves it: a key this
 * function does not know is refused, so a new kind of surface has to be
 * admitted here on purpose and cannot arrive by accident.
 */
export const AGENT_SURFACE_PREFIX = "agent:";

/**
 * A pane terminal's surface: a terminal opened beside a Workspace's panes
 * (`Cmd+Q V` / `S`, `devhub --tell terminal open`), by its own id.
 */
export const PANE_TERMINAL_SURFACE_PREFIX = "terminal:";

/** The surface key for a pane terminal, from its id. */
export function paneTerminalSurfaceKey(terminalId: string): string {
	return `${PANE_TERMINAL_SURFACE_PREFIX}${terminalId}`;
}

/** The surface key for a workspace's terminal, from its workspace id. */
export function workspaceTerminalSurfaceKey(workspaceId: string): string {
	return `${WORKSPACE_TERMINAL_SURFACE_PREFIX}${workspaceId}`;
}

/**
 * What a Workspace's terminal page (`pane.html#ws:<id>`) is called where an
 * Agent's terminal is called by its id: the page's fragment, and the
 * terminal the Neovims over its panes belong to (`editor = "neovim"`, the
 * editor area). Its surface is `workspaceTerminalSurfaceKey`.
 */
export const WORKSPACE_TERMINAL_PAGE_PREFIX = "ws:";

export function workspaceTerminalPageId(workspaceId: string): string {
	return `${WORKSPACE_TERMINAL_PAGE_PREFIX}${workspaceId}`;
}

/**
 * The terminal page (`pane.html#<id>`) a terminal surface is drawn in, by its
 * surface key: an Agent terminal's id, or a Workspace's `ws:<id>`;
 * `undefined` for any other surface.
 */
export function terminalIdOfSurface(surfaceKey: string): string | undefined {
	if (surfaceKey.startsWith(PANE_TERMINAL_SURFACE_PREFIX))
		return surfaceKey.slice(PANE_TERMINAL_SURFACE_PREFIX.length);
	if (surfaceKey.startsWith(WORKSPACE_TERMINAL_SURFACE_PREFIX))
		return workspaceTerminalPageId(
			surfaceKey.slice(WORKSPACE_TERMINAL_SURFACE_PREFIX.length),
		);
	return undefined;
}

/** The Workspace a terminal page id names, or `undefined` for an Agent's terminal. */
export function workspaceOfTerminalPage(id: string): string | undefined {
	return id.startsWith(WORKSPACE_TERMINAL_PAGE_PREFIX)
		? id.slice(WORKSPACE_TERMINAL_PAGE_PREFIX.length)
		: undefined;
}

/** The surface key for an Agent, from its Agent id. */
export function agentSurfaceKey(agentId: string): string {
	return `${AGENT_SURFACE_PREFIX}${agentId}`;
}

export function validateSurfaceKey(value: unknown): string {
	if (typeof value !== "string") throw new TerminalFailure("invalid_surface");
	if (
		value.length === 0 ||
		utf8Length(value) > MAX_SURFACE_KEY_BYTES ||
		/[\s\0]/u.test(value)
	) {
		throw new TerminalFailure("invalid_surface");
	}
	const valid =
		(value.startsWith(WORKSPACE_TERMINAL_SURFACE_PREFIX) &&
			UUID_PATTERN.test(
				value.slice(WORKSPACE_TERMINAL_SURFACE_PREFIX.length),
			)) ||
		(value.startsWith(AGENT_SURFACE_PREFIX) &&
			UUID_PATTERN.test(value.slice(AGENT_SURFACE_PREFIX.length))) ||
		(value.startsWith(PANE_TERMINAL_SURFACE_PREFIX) &&
			UUID_PATTERN.test(value.slice(PANE_TERMINAL_SURFACE_PREFIX.length)));
	if (!valid) throw new TerminalFailure("invalid_surface");
	return value;
}

export function validateAttachmentId(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{32}$/u.test(value)) {
		throw new TerminalFailure("wrong_attachment");
	}
	return value;
}

function safeInteger(value: unknown, code: TerminalErrorCode): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new TerminalFailure(code);
	}
	return value;
}

export function validateSize(value: unknown): TerminalSize {
	if (!isRecord(value)) throw new TerminalFailure("invalid_resize");
	const cols = safeInteger(value.cols, "invalid_resize");
	const rows = safeInteger(value.rows, "invalid_resize");
	const pixelWidth = safeInteger(value.pixelWidth, "invalid_resize");
	const pixelHeight = safeInteger(value.pixelHeight, "invalid_resize");
	if (
		cols < MIN_COLS ||
		cols > MAX_COLS ||
		rows < MIN_ROWS ||
		rows > MAX_ROWS ||
		pixelWidth > MAX_PIXEL ||
		pixelHeight > MAX_PIXEL
	) {
		throw new TerminalFailure("invalid_resize");
	}
	return { cols, rows, pixelWidth, pixelHeight };
}

export function validateTargetGeneration(value: unknown): number {
	const generation = safeInteger(value, "wrong_attachment");
	if (generation === 0 || generation > MAX_TARGET_GENERATION) {
		throw new TerminalFailure("wrong_attachment");
	}
	return generation;
}

export function validateAttachRequest(value: unknown): TerminalAttachRequest {
	if (!isRecord(value)) throw new TerminalFailure("invalid_request");
	const keys = [
		"schemaVersion",
		"surfaceKey",
		"targetGeneration",
		"cols",
		"rows",
		"pixelWidth",
		"pixelHeight",
	];
	if (!exactKeys(value, keys)) {
		throw new TerminalFailure("invalid_request");
	}
	validateSchema(value.schemaVersion);
	const surfaceKey = validateSurfaceKey(value.surfaceKey);
	// Attach has no caller-selected capability generation. Main allocates the
	// generation only after resolving the current immutable surface.
	if (value.targetGeneration !== 0) {
		throw new TerminalFailure("invalid_request");
	}
	const size = validateSize(value);
	if (surfaceKey.length + 64 > MAX_ATTACH_REQUEST_BYTES) {
		throw new TerminalFailure("invalid_request");
	}
	return {
		schemaVersion: TERMINAL_PROTOCOL_VERSION,
		surfaceKey,
		targetGeneration: 0,
		...size,
	};
}

/** The identity every non-attach request must carry, validated as a unit. */
export interface AttachmentIdentity {
	readonly surfaceKey: string;
	readonly attachmentId: string;
	readonly targetGeneration: number;
}

export function validateIdentity(
	value: Record<string, unknown>,
): AttachmentIdentity {
	validateSchema(value.schemaVersion);
	return {
		surfaceKey: validateSurfaceKey(value.surfaceKey),
		attachmentId: validateAttachmentId(value.attachmentId),
		targetGeneration: validateTargetGeneration(value.targetGeneration),
	};
}

export function validateDetachRequest(value: unknown): AttachmentIdentity {
	if (
		!isRecord(value) ||
		!exactKeys(value, [
			"schemaVersion",
			"surfaceKey",
			"attachmentId",
			"targetGeneration",
		])
	) {
		throw new TerminalFailure("invalid_request");
	}
	return validateIdentity(value);
}
