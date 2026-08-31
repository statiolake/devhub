/**
 * Terminal surfaces: one view, one tmux client, one exact marked session.
 *
 * Ported from the `attach_surface` / `terminal_*` half of the Rust
 * `terminal/mod.rs`. The runtime owns tmux sessions; this owns the short-lived
 * clients that show them. Attaching resolves and verifies the exact marked
 * session first, then runs `tmux attach-session` on a PTY — so a client is only
 * ever pointed at a session DevHub has just proven it owns.
 *
 * Detaching kills the client and nothing else. The session, its shell, its
 * scrollback and whatever is running in it stay on the server, which is what
 * makes the terminal survive a window close, a workspace switch, and a restart.
 */

import {
	TerminalFailure,
	type TerminalAttachReceipt,
	type TerminalSize,
} from "../../ipc/terminal.js";
import { OperationDeadline } from "./command.js";
import {
	AttachmentManager,
	type FrameSink,
	type RequestIdentity,
} from "./attachments.js";
import {
	CancellationToken,
	PortFailure,
	type TerminalTarget,
	type WorkspaceTerminalTarget,
} from "./ports.js";
import { sessionMatches, type TmuxTerminalRuntime } from "./tmux.js";

/**
 * A runtime failure as the view sees it.
 *
 * The wire has one error vocabulary; this is the single place a provider-level
 * reason is translated into it, so the same condition always reaches the page
 * as the same code.
 */
export function terminalFailureFromPort(failure: unknown): TerminalFailure {
	if (failure instanceof TerminalFailure) return failure;
	if (!(failure instanceof PortFailure)) {
		return new TerminalFailure("internal", { cause: failure });
	}
	// The port's detail, where it has one, is the sentence: it names the
	// executable and the search, which is what the code alone cannot say.
	const options = { cause: failure, summary: failure.detail };
	switch (failure.code) {
		case "unavailable":
		case "timed_out":
		case "incompatible":
			return new TerminalFailure("runtime_unavailable", options);
		case "conflict":
			return new TerminalFailure("session_unavailable", options);
		case "cancelled":
			return new TerminalFailure("stale_target", options);
		default:
			return new TerminalFailure("internal", options);
	}
}

export interface AttachSurfaceRequest {
	readonly target: TerminalTarget;
	readonly surfaceKey: string;
	/** The page the surface is mounted in; with the key, it names the owner. */
	readonly viewLabel: string;
	readonly size: TerminalSize;
	readonly sink: FrameSink;
}

export interface TerminalSurfacesOptions {
	readonly runtime: TmuxTerminalRuntime;
	readonly attachments: AttachmentManager;
}

export class TerminalSurfaces {
	private readonly runtime: TmuxTerminalRuntime;
	private readonly attachments: AttachmentManager;

	constructor(options: TerminalSurfacesOptions) {
		this.runtime = options.runtime;
		this.attachments = options.attachments;
	}

	get attachmentCount(): number {
		return this.attachments.count;
	}

	/**
	 * Attach one PTY client to an already verified marked session.
	 *
	 * The operation permit excludes a socket transition for the whole of it, so
	 * the session resolved at the start is still on the socket the client is
	 * pointed at.
	 */
	async attach(
		request: AttachSurfaceRequest,
		cancel = new CancellationToken(),
	): Promise<TerminalAttachReceipt> {
		const permit = this.attachments.beginAttach(
			request.target,
			request.surfaceKey,
			request.viewLabel,
			cancel,
		);
		try {
			const operation = permit.cancel;
			const release = await this.runtime.acquireOperation(operation);
			try {
				const deadline = OperationDeadline.in(this.runtime.timeoutMs);
				await this.runtime.ensureUnlocked(request.target, operation);
				const sessions = await this.runtime.listSessionsUnlocked(
					operation,
					deadline,
				);
				const identity = this.runtime.targetIdentity(request.target, sessions);
				const exact = sessions.find(
					(session) =>
						session.name === identity.sessionName &&
						sessionMatches(session, identity),
				);
				// `ensure` only guarantees the session existed a moment ago. The
				// client is never pointed at a name; it is pointed at a session
				// whose full marker triple was just read back.
				if (!exact) throw new TerminalFailure("session_unavailable");
				operation.check();
				return this.attachments.attach(permit, {
					surfaceKey: request.surfaceKey,
					viewLabel: request.viewLabel,
					target: request.target,
					file: this.runtime.tmuxPath(),
					args: this.runtime.attachArgv(exact.name),
					// The client runs from the launch home: a workspace folder
					// that has been deleted must not make the client unusable.
					cwd: this.runtime.contextHome,
					size: request.size,
					sink: request.sink,
				});
			} finally {
				release();
			}
		} catch (failure: unknown) {
			throw terminalFailureFromPort(failure);
		} finally {
			permit.release();
		}
	}

	input(identity: RequestIdentity, sequence: number, bytes: Uint8Array): void {
		this.attachments.input(identity, sequence, bytes);
	}

	acknowledge(identity: RequestIdentity, sequence: number): void {
		this.attachments.acknowledge(identity, sequence);
	}

	/**
	 * Resize the client PTY and the session's window.
	 *
	 * tmux keeps a detached session's window at its old dimensions even after
	 * an attached client reports a new size, so resizing only the PTY would
	 * leave the shell believing it is still the size it was.
	 */
	async resize(
		identity: RequestIdentity,
		target: TerminalTarget,
		size: TerminalSize,
		cancel = new CancellationToken(),
	): Promise<void> {
		const release = await this.runtime.acquireOperation(cancel);
		try {
			this.attachments.resize(identity, size);
			await this.runtime.resizeOwnedWindow(target, size, cancel);
		} catch (failure: unknown) {
			throw terminalFailureFromPort(failure);
		} finally {
			release();
		}
	}

	detach(identity: RequestIdentity): void {
		this.attachments.detach(identity);
	}

	detachView(viewLabel: string): void {
		this.attachments.detachView(viewLabel);
	}

	detachAll(): void {
		this.attachments.detachAll();
	}

	/**
	 * Close one workspace's terminal for good: its clients first, then the
	 * session itself. A session is only ever killed once nothing is attached.
	 */
	async closeWorkspace(
		target: WorkspaceTerminalTarget,
		cancel = new CancellationToken(),
	): Promise<void> {
		this.attachments.detachTarget({ kind: "workspace", ...target });
		await this.runtime.closeWorkspace(target, cancel);
	}
}
