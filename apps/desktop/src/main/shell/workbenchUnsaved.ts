/**
 * A workbench's unsaved work, as the close needs it: the names, and the
 * discarding.
 *
 * A close asks about unsaved work exactly once — in DevHub's own confirmation,
 * beside the busy Agents and the dirty worktree — and then carries out the
 * answer. VS Code cannot do either half for it. The only thing it pushes to
 * main is `setDocumentEdited`, a boolean, so the confirmation could say "the
 * editor has unsaved changes" but not which; and the only way it discards is
 * as the "Don't Save" of its own save dialog, which `unload` raises. That
 * dialog, raised by the close's `editor` step, was a second question in the
 * middle of a close that had already been answered: the close waited on it,
 * ran out its deadline, failed as "the editor did not answer", and left the
 * dialog standing over a Workspace that said it was closing.
 *
 * So the workbench is asked directly, over the two requests
 * `patches/vscode/0004-devhub-reads-and-discards-unsaved-editors.patch` adds
 * to its window: which working copies are modified, by the names their tabs
 * show; and to revert them, the way upstream's own "Don't Save" does. After a
 * discard the unload has nothing to ask about, and the close goes through.
 *
 * Every request ends. A workbench that does not reply in time, or whose
 * contents go away first, is a rejection with a sentence — never a promise
 * that waits for ever, which is the other half of what the hang was.
 */

import { withSummary, errorWireAt, TypedFailure } from "../../model/wire.js";
import { InvariantViolation } from "./invariant.js";

/** As much of a workbench's `WebContents` as a request needs. */
export interface WorkbenchContents {
	send(channel: string, ...args: unknown[]): void;
	isDestroyed(): boolean;
	once(event: "destroyed", listener: () => void): unknown;
	removeListener(event: "destroyed", listener: () => void): unknown;
	readonly ipc: {
		on(
			channel: string,
			listener: (event: unknown, ...args: unknown[]) => void,
		): unknown;
		removeListener(
			channel: string,
			listener: (event: unknown, ...args: unknown[]) => void,
		): unknown;
	};
}

/**
 * How long reading the names may take. The workbench answers from memory, so
 * anything near this is a workbench that is not answering at all.
 */
export const UNSAVED_READ_TIMEOUT_MS = 5_000;

let nextNonce = 0;

/**
 * Send one request to a workbench and wait for its one reply, for a bounded
 * time.
 */
function askWorkbench(
	contents: WorkbenchContents,
	channel: string,
	timeoutMs: number,
): Promise<unknown> {
	if (contents.isDestroyed()) {
		return Promise.reject(
			unsavedFailure("The editor went away before it could be asked."),
		);
	}
	const nonce = `devhub-${process.pid}-${++nextNonce}`;
	const replyChannel = `${channel}Reply`;
	return new Promise<unknown>((resolve, reject) => {
		const settle = (): void => {
			clearTimeout(timer);
			contents.ipc.removeListener(replyChannel, onReply);
			contents.removeListener("destroyed", onDestroyed);
		};
		const onReply = (_event: unknown, ...args: unknown[]): void => {
			if (args[0] !== nonce) return;
			settle();
			resolve(args[1]);
		};
		const onDestroyed = (): void => {
			settle();
			reject(unsavedFailure("The editor went away before it answered."));
		};
		const timer = setTimeout(() => {
			settle();
			reject(
				unsavedFailure(
					`The editor did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
				),
			);
		}, timeoutMs);
		contents.ipc.on(replyChannel, onReply);
		contents.once("destroyed", onDestroyed);
		contents.send(channel, nonce);
	});
}

/** The names of the workbench's modified working copies, as its tabs show them. */
export async function readUnsavedEditors(
	contents: WorkbenchContents,
	timeoutMs: number = UNSAVED_READ_TIMEOUT_MS,
): Promise<readonly string[]> {
	const reply = await askWorkbench(
		contents,
		"vscode:devhubUnsavedEditors",
		timeoutMs,
	);
	return namesOf(reply, "names");
}

/**
 * Throw away every unsaved change the workbench holds.
 *
 * Only after the person has chosen to close — this is the carrying out of
 * that answer, not a question. A working copy that would not revert, or that
 * is still modified afterwards, is a failure naming it: the close stops before
 * anything destructive, and nothing is quietly left for the unload to ask
 * about again.
 */
export async function discardUnsavedEditors(
	contents: WorkbenchContents,
	timeoutMs: number,
): Promise<void> {
	const reply = await askWorkbench(
		contents,
		"vscode:devhubDiscardUnsavedEditors",
		timeoutMs,
	);
	const errors = namesOf(reply, "errors");
	const remaining = namesOf(reply, "remaining");
	if (errors.length === 0 && remaining.length === 0) return;
	throw unsavedFailure(
		[
			remaining.length > 0
				? `Unsaved changes in ${remaining.join(", ")} could not be discarded.`
				: "Unsaved changes could not be discarded.",
			...errors,
		].join(" "),
	);
}

/**
 * A string list out of a reply. The reply is the patch's, so a reply of any
 * other shape is DevHub and its VS Code disagreeing — a broken build, said
 * as one.
 */
function namesOf(reply: unknown, field: string): readonly string[] {
	const value =
		typeof reply === "object" && reply !== null
			? (reply as Record<string, unknown>)[field]
			: undefined;
	if (
		!Array.isArray(value) ||
		!value.every((name): name is string => typeof name === "string")
	) {
		throw new InvariantViolation(
			`the workbench's reply has no string list \`${field}\`: ${JSON.stringify(reply)}`,
		);
	}
	return value;
}

function unsavedFailure(summary: string): TypedFailure {
	return new TypedFailure(
		withSummary(errorWireAt("workspace_unavailable"), summary),
	);
}
