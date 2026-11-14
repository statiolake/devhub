/**
 * Terminal surfaces: one view, one tmux client, one exact marked session.
 *
 * Ported from the `attach_surface` / `terminal_*` half of the Rust
 * `terminal/mod.rs`. The runtime owns tmux sessions; this owns the short-lived
 * clients that show them. Attaching resolves and verifies the exact marked
 * session first, then starts a tmux control client on it in the pty host — so
 * a client is only ever pointed at a session DevHub has just proven it owns.
 *
 * Detaching kills the client and nothing else. The session, its shell, its
 * scrollback and whatever is running in it stay on the server, which is what
 * makes the terminal survive a window close, a workspace switch, and a restart.
 */

import { startupTrace } from "../diagnostics/startupTrace.js";
import {
	TerminalFailure,
	type TerminalAttachReceipt,
	type TerminalSize,
} from "../../ipc/terminal.js";
import { OperationDeadline } from "./command.js";
import {
	AttachmentManager,
	type HostedRoute,
	type RequestIdentity,
} from "./attachments.js";
import {
	CancellationToken,
	PortFailure,
	type PaneTerminalTarget,
	type TerminalTarget,
	type WorkspaceTerminalTarget,
} from "./ports.js";
import { sessionMatches, type TmuxTerminalRuntime } from "./tmux.js";
import type { RuntimeId } from "../runtime/runtime.js";

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
		// A socket tmux cannot use is the runtime not being reachable, and the
		// detail — which socket, and why — is the summary.
		case "unavailable":
		case "socket_path_too_long":
		case "socket_unusable":
			return new TerminalFailure("runtime_unavailable", options);
		// Not "unavailable". A command that ran out of its budget says nothing
		// about whether the runtime is there — it is usually there and busy —
		// and a reader told the runtime is unavailable goes looking for a tmux
		// that is running fine. The same is true of a version DevHub cannot
		// work with: that runtime is present and answering.
		case "timed_out":
			return new TerminalFailure("runtime_timed_out", options);
		case "incompatible":
			return new TerminalFailure("runtime_incompatible", options);
		// The workspace's own folder, not the runtime. Closing a workspace
		// whose worktree has just been removed used to report the runtime as
		// unavailable, which is the wrong thing to go and check.
		case "root_missing":
			return new TerminalFailure("workspace_root_missing", options);
		case "root_inaccessible":
			return new TerminalFailure("workspace_root_inaccessible", options);
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
	/** The page as the pty host reaches it: the client talks to it there. */
	readonly route: HostedRoute;
}

export interface TerminalSurfacesOptions {
	/**
	 * The tmux adapter for one machine.
	 *
	 * A function and not a value, because a target names the machine its
	 * session is on and there is one adapter per machine: a surface holding one
	 * adapter would answer a Workspace on another computer with this Mac's tmux
	 * server, which is not a slower answer but a session that is not the one
	 * asked for.
	 */
	readonly runtimeFor: (machine: RuntimeId) => Promise<TmuxTerminalRuntime>;
	readonly attachments: AttachmentManager;
}

export class TerminalSurfaces {
	private readonly runtimeFor: (
		machine: RuntimeId,
	) => Promise<TmuxTerminalRuntime>;
	private readonly attachments: AttachmentManager;

	constructor(options: TerminalSurfacesOptions) {
		this.runtimeFor = options.runtimeFor;
		this.attachments = options.attachments;
	}

	get attachmentCount(): number {
		return this.attachments.count;
	}

	/**
	 * Attach one control client to an already verified marked session.
	 *
	 * The operation permit excludes a socket transition for the whole of it, so
	 * the session resolved at the start is still on the socket the client is
	 * pointed at.
	 */
	async attach(
		request: AttachSurfaceRequest,
		cancel = new CancellationToken(),
	): Promise<TerminalAttachReceipt> {
		startupTrace(`terminal:attach ${request.surfaceKey}`);
		const permit = this.attachments.beginAttach(
			request.target,
			request.surfaceKey,
			request.viewLabel,
			cancel,
		);
		try {
			const operation = permit.cancel;
			const runtime = await this.runtimeFor(request.target.machine);
			const release = await runtime.acquireOperation(operation);
			try {
				// The list `ensure` read back after its last change to the server.
				const sessions = await runtime.ensureUnlocked(
					request.target,
					operation,
				);
				startupTrace(`terminal:sessions-listed ${request.surfaceKey}`);
				const identity = runtime.targetIdentity(request.target, sessions);
				const exact = sessions.find(
					(session) =>
						session.name === identity.sessionName &&
						sessionMatches(session, identity),
				);
				// The client is never pointed at a name; it is pointed at a
				// session whose full marker triple was just read back.
				if (!exact) throw new TerminalFailure("session_unavailable");
				operation.check();
				const receipt = await this.attachments.attach(permit, {
					surfaceKey: request.surfaceKey,
					viewLabel: request.viewLabel,
					target: request.target,
					plan: (launch) => runtime.ptyPlan(launch),
					route: request.route,
					file: runtime.tmuxPath(),
					args: runtime.attachArgv(exact.name),
					// The client runs from the launch home: a workspace folder
					// that has been deleted must not make the client unusable.
					cwd: runtime.contextHome,
					environment: runtime.tmuxEnv(),
					size: request.size,
				});
				startupTrace(`terminal:client-started ${request.surfaceKey}`);
				return receipt;
			} finally {
				release();
			}
		} catch (failure: unknown) {
			const refused = terminalFailureFromPort(failure);
			startupTrace(`terminal:refused ${request.surfaceKey} ${refused.code}`);
			throw refused;
		} finally {
			permit.release();
		}
	}

	/**
	 * Whether `target`'s session is there now, without making it: the
	 * session of that exact marker triple, on the effective socket. A client
	 * that ended on its own (`onEndedByItself`) asks this to tell a session
	 * that ended from a person detaching from one that is still running.
	 */
	async sessionExists(
		target: TerminalTarget,
		cancel = new CancellationToken(),
	): Promise<boolean> {
		const runtime = await this.runtimeFor(target.machine);
		const release = await runtime.acquireOperation(cancel);
		try {
			const sessions = await runtime.listSessionsUnlocked(
				cancel,
				OperationDeadline.in(runtime.timeoutMs),
			);
			const identity = runtime.targetIdentity(target, sessions);
			return sessions.some(
				(session) =>
					session.name === identity.sessionName &&
					sessionMatches(session, identity),
			);
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
		const runtime = await this.runtimeFor(target.machine);
		await runtime.closeWorkspace(target, cancel);
	}

	/** Close one pane terminal for good: its clients, then its session. */
	async closePaneTerminal(
		target: PaneTerminalTarget,
		cancel = new CancellationToken(),
	): Promise<void> {
		this.attachments.detachTarget({ kind: "terminal", ...target });
		const runtime = await this.runtimeFor(target.machine);
		await runtime.closeTerminal(target, cancel);
	}
}
