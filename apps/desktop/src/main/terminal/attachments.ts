/**
 * Terminal attachments: the ledger of who owns which tmux control client.
 *
 * Ported from the Tauri app's `src-tauri/src/terminal/pty.rs`. A *surface* is a
 * semantic place a terminal lives (one workspace's terminal, an Agent's); an
 * *attachment* is one surface's live control client (`tmux -C`), named by an
 * unguessable handle and a generation. The view can only act on the
 * attachment it was given: every request carries the handle, and a request that
 * names a surface it does not own is refused rather than resolved to "the
 * current one".
 *
 * **Who owns an attachment is the (page, surface) pair.** Every terminal
 * surface of a window can be a component of the same page, so a page holds as
 * many attachments as it has terminal surfaces, a second attach of the same
 * surface in the same page — a pooled surface remounting — supersedes only
 * itself, and the page label is what a closing window releases as a group.
 *
 * **Every client runs in the pty host** (`main/ptyHost/`): its child on pipes,
 * its panes' engines, and its data path with the page over the page's own
 * port. This module keeps only the ledger. Detaching ends the client; the tmux
 * session it was attached to belongs to the runtime and survives untouched.
 * That is what makes a terminal outlive the window, the pty host, and the app.
 *
 * Attaching resolves a live tmux session first, so it is not instantaneous, and
 * two attaches for the same surface can be in flight at once. The in-flight
 * ledger below is the Rust's `AttachPermit`: a newer attach supersedes an older
 * one before either can publish, so a surface can never be handed a receipt for
 * a client that has already been replaced.
 */

import { POPUP_SCRIPT } from "../ptyHost/control/popup.js";
import {
	MAX_TARGET_GENERATION,
	TERMINAL_PROTOCOL_VERSION,
	TerminalFailure,
	type ExitReason,
	type TerminalAttachReceipt,
	type TerminalSize,
} from "../../ipc/terminal.js";
import type { PtyLaunch, PtyPlan } from "./pty.js";
import { CancellationToken, sameTarget, type TerminalTarget } from "./ports.js";

/**
 * Who owns an attachment: one terminal surface inside one page.
 *
 * The page label alone names the page and nothing finer — every terminal
 * surface of a window is a component of the same App Shell page — so the pair
 * is what a reservation, a supersede and a remount are keyed by.
 */
export function surfaceOwnerKey(viewLabel: string, surfaceKey: string): string {
	return `${viewLabel}\u0000${surfaceKey}`;
}

export interface AttachContext {
	readonly surfaceKey: string;
	/** The page this surface is mounted in: one page holds several. */
	readonly viewLabel: string;
	/** The semantic terminal this attachment is a client of. */
	readonly target: TerminalTarget;
	/** The tmux client to run, resolved against an exact marked session. */
	readonly file: string;
	readonly args: readonly string[];
	/** The client's working directory: the launch home, never a workspace. */
	readonly cwd: string;
	/**
	 * The environment this client runs in, whole.
	 *
	 * Composed by the adapter of the machine the client runs on
	 * (`TmuxTerminalRuntime.tmuxEnv`), from that machine's own environment — not
	 * merged here over "the one environment every DevHub child shares", which
	 * was this Mac's and was therefore wrong for every client that runs
	 * somewhere else. A tmux DevHub shipped to a host also needs the terminfo
	 * database that travelled with it, and that belongs to the executable, so it
	 * arrives with the executable in the same answer.
	 *
	 * Required, because "the environment this runs in" has no sensible default:
	 * the one the ledger could have supplied names a different machine's
	 * directories.
	 */
	readonly environment: Readonly<Record<string, string>>;
	readonly size: TerminalSize;
	/**
	 * What this client's machine would run on this machine to start it
	 * (`Runtime.ptyPlan`): on this Mac the attach itself, for a host its
	 * `ssh -T`. `undefined`: it cannot say, and the attach is refused.
	 */
	readonly plan: (launch: PtyLaunch) => PtyPlan | undefined;
	/** Where the page is reached from the pty host. */
	readonly route: HostedRoute;
}

/**
 * A place in the in-flight ledger.
 *
 * Holding one is what makes an attach publishable. A newer attach for the same
 * surface owner or the same target cancels this permit's token, so the provider
 * work it is waiting on stops and the publication is refused as stale.
 */
export interface AttachPermit {
	readonly cancel: CancellationToken;
	release(): void;
}

/**
 * The identity every non-attach request must present.
 *
 * The surface key and the page label together name the owner, and the
 * attachment id and generation name the exact client it was handed. All four
 * must match: a stale handle is refused, never resolved to whatever is current.
 */
export interface RequestIdentity {
	readonly surfaceKey: string;
	readonly attachmentId: string;
	readonly viewLabel: string;
	readonly targetGeneration: number;
}

/**
 * Where a page's client is reached in the pty host: the page (an Electron
 * `WebContents` in DevHub; opaque here) and its channel id there.
 */
export interface HostedRoute {
	readonly page: object;
	readonly channelId: string;
}

/** One control client for the pty host to start: `launch` is run on pipes. */
export interface HostedOpen {
	readonly id: string;
	readonly surfaceKey: string;
	readonly viewLabel: string;
	readonly targetGeneration: number;
	readonly size: TerminalSize;
	readonly route: HostedRoute;
	readonly launch: PtyLaunch;
	/**
	 * A control client's popups: `POPUP_SCRIPT` in a pty on the same machine
	 * (`ptyHost/control/popup.ts`), opened once per `display-popup`.
	 */
	readonly popupLaunch?: PtyLaunch;
}

/**
 * The pty host as the ledger sees it (`main/ptyHost/client.ts`).
 *
 * The host runs the client's data path directly with the page, over a port of
 * the page's own; the ledger here keeps who owns what. `open` settles once the
 * host has started the client, with the host's generation; it rejects as
 * `TerminalFailure` (`pty_unavailable`, or `host_restarted` when the host
 * ended first). What the host ends on its own comes back through
 * `AttachmentManager.hostedEnded`.
 */
export interface HostedPtys {
	/**
	 * False once the host kept ending and was given up on: attaches are
	 * refused as `pty_unavailable` until the person restarts the terminals
	 * (`PtyHostClient.restart`).
	 */
	readonly available: boolean;
	open(spec: HostedOpen): Promise<number>;
	stop(id: string, reason: ExitReason): void;
}

export interface AttachmentManagerOptions {
	readonly randomBytes: (count: number) => Uint8Array;
	/**
	 * A client ended on its own (`eof`): its PTY closed without DevHub
	 * stopping it — the session it showed ended (its last shell exited, it
	 * was killed), or the person detached from it with tmux's own keys.
	 * Everything DevHub ends itself — a detach, a replacement, a closed view,
	 * a close, a socket move, quit — stops the client first, as `detached`,
	 * and is not told here.
	 */
	readonly onEndedByItself?: (ended: {
		readonly surfaceKey: string;
		readonly target: TerminalTarget;
	}) => void;
	/** Where clients run; absent (a test of the ledger alone): every attach is refused. */
	readonly hosted?: HostedPtys;
}

interface InFlightAttach {
	readonly ownerKey: string;
	readonly viewLabel: string;
	readonly target: TerminalTarget;
	readonly cancel: CancellationToken;
}

/**
 * One control client in the ledger. What the page sends it goes to the host
 * directly; this process only starts and stops it.
 */
class HostedEntry {
	#stopped = false;
	#ended = false;
	generation = 0;

	constructor(
		readonly id: string,
		readonly surfaceKey: string,
		readonly viewLabel: string,
		readonly target: TerminalTarget,
		readonly targetGeneration: number,
		private readonly host: HostedPtys,
		private readonly plan: PtyPlan,
		private readonly gone: (entry: HostedEntry, reason: ExitReason) => void,
	) {}

	get isEnded(): boolean {
		return this.#ended;
	}

	/** DevHub ends it: the host is told, and the ledger lets go at once. */
	stop(reason: ExitReason = "detached"): void {
		if (this.#stopped) return;
		this.#stopped = true;
		if (!this.#ended) this.host.stop(this.id, reason);
		this.gone(this, reason);
	}

	/** The host says it has ended (or the host itself has). */
	ended(reason: ExitReason): void {
		if (this.#ended) return;
		this.#ended = true;
		this.plan.ended();
		if (this.#stopped) return;
		this.#stopped = true;
		this.gone(this, reason);
	}
}

export class AttachmentManager {
	private readonly attachments = new Map<string, HostedEntry>();
	/** Every hosted client until the host says it has ended, ledger or not. */
	private readonly hostedClients = new Map<string, HostedEntry>();
	private readonly inFlight = new Map<number, InFlightAttach>();
	private nextAttachKey = 1;
	private readonly randomBytes: (count: number) => Uint8Array;
	private readonly onEndedByItself: AttachmentManagerOptions["onEndedByItself"];
	private readonly hosted: HostedPtys | undefined;
	private generation: number;

	constructor(options: AttachmentManagerOptions) {
		this.randomBytes = options.randomBytes;
		this.onEndedByItself = options.onEndedByItself;
		this.hosted = options.hosted;
		// The ledger starts somewhere unguessable, so a generation from one run
		// of the app is not a usable capability in the next.
		// Six bytes: unguessable, and still an exact integer.
		const seed = this.randomBytes(6);
		let value = 0;
		for (const byte of seed) value = value * 256 + byte;
		this.generation = (value % MAX_TARGET_GENERATION) + 1;
	}

	get count(): number {
		return this.attachments.size;
	}

	/**
	 * Claim the in-flight ledger for one attach.
	 *
	 * An owner — one surface of one page — has one attach at a time, so an
	 * older attach by the same owner, or for the same terminal, is superseded
	 * here, before either can publish. A sibling surface of the same page is a
	 * different owner and is left alone. The superseded entry stays in the
	 * ledger until its permit is released, which is what gives its publisher a
	 * definitive stale answer instead of a timing-dependent lookup.
	 */
	beginAttach(
		target: TerminalTarget,
		surfaceKey: string,
		viewLabel: string,
		cancel: CancellationToken,
	): AttachPermit {
		cancel.check();
		const key = this.nextAttachKey;
		this.nextAttachKey += 1;
		const ownerKey = surfaceOwnerKey(viewLabel, surfaceKey);
		for (const inFlight of this.inFlight.values()) {
			if (
				inFlight.ownerKey === ownerKey ||
				sameTarget(inFlight.target, target)
			) {
				inFlight.cancel.cancel();
			}
		}
		const operation = cancel.child();
		this.inFlight.set(key, { ownerKey, viewLabel, target, cancel: operation });
		let released = false;
		return {
			cancel: operation,
			release: () => {
				if (released) return;
				released = true;
				this.inFlight.delete(key);
			},
		};
	}

	private isCurrent(permit: AttachPermit): boolean {
		if (permit.cancel.isCancelled) return false;
		for (const inFlight of this.inFlight.values()) {
			if (inFlight.cancel === permit.cancel) return true;
		}
		return false;
	}

	/**
	 * One surface's previous client goes before its next one exists: a surface
	 * that remounts, or that is opened in another page, replaces its own client
	 * and nobody else's. The sibling surfaces of this page keep theirs.
	 */
	private replaceSurface(surfaceKey: string): void {
		for (const existing of [...this.attachments.values()]) {
			if (existing.surfaceKey === surfaceKey) existing.stop("detached");
		}
	}

	private launchOf(context: AttachContext): PtyLaunch {
		return {
			file: context.file,
			args: controlArgv(context.args),
			pipes: true,
			cwd: context.cwd,
			cols: context.size.cols,
			rows: context.size.rows,
			pixelWidth: context.size.pixelWidth,
			pixelHeight: context.size.pixelHeight,
			env: { ...context.environment },
		};
	}

	/**
	 * What a control client's popups are opened as: `sh -c POPUP_SCRIPT` on
	 * the client's machine, said by the machine as it says the client. A
	 * popup's SSH session is short and one at a time; its slot is not held.
	 */
	private popupLaunchOf(context: AttachContext): PtyLaunch | undefined {
		try {
			const plan = context.plan({
				...this.launchOf(context),
				file: "/bin/sh",
				args: ["-c", POPUP_SCRIPT],
				pipes: undefined,
			});
			plan?.ended();
			if (plan === undefined) return undefined;
			const { pipes: _pipes, ...launch } = plan.launch;
			return launch;
		} catch {
			return undefined;
		}
	}

	private finished(entry: HostedEntry, reason: ExitReason): void {
		if (this.attachments.get(entry.id) === entry) {
			this.attachments.delete(entry.id);
		}
		if (reason === "eof")
			this.onEndedByItself?.({
				surfaceKey: entry.surfaceKey,
				target: entry.target,
			});
	}

	/**
	 * Publish one resolved client as this surface's attachment, in the pty
	 * host, once its machine has said what to run (`Runtime.ptyPlan`).
	 *
	 * The client is in the ledger from before the host is asked, so an end the
	 * host reports at any point finds it; an attach superseded while the host
	 * was starting it is stopped there and refused as stale.
	 */
	async attach(
		permit: AttachPermit,
		context: AttachContext,
	): Promise<TerminalAttachReceipt> {
		const hosted = this.hosted;
		if (hosted === undefined || !hosted.available)
			throw new TerminalFailure("pty_unavailable");
		if (!this.isCurrent(permit)) throw new TerminalFailure("stale_target");
		let plan: PtyPlan | undefined;
		try {
			plan = context.plan(this.launchOf(context));
		} catch (failure: unknown) {
			throw new TerminalFailure("pty_unavailable", { cause: failure });
		}
		if (plan === undefined) throw new TerminalFailure("pty_unavailable");
		const popupLaunch = this.popupLaunchOf(context);
		const route = context.route;
		this.replaceSurface(context.surfaceKey);
		const id = this.nextId();
		const targetGeneration = this.nextGeneration();
		const entry = new HostedEntry(
			id,
			context.surfaceKey,
			context.viewLabel,
			context.target,
			targetGeneration,
			hosted,
			plan,
			(gone, reason) => this.finished(gone, reason),
		);
		this.attachments.set(id, entry);
		this.hostedClients.set(id, entry);
		try {
			entry.generation = await hosted.open({
				id,
				surfaceKey: context.surfaceKey,
				viewLabel: context.viewLabel,
				targetGeneration,
				size: context.size,
				route,
				launch: plan.launch,
				...(popupLaunch === undefined ? {} : { popupLaunch }),
			});
		} catch (failure: unknown) {
			entry.ended("childExited");
			this.hostedClients.delete(id);
			throw failure instanceof TerminalFailure
				? failure
				: new TerminalFailure("pty_unavailable", { cause: failure });
		}
		if (!this.isCurrent(permit)) {
			entry.stop("detached");
			throw new TerminalFailure("stale_target");
		}
		if (entry.isEnded || this.attachments.get(id) !== entry) {
			// It ended, or was replaced, while it was being started; its last
			// message has said so to the page.
			throw new TerminalFailure("channel_closed");
		}
		return {
			schemaVersion: TERMINAL_PROTOCOL_VERSION,
			attachmentId: id,
			surfaceKey: context.surfaceKey,
			targetGeneration,
		};
	}

	/** A hosted client ended, as the pty host says (or because it did). */
	hostedEnded(id: string, reason: ExitReason): void {
		const entry = this.hostedClients.get(id);
		if (entry === undefined) return;
		this.hostedClients.delete(id);
		entry.ended(reason);
	}

	/** The pty host generation a client was started in. */
	hostedGeneration(id: string): number | undefined {
		return this.attachments.get(id)?.generation;
	}

	/** Idempotent for the exact handle; a different handle is never inferred. */
	detach(identity: RequestIdentity): void {
		const existing = this.attachments.get(identity.attachmentId);
		if (!existing) return;
		if (
			existing.surfaceKey !== identity.surfaceKey ||
			existing.viewLabel !== identity.viewLabel ||
			existing.targetGeneration !== identity.targetGeneration
		) {
			throw new TerminalFailure("wrong_attachment");
		}
		existing.stop("detached");
	}

	/**
	 * Every client a page holds goes, and every attach it has in flight is
	 * cancelled. This is the page-scoped release — a window closing, a page
	 * reloading — and the only path that takes a page's surfaces as a group.
	 */
	detachView(viewLabel: string): void {
		for (const inFlight of this.inFlight.values()) {
			if (inFlight.viewLabel === viewLabel) inFlight.cancel.cancel();
		}
		for (const attachment of [...this.attachments.values()]) {
			if (attachment.viewLabel === viewLabel) attachment.stop("detached");
		}
	}

	/**
	 * Every client of one terminal goes, before its session is closed. The
	 * session itself is the runtime's to kill, never this module's.
	 */
	detachTarget(target: TerminalTarget): void {
		for (const inFlight of this.inFlight.values()) {
			if (sameTarget(inFlight.target, target)) inFlight.cancel.cancel();
		}
		for (const attachment of [...this.attachments.values()]) {
			if (sameTarget(attachment.target, target)) attachment.stop("detached");
		}
	}

	detachAll(): void {
		for (const inFlight of this.inFlight.values()) inFlight.cancel.cancel();
		for (const attachment of [...this.attachments.values()]) {
			attachment.stop("detached");
		}
	}

	private nextId(): string {
		return [...this.randomBytes(16)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
	}

	private nextGeneration(): number {
		const generation = this.generation;
		this.generation = generation >= MAX_TARGET_GENERATION ? 1 : generation + 1;
		return generation;
	}
}

/**
 * The attach argv as a control client's: `-C` before `attach-session`, the
 * rest (the socket, the config, the exact session) as it was.
 */
export function controlArgv(args: readonly string[]): readonly string[] {
	const at = args.indexOf("attach-session");
	if (at < 0) throw new TerminalFailure("invalid_request");
	return [...args.slice(0, at), "-C", ...args.slice(at)];
}
