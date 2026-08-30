/**
 * PTY attachments: the main-process half of the terminal contract.
 *
 * Ported from the Tauri app's `src-tauri/src/terminal/pty.rs`. A *surface* is a
 * semantic place a terminal lives (the scratch terminal, one workspace's
 * terminal); an *attachment* is one view's live binding to a PTY for that
 * surface, named by an unguessable handle and a generation. The view can only
 * act on the attachment it was given: every request carries the handle, and a
 * request that names a surface it does not own is refused rather than resolved
 * to "the current one".
 *
 * This module owns only short-lived tmux *client* processes and their PTY file
 * descriptors. Detaching kills the client; the tmux session it was attached to
 * belongs to the runtime and survives untouched. That is what makes a terminal
 * outlive the window, and the app.
 *
 * Attaching resolves a live tmux session first, so it is not instantaneous, and
 * two attaches for the same view can be in flight at once. The in-flight ledger
 * below is the Rust's `AttachPermit`: a newer attach supersedes an older one
 * before either can publish, so a view can never be handed a receipt for a
 * client that has already been replaced. Publication itself is synchronous, so
 * once the ledger says an attach is current, nothing can interleave with it.
 */

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
	openPty,
	terminalEnvironment,
	type Pty,
	type PtyFactory,
} from "./pty.js";
import { CancellationToken, sameTarget, type TerminalTarget } from "./ports.js";

const MAX_IN_FLIGHT_FRAMES = 8;
const MAX_IN_FLIGHT_BYTES = MAX_OUTPUT_BUFFER_BYTES;
const FLOW_CONTROL_TIMEOUT_MS = 2_000;
/** Output already read from the PTY but not yet sendable, bounded like the window. */
const MAX_QUEUED_OUTPUT_BYTES = MAX_OUTPUT_BUFFER_BYTES;

/**
 * The view's end of one attachment.
 *
 * It answers whether the frame was delivered rather than throwing, because a
 * view that has gone away is not an error to report — it is the one condition
 * under which this side stops the PTY on its own, and it records that by
 * ending the attachment.
 */
export type FrameSink = (frame: TerminalFrame) => boolean;

export interface AttachContext {
	readonly surfaceKey: string;
	/** The mounted surface's identity: one page can hold several. */
	readonly viewLabel: string;
	/** The semantic terminal this attachment is a client of. */
	readonly target: TerminalTarget;
	/** The tmux client to run, resolved against an exact marked session. */
	readonly file: string;
	readonly args: readonly string[];
	/** The client's working directory: the launch home, never a workspace. */
	readonly cwd: string;
	readonly size: TerminalSize;
	readonly sink: FrameSink;
}

/**
 * A place in the in-flight ledger.
 *
 * Holding one is what makes an attach publishable. A newer attach for the same
 * view or the same target cancels this permit's token, so the provider work it
 * is waiting on stops and the publication is refused as stale.
 */
export interface AttachPermit {
	readonly cancel: CancellationToken;
	release(): void;
}

/** The identity every non-attach request must present. */
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

class Attachment {
	readonly flow = new FlowControl();
	private sequence = 0;
	private lastInputSequence = 0;
	private stopped = false;
	private readonly queue: Uint8Array[] = [];
	private queuedBytes = 0;
	private backpressureTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly resizer: ResizeCoalescer;
	private paused = false;

	constructor(
		readonly id: string,
		readonly surfaceKey: string,
		readonly viewLabel: string,
		readonly target: TerminalTarget,
		readonly targetGeneration: number,
		private readonly pty: Pty,
		private readonly sink: FrameSink,
		private readonly onFinished: (attachment: Attachment) => void,
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

	/** PTY output, split at the frame bound and metered by the ack window. */
	acceptOutput(bytes: Uint8Array): void {
		if (this.stopped) return;
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
		this.stopped = true;
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
		this.onFinished(this);
	}
}

export interface AttachmentManagerOptions {
	readonly spawn?: PtyFactory;
	readonly randomBytes: (count: number) => Uint8Array;
	readonly environment?: () => Record<string, string | undefined>;
}

interface InFlightAttach {
	readonly viewLabel: string;
	readonly target: TerminalTarget;
	readonly cancel: CancellationToken;
}

export class AttachmentManager {
	private readonly attachments = new Map<string, Attachment>();
	private readonly inFlight = new Map<number, InFlightAttach>();
	private nextAttachKey = 1;
	private readonly spawn: PtyFactory;
	private readonly randomBytes: (count: number) => Uint8Array;
	private readonly environment: () => Record<string, string | undefined>;
	private generation: number;

	constructor(options: AttachmentManagerOptions) {
		this.spawn = options.spawn ?? openPty;
		this.randomBytes = options.randomBytes;
		this.environment = options.environment ?? (() => terminalEnvironment());
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
	 * A view owns one mounted surface at a time, so an older attach for the
	 * same view — or for the same terminal — is superseded here, before either
	 * can publish. The superseded entry stays in the ledger until its permit is
	 * released, which is what gives its publisher a definitive stale answer
	 * instead of a timing-dependent lookup.
	 */
	beginAttach(
		target: TerminalTarget,
		viewLabel: string,
		cancel: CancellationToken,
	): AttachPermit {
		cancel.check();
		const key = this.nextAttachKey;
		this.nextAttachKey += 1;
		for (const inFlight of this.inFlight.values()) {
			if (
				inFlight.viewLabel === viewLabel ||
				sameTarget(inFlight.target, target)
			) {
				inFlight.cancel.cancel();
			}
		}
		const operation = cancel.child();
		this.inFlight.set(key, { viewLabel, target, cancel: operation });
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
	 * Publish one resolved client as this surface's attachment.
	 *
	 * Everything from here to the receipt is synchronous: the child is spawned,
	 * registered and given its Started frame without yielding, so no other
	 * attach can interleave with it.
	 */
	attach(permit: AttachPermit, context: AttachContext): TerminalAttachReceipt {
		if (!this.isCurrent(permit)) throw new TerminalFailure("stale_target");
		// One attachment per surface and one per mounted view. A replacement is
		// reaped before the new PTY exists, so the old child never outlives the
		// receipt that named it.
		for (const existing of [...this.attachments.values()]) {
			if (
				existing.surfaceKey === context.surfaceKey ||
				existing.viewLabel === context.viewLabel
			) {
				existing.stop("detached");
			}
		}
		const id = this.nextId();
		const targetGeneration = this.nextGeneration();
		let pty: Pty;
		try {
			pty = this.spawn({
				file: context.file,
				args: context.args,
				cwd: context.cwd,
				cols: context.size.cols,
				rows: context.size.rows,
				pixelWidth: context.size.pixelWidth,
				pixelHeight: context.size.pixelHeight,
				env: this.environment(),
			});
		} catch (failure: unknown) {
			// The view asked for a terminal and there is none. Tell it in the
			// same shape a later failure would take, then reject the request.
			context.sink({
				type: "error",
				schemaVersion: TERMINAL_PROTOCOL_VERSION,
				attachmentId: id,
				sequence: 0,
				error: new TerminalFailure("pty_unavailable").toWire(),
			});
			context.sink({
				type: "exited",
				schemaVersion: TERMINAL_PROTOCOL_VERSION,
				attachmentId: id,
				sequence: 1,
				reason: "childExited",
			});
			throw failure instanceof TerminalFailure
				? failure
				: new TerminalFailure("pty_unavailable", { cause: failure });
		}
		// Nothing may reach the view before its receipt's Started frame. The
		// PTY is held paused until Started is on the wire; this is the Rust
		// reader gate, expressed where the data actually comes from.
		pty.pause();
		const attachment = new Attachment(
			id,
			context.surfaceKey,
			context.viewLabel,
			context.target,
			targetGeneration,
			pty,
			context.sink,
			(finished) => {
				if (this.attachments.get(finished.id) === finished) {
					this.attachments.delete(finished.id);
				}
			},
		);
		pty.onData((bytes) => attachment.acceptOutput(bytes));
		pty.onExit(() => attachment.handleExit());
		this.attachments.set(id, attachment);
		attachment.sendStarted(context.size);
		pty.resume();
		return {
			schemaVersion: TERMINAL_PROTOCOL_VERSION,
			attachmentId: id,
			surfaceKey: context.surfaceKey,
			targetGeneration,
		};
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

	private owned(identity: RequestIdentity): Attachment {
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
