/**
 * PTY attachments: the main-process half of the terminal contract.
 *
 * Ported from the Tauri app's `src-tauri/src/terminal/pty.rs`. A *surface* is a
 * semantic place a terminal lives (the scratch terminal, one workspace's
 * terminal); an *attachment* is one surface's live binding to a PTY, named by
 * an unguessable handle and a generation. The view can only act on the
 * attachment it was given: every request carries the handle, and a request that
 * names a surface it does not own is refused rather than resolved to "the
 * current one".
 *
 * **Who owns an attachment is the (page, surface) pair.** The Tauri app gave
 * every surface its own webview, so a view label named a surface and the two
 * were the same thing; in Electron the Scratch terminal and every workspace
 * terminal are components of the *same* App Shell page, and the pool keeps them
 * all mounted. So a page holds as many attachments as it has terminal surfaces,
 * a second attach of the same surface in the same page — a pooled surface
 * remounting — supersedes only itself, and the page label is what a closing
 * window releases as a group. An Agent surface is one of these too: it is a
 * tmux client like any other, on a session whose command happens to be an
 * agent, so there is one ledger and one rule rather than two of each.
 *
 * This module owns only short-lived tmux *client* processes and their PTY file
 * descriptors. Detaching kills the client; the tmux session it was attached to
 * belongs to the runtime and survives untouched. That is what makes a terminal
 * outlive the window, and the app.
 *
 * **Output is coalesced here, before the IPC hop, not in the view.** A curses
 * redraw — tmux, an agent's TUI — reaches this process as several small reads,
 * and one frame per read is one `terminal.write` per read. xterm queues those
 * writes internally but renders *between* tasks, and every frame arrives on its
 * own task, so the view paints the intermediate states of a redraw: the cursor
 * jumps through the positions the redraw passed over and an IME preedit
 * flickers. Batching in the view could not fix that on its own — the frames
 * have already been split by then — and batching here also halves the number of
 * IPC messages. This is what VS Code's pty host does with `TerminalDataBufferer`
 * (`vscode/src/vs/platform/terminal/common/terminalDataBuffering.ts`), and it is
 * done the same way for the same reason.
 *
 * The frame contract is unchanged by it: output frames still carry a contiguous
 * sequence, still never exceed `MAX_OUTPUT_FRAME_BYTES`, and still arrive in
 * PTY order relative to every other frame — pending bytes are flushed before an
 * error or an exit frame can be emitted, so nothing a child printed appears
 * after the news that it is gone. What changes is only how many reads one frame
 * is made of.
 *
 * Attaching resolves a live tmux session first, so it is not instantaneous, and
 * two attaches for the same surface can be in flight at once. The in-flight
 * ledger below is the Rust's `AttachPermit`: a newer attach supersedes an older
 * one before either can publish, so a surface can never be handed a receipt for
 * a client that has already been replaced. Publication itself is synchronous,
 * so once the ledger says an attach is current, nothing can interleave with it.
 */

import { POPUP_SCRIPT } from "../ptyHost/control/popup.js";
import {
	MAX_INPUT_SEQUENCE,
	MAX_OUTPUT_BUFFER_BYTES,
	MAX_OUTPUT_FRAME_BYTES,
	MAX_TARGET_GENERATION,
	RESIZE_INTERVAL_MS,
	TERMINAL_PROTOCOL_VERSION,
	TerminalFailure,
	type ExitReason,
	type TerminalAttachReceipt,
	type TerminalFrame,
	type TerminalSize,
} from "../../ipc/terminal.js";
import {
	type Pty,
	type PtyFactory,
	type PtyLaunch,
	type PtyPlan,
} from "./pty.js";
import { CancellationToken, sameTarget, type TerminalTarget } from "./ports.js";

const MAX_IN_FLIGHT_FRAMES = 8;
const MAX_IN_FLIGHT_BYTES = MAX_OUTPUT_BUFFER_BYTES;
const FLOW_CONTROL_TIMEOUT_MS = 2_000;
/** Output already read from the PTY but not yet sendable, bounded like the window. */
const MAX_QUEUED_OUTPUT_BYTES = MAX_OUTPUT_BUFFER_BYTES;
/**
 * How long the reads of one redraw are gathered before they become a frame.
 *
 * 5 ms is upstream's number: VS Code's pty host throttles terminal data by
 * exactly this before sending it to a renderer (`TerminalDataBufferer`'s
 * `throttleBy` default, `vscode/src/vs/platform/terminal/common/terminalDataBuffering.ts`).
 * It is under a frame at 120 Hz, so a coalesced redraw still lands in the same
 * paint the uncoalesced one would have, while the intermediate states of that
 * redraw never reach the view at all.
 */
export const OUTPUT_COALESCE_MS = 5;

/**
 * The view's end of one attachment.
 *
 * It answers whether the frame was delivered rather than throwing, because a
 * view that has gone away is not an error to report — it is the one condition
 * under which this side stops the PTY on its own, and it records that by
 * ending the attachment.
 */
export type FrameSink = (frame: TerminalFrame) => boolean;

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
	/**
	 * Where the tmux client is opened: on the machine its session is on.
	 *
	 * A `tmux attach` runs where the server is, so the PTY belongs to the
	 * target's machine and not to whichever machine the ledger happens to be
	 * running on. The ledger itself is one — a page's surfaces are released
	 * together whichever machines they reach — so the machine travels with the
	 * attachment rather than with the manager.
	 */
	readonly spawn: PtyFactory;
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
	readonly sink: FrameSink;
	/**
	 * What this client's machine would run on this machine to start it
	 * (`Runtime.ptyPlan`), for a client started in the pty host. `undefined`
	 * (or a plan of `undefined`): the client is started here, with `spawn`.
	 */
	readonly plan?: (launch: PtyLaunch) => PtyPlan | undefined;
	/** Where the page is reached from the pty host; absent: frames go to `sink`. */
	readonly route?: HostedRoute;
	/**
	 * A tmux control client (`tmux -C`, `docs/terminal-mode.md`): it runs in
	 * the pty host, on pipes, and the page draws its panes. Never in this
	 * process: without the host it is refused.
	 */
	readonly control?: boolean;
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

/** The cumulative-ack window that keeps output from running ahead of the view. */
export class FlowControl {
	private readonly pending = new Map<number, number>();
	private sent = 0;
	private closed = false;

	get lastSent(): number {
		return this.sent;
	}

	get inFlightBytes(): number {
		let total = 0;
		for (const bytes of this.pending.values()) total += bytes;
		return total;
	}

	get inFlightFrames(): number {
		return this.pending.size;
	}

	/**
	 * Claim window credit for one output frame. `false` means the view has not
	 * consumed enough yet — never that the frame was dropped.
	 */
	reserve(sequence: number, bytes: number): boolean {
		if (
			!Number.isSafeInteger(sequence) ||
			sequence < 1 ||
			sequence > MAX_INPUT_SEQUENCE
		) {
			throw new TerminalFailure("invalid_request");
		}
		if (bytes > MAX_OUTPUT_FRAME_BYTES) {
			throw new TerminalFailure("backpressure");
		}
		if (this.closed) throw new TerminalFailure("channel_closed");
		if (
			this.pending.size >= MAX_IN_FLIGHT_FRAMES ||
			this.inFlightBytes + bytes > MAX_IN_FLIGHT_BYTES
		) {
			return false;
		}
		this.pending.set(sequence, bytes);
		this.sent = sequence;
		return true;
	}

	/** Cumulative: everything up to and including `sequence` leaves the window. */
	acknowledge(sequence: number): boolean {
		if (
			!Number.isSafeInteger(sequence) ||
			sequence < 1 ||
			sequence > MAX_INPUT_SEQUENCE
		) {
			throw new TerminalFailure("invalid_request");
		}
		if (sequence > this.sent) throw new TerminalFailure("invalid_request");
		let completed = 0;
		for (const [key, bytes] of [...this.pending.entries()]) {
			if (key <= sequence) {
				completed += bytes;
				this.pending.delete(key);
			}
		}
		return completed > 0;
	}

	close(): void {
		this.closed = true;
		this.pending.clear();
	}
}

/**
 * Latest-wins resize with a floor on how often the PTY is actually resized.
 *
 * A drag delivers a burst; the PTY only needs where the drag currently is.
 */
class ResizeCoalescer {
	private pending: TerminalSize | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly apply: (size: TerminalSize) => void) {}

	request(size: TerminalSize): void {
		this.pending = size;
		if (this.timer !== undefined) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const next = this.pending;
			this.pending = undefined;
			if (next) this.apply(next);
		}, RESIZE_INTERVAL_MS);
	}

	get queued(): TerminalSize | undefined {
		return this.pending;
	}

	stop(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending = undefined;
	}
}

/**
 * One client's data path: its PTY, the output coalescer, the ack window and the
 * input ledger. The same code wherever the PTY is — in main, or in the pty host
 * (`main/ptyHost/`), which runs exactly this for every page attached to it.
 */
export class PtyAttachment {
	readonly flow = new FlowControl();
	private sequence = 0;
	private lastInputSequence = 0;
	private stopped = false;
	private readonly queue: Uint8Array[] = [];
	private queuedBytes = 0;
	private readonly pending: Uint8Array[] = [];
	private pendingBytes = 0;
	private coalesceTimer: ReturnType<typeof setTimeout> | undefined;
	private backpressureTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly resizer: ResizeCoalescer;
	private paused = false;

	constructor(
		readonly id: string,
		readonly surfaceKey: string,
		readonly viewLabel: string,
		readonly targetGeneration: number,
		private readonly pty: Pty,
		private readonly sink: FrameSink,
		private readonly onFinished: (
			attachment: PtyAttachment,
			reason: ExitReason,
		) => void,
	) {
		this.resizer = new ResizeCoalescer((size) => this.pty.resize(size));
	}

	get isStopped(): boolean {
		return this.stopped;
	}

	get pendingResize(): TerminalSize | undefined {
		return this.resizer.queued;
	}

	/**
	 * Hand the view a frame. A view that is gone ends the attachment; there is
	 * no state in which output keeps being produced for nobody.
	 */
	private emit(frame: TerminalFrame): boolean {
		if (this.sink(frame)) return true;
		this.stop("detached");
		return false;
	}

	sendStarted(size: TerminalSize): void {
		if (
			!this.emit({
				type: "started",
				schemaVersion: TERMINAL_PROTOCOL_VERSION,
				attachmentId: this.id,
				sequence: 0,
				surfaceKey: this.surfaceKey,
				targetGeneration: this.targetGeneration,
				cols: size.cols,
				rows: size.rows,
			})
		) {
			throw new TerminalFailure("channel_closed");
		}
	}

	/**
	 * PTY output, gathered for `OUTPUT_COALESCE_MS` before it becomes a frame.
	 *
	 * A read that already fills a frame has nothing to wait for, so the bound is
	 * also a flush: what is pending goes out at once, tail included, rather than
	 * a full frame leaving now and its remainder 5 ms later out of the same read.
	 */
	acceptOutput(bytes: Uint8Array): void {
		if (this.stopped || bytes.byteLength === 0) return;
		this.pending.push(new Uint8Array(bytes));
		this.pendingBytes += bytes.byteLength;
		if (this.pendingBytes >= MAX_OUTPUT_FRAME_BYTES) {
			this.flushPending();
			return;
		}
		if (this.coalesceTimer === undefined) {
			this.coalesceTimer = setTimeout(
				() => this.flushPending(),
				OUTPUT_COALESCE_MS,
			);
		}
	}

	/**
	 * Turn everything pending into frames, now.
	 *
	 * Pending bytes are taken before any of them is sent, so a failure raised
	 * while sending — which ends the attachment, and flushes on the way — finds
	 * nothing left to flush and cannot recurse.
	 */
	private flushPending(): void {
		if (this.coalesceTimer !== undefined) {
			clearTimeout(this.coalesceTimer);
			this.coalesceTimer = undefined;
		}
		if (this.pending.length === 0) return;
		const bytes = new Uint8Array(this.pendingBytes);
		let offset = 0;
		for (const chunk of this.pending) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		this.pending.length = 0;
		this.pendingBytes = 0;
		this.sendOutput(bytes);
	}

	/** Coalesced output, split at the frame bound and metered by the ack window. */
	private sendOutput(bytes: Uint8Array): void {
		for (
			let offset = 0;
			offset < bytes.byteLength;
			offset += MAX_OUTPUT_FRAME_BYTES
		) {
			const chunk = bytes.subarray(offset, offset + MAX_OUTPUT_FRAME_BYTES);
			if (this.queue.length > 0) {
				this.enqueue(chunk);
				continue;
			}
			if (!this.trySend(chunk)) this.enqueue(chunk);
		}
		this.updatePause();
	}

	private trySend(chunk: Uint8Array): boolean {
		const sequence = this.sequence + 1;
		let reserved: boolean;
		try {
			reserved = this.flow.reserve(sequence, chunk.byteLength);
		} catch (failure: unknown) {
			// The window itself refused the frame (oversized, or closed). That
			// is the attachment's end, reported to the view as its own frame.
			this.failWith(failure);
			return true;
		}
		if (!reserved) return false;
		this.sequence = sequence;
		this.emit({
			type: "output",
			schemaVersion: TERMINAL_PROTOCOL_VERSION,
			attachmentId: this.id,
			sequence,
			bytes: new Uint8Array(chunk),
		});
		return true;
	}

	private enqueue(chunk: Uint8Array): void {
		if (this.queuedBytes + chunk.byteLength > MAX_QUEUED_OUTPUT_BYTES) {
			this.failWith(new TerminalFailure("backpressure"));
			return;
		}
		this.queue.push(new Uint8Array(chunk));
		this.queuedBytes += chunk.byteLength;
		if (this.backpressureTimer === undefined) {
			// A view that stops acknowledging is not throttled forever: it is
			// disconnected, exactly as the blocking reader gave up in the Rust.
			this.backpressureTimer = setTimeout(() => {
				this.backpressureTimer = undefined;
				this.failWith(new TerminalFailure("backpressure"));
			}, FLOW_CONTROL_TIMEOUT_MS);
		}
	}

	private drain(): void {
		while (this.queue.length > 0) {
			const chunk = this.queue[0];
			if (!this.trySend(chunk)) return;
			if (this.stopped) return;
			this.queue.shift();
			this.queuedBytes -= chunk.byteLength;
		}
		if (this.backpressureTimer !== undefined) {
			clearTimeout(this.backpressureTimer);
			this.backpressureTimer = undefined;
		}
	}

	/**
	 * The PTY is paused while output is queued, so the child blocks on a full
	 * buffer instead of this process growing one.
	 */
	private updatePause(): void {
		if (this.stopped) return;
		const shouldPause = this.queue.length > 0;
		if (shouldPause === this.paused) return;
		this.paused = shouldPause;
		if (shouldPause) this.pty.pause();
		else this.pty.resume();
	}

	acknowledge(sequence: number): void {
		if (this.stopped) throw new TerminalFailure("wrong_attachment");
		this.flow.acknowledge(sequence);
		this.drain();
		this.updatePause();
	}

	/**
	 * Input is a strict, gap-free sequence. The ledger is what makes a replayed
	 * or reordered request impossible to mistake for the next keystroke.
	 */
	acceptInput(sequence: number, bytes: Uint8Array): void {
		if (this.stopped) throw new TerminalFailure("wrong_attachment");
		if (sequence !== this.lastInputSequence + 1) {
			throw new TerminalFailure("invalid_request");
		}
		this.lastInputSequence = sequence;
		this.pty.write(bytes);
	}

	requestResize(size: TerminalSize): void {
		if (this.stopped) throw new TerminalFailure("wrong_attachment");
		this.resizer.request(size);
	}

	private failWith(failure: unknown): void {
		if (this.stopped) return;
		// Whatever the child printed before the failure precedes the news of it.
		this.flushPending();
		if (this.stopped) return;
		const code = failure instanceof TerminalFailure ? failure.code : "internal";
		this.sequence += 1;
		this.sink({
			type: "error",
			schemaVersion: TERMINAL_PROTOCOL_VERSION,
			attachmentId: this.id,
			sequence: this.sequence,
			error: new TerminalFailure(code).toWire(),
		});
		this.stop("detached");
	}

	/** The PTY ended on its own. */
	handleExit(): void {
		if (this.stopped) return;
		this.finish("eof");
	}

	/** DevHub ended it: a detach, a replacement, a closed view, or quit. */
	stop(reason: ExitReason = "detached"): void {
		if (this.stopped) return;
		this.finish(reason);
	}

	private finish(reason: ExitReason): void {
		// Stopped first, so the flush below cannot re-enter this through a
		// failure; then the flush, so the last of the output is on the wire
		// before the frame that says there will be no more. What the window has
		// no room for is dropped here exactly as the queue below is: a view that
		// is not consuming is not owed the tail of a session it has ended.
		this.stopped = true;
		this.flushPending();
		this.resizer.stop();
		if (this.backpressureTimer !== undefined) {
			clearTimeout(this.backpressureTimer);
			this.backpressureTimer = undefined;
		}
		this.queue.length = 0;
		this.queuedBytes = 0;
		this.flow.close();
		this.sequence += 1;
		this.sink({
			type: "exited",
			schemaVersion: TERMINAL_PROTOCOL_VERSION,
			attachmentId: this.id,
			sequence: this.sequence,
			reason,
		});
		this.pty.kill();
		this.onFinished(this, reason);
	}
}

/** What one client is started as: the identity its frames carry. */
export interface PtyAttachmentSpec {
	readonly id: string;
	readonly surfaceKey: string;
	readonly viewLabel: string;
	readonly targetGeneration: number;
	readonly size: TerminalSize;
}

/**
 * Bind a freshly spawned PTY to its view and say `started`.
 *
 * Nothing may reach the view before the `started` frame. The PTY is held
 * paused until it is on the wire; this is the Rust reader gate, expressed where
 * the data actually comes from. Synchronous from the spawn to the resume, so no
 * other attach can interleave with it.
 */
export function startPtyAttachment(
	spec: PtyAttachmentSpec,
	pty: Pty,
	sink: FrameSink,
	onFinished: (attachment: PtyAttachment, reason: ExitReason) => void,
): PtyAttachment {
	pty.pause();
	const attachment = new PtyAttachment(
		spec.id,
		spec.surfaceKey,
		spec.viewLabel,
		spec.targetGeneration,
		pty,
		sink,
		onFinished,
	);
	pty.onData((bytes) => attachment.acceptOutput(bytes));
	pty.onExit(() => attachment.handleExit());
	attachment.sendStarted(spec.size);
	pty.resume();
	return attachment;
}

/**
 * The view asked for a terminal and there is none: tell it in the same shape
 * a later failure would take.
 */
export function reportSpawnFailure(
	sink: FrameSink,
	attachmentId: string,
): void {
	sink({
		type: "error",
		schemaVersion: TERMINAL_PROTOCOL_VERSION,
		attachmentId,
		sequence: 0,
		error: new TerminalFailure("pty_unavailable").toWire(),
	});
	sink({
		type: "exited",
		schemaVersion: TERMINAL_PROTOCOL_VERSION,
		attachmentId,
		sequence: 1,
		reason: "childExited",
	});
}

/**
 * Where a page's client is reached when its PTY runs in the pty host: the page
 * (an Electron `WebContents` in DevHub; opaque here) and its channel id there.
 */
export interface HostedRoute {
	readonly page: object;
	readonly channelId: string;
}

/** One client for the pty host to start. */
export interface HostedOpen extends PtyAttachmentSpec {
	readonly route: HostedRoute;
	readonly launch: PtyLaunch;
	/** A tmux control client: `launch` is run on pipes and drawn by the page. */
	readonly control?: boolean;
	/**
	 * A control client's popups: `POPUP_SCRIPT` in a pty on the same machine
	 * (`ptyHost/control/popup.ts`), opened once per `display-popup`.
	 */
	readonly popupLaunch?: PtyLaunch;
}

/**
 * The pty host as the ledger sees it (`main/ptyHost/client.ts`).
 *
 * The host runs the client's data path — the PTY, the frames, the acks, the
 * input — directly with the page, over a port of the page's own; the ledger
 * here keeps who owns what. `open` settles once the host has started the
 * client and put its `started` frame on the page's port, with the host's
 * generation; it rejects as `TerminalFailure` (`pty_unavailable`, or
 * `host_restarted` when the host ended first). What the host ends on its own
 * comes back through `AttachmentManager.hostedEnded`.
 */
export interface HostedPtys {
	/** False once the host was given up on: clients run in this process again. */
	readonly available: boolean;
	open(spec: HostedOpen): Promise<number>;
	stop(id: string, reason: ExitReason): void;
}

export interface AttachmentManagerOptions {
	/** Overridden only by tests; production opens the target machine's PTY. */
	readonly spawn?: PtyFactory;
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
	/** Where clients run when a context offers a route to it; absent: here. */
	readonly hosted?: HostedPtys;
}

interface InFlightAttach {
	readonly ownerKey: string;
	readonly viewLabel: string;
	readonly target: TerminalTarget;
	readonly cancel: CancellationToken;
}

/** One attachment in the ledger, wherever its PTY is. */
interface LedgerEntry {
	readonly id: string;
	readonly surfaceKey: string;
	readonly viewLabel: string;
	readonly target: TerminalTarget;
	readonly targetGeneration: number;
	stop(reason?: ExitReason): void;
	acceptInput(sequence: number, bytes: Uint8Array): void;
	requestResize(size: TerminalSize): void;
	acknowledge(sequence: number): void;
}

/** A client whose PTY is in this process. */
class LocalEntry implements LedgerEntry {
	constructor(
		readonly live: PtyAttachment,
		readonly target: TerminalTarget,
	) {}
	get id(): string {
		return this.live.id;
	}
	get surfaceKey(): string {
		return this.live.surfaceKey;
	}
	get viewLabel(): string {
		return this.live.viewLabel;
	}
	get targetGeneration(): number {
		return this.live.targetGeneration;
	}
	stop(reason?: ExitReason): void {
		this.live.stop(reason);
	}
	acceptInput(sequence: number, bytes: Uint8Array): void {
		this.live.acceptInput(sequence, bytes);
	}
	requestResize(size: TerminalSize): void {
		this.live.requestResize(size);
	}
	acknowledge(sequence: number): void {
		this.live.acknowledge(sequence);
	}
}

/**
 * A client whose PTY is in the pty host. Its input, resizes and acks go from
 * the page to the host directly, so asking this process for them is asking the
 * wrong owner.
 */
class HostedEntry implements LedgerEntry {
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

	acceptInput(): void {
		throw new TerminalFailure("wrong_attachment");
	}
	requestResize(): void {
		throw new TerminalFailure("wrong_attachment");
	}
	acknowledge(): void {
		throw new TerminalFailure("wrong_attachment");
	}
}

export class AttachmentManager {
	private readonly attachments = new Map<string, LedgerEntry>();
	/** Every hosted client until the host says it has ended, ledger or not. */
	private readonly hostedClients = new Map<string, HostedEntry>();
	private readonly inFlight = new Map<number, InFlightAttach>();
	private nextAttachKey = 1;
	private readonly spawn: PtyFactory | undefined;
	private readonly randomBytes: (count: number) => Uint8Array;
	private readonly onEndedByItself: AttachmentManagerOptions["onEndedByItself"];
	private readonly hosted: HostedPtys | undefined;
	private generation: number;

	constructor(options: AttachmentManagerOptions) {
		// The Agent pane's PTY is opened on the Workspace's machine, which the
		// attach context names. The injected one is the tests' fake, and it
		// stands in for every machine at once — which is what a test wants.
		this.spawn = options.spawn;
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
			args: context.control === true ? controlArgv(context.args) : context.args,
			...(context.control === true ? { pipes: true } : {}),
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
			const plan = context.plan?.({
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

	private finished(entry: LedgerEntry, reason: ExitReason): void {
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
	 * Publish one resolved client as this surface's attachment, in this process.
	 *
	 * Everything from here to the receipt is synchronous: the child is spawned,
	 * registered and given its Started frame without yielding, so no other
	 * attach can interleave with it.
	 */
	attach(permit: AttachPermit, context: AttachContext): TerminalAttachReceipt {
		if (!this.isCurrent(permit)) throw new TerminalFailure("stale_target");
		// A replacement is reaped before the new PTY exists, so the old child
		// never outlives the receipt that named it.
		this.replaceSurface(context.surfaceKey);
		const id = this.nextId();
		const targetGeneration = this.nextGeneration();
		let pty: Pty;
		try {
			pty = (this.spawn ?? context.spawn)(this.launchOf(context));
		} catch (failure: unknown) {
			// The view asked for a terminal and there is none. Tell it in the
			// same shape a later failure would take, then reject the request.
			reportSpawnFailure(context.sink, id);
			throw failure instanceof TerminalFailure
				? failure
				: new TerminalFailure("pty_unavailable", { cause: failure });
		}
		const live = startPtyAttachment(
			{
				id,
				surfaceKey: context.surfaceKey,
				viewLabel: context.viewLabel,
				targetGeneration,
				size: context.size,
			},
			pty,
			context.sink,
			(_finished, reason) => {
				const entry = this.attachments.get(id);
				if (entry !== undefined) this.finished(entry, reason);
			},
		);
		const entry = new LocalEntry(live, context.target);
		// A client that ended while it was being started (its frames already
		// said so) is not published.
		if (!live.isStopped) this.attachments.set(id, entry);
		return {
			schemaVersion: TERMINAL_PROTOCOL_VERSION,
			attachmentId: id,
			surfaceKey: context.surfaceKey,
			targetGeneration,
		};
	}

	/**
	 * Publish one resolved client, in the pty host when the context has a route
	 * there and its machine can say what to run (`Runtime.ptyPlan`); here
	 * otherwise, as `attach`.
	 *
	 * The hosted client is in the ledger from before the host is asked, so an
	 * end the host reports at any point finds it; an attach superseded while
	 * the host was starting it is stopped there and refused as stale.
	 */
	async attachVia(
		permit: AttachPermit,
		context: AttachContext,
	): Promise<TerminalAttachReceipt> {
		const hosted = this.hosted;
		const route = context.route;
		if (
			hosted === undefined ||
			!hosted.available ||
			route === undefined ||
			context.plan === undefined
		) {
			if (context.control === true)
				throw new TerminalFailure("pty_unavailable");
			return this.attach(permit, context);
		}
		if (!this.isCurrent(permit)) throw new TerminalFailure("stale_target");
		let plan: PtyPlan | undefined;
		try {
			plan = context.plan(this.launchOf(context));
		} catch {
			// The machine cannot say what it would open: opening it here says
			// so, in the shape every failure to open one takes.
			plan = undefined;
		}
		if (plan === undefined) {
			if (context.control === true)
				throw new TerminalFailure("pty_unavailable");
			return this.attach(permit, context);
		}
		const popupLaunch =
			context.control === true ? this.popupLaunchOf(context) : undefined;
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
				...(context.control === true ? { control: true } : {}),
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
			// It ended, or was replaced, while it was being started; its frames
			// have said so to the page.
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

	/** The pty host generation a hosted client was started in; `undefined` for one here. */
	hostedGeneration(id: string): number | undefined {
		const entry = this.attachments.get(id);
		return entry instanceof HostedEntry ? entry.generation : undefined;
	}

	input(identity: RequestIdentity, sequence: number, bytes: Uint8Array): void {
		this.owned(identity).acceptInput(sequence, bytes);
	}

	resize(identity: RequestIdentity, size: TerminalSize): void {
		this.owned(identity).requestResize(size);
	}

	acknowledge(identity: RequestIdentity, sequence: number): void {
		this.owned(identity).acknowledge(sequence);
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

	private owned(identity: RequestIdentity): LedgerEntry {
		const attachment = this.attachments.get(identity.attachmentId);
		if (
			!attachment ||
			attachment.surfaceKey !== identity.surfaceKey ||
			attachment.viewLabel !== identity.viewLabel ||
			attachment.targetGeneration !== identity.targetGeneration
		) {
			throw new TerminalFailure("wrong_attachment");
		}
		return attachment;
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
