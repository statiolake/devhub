/**
 * Agent Surface attachments.
 *
 * The channel is deliberately a view transport only. Agent identity and the
 * opaque provider control live in `HerdrAgentRuntime`; this manager owns the
 * short-lived view attachment, bounded framing, and detach lifecycle.
 *
 * Ported from `src-tauri/src/agent/channel.rs`. The Rust manager coordinated
 * several OS threads under mutexes; Node has one thread, so the maps need no
 * locks and the reader thread becomes a polling async loop. Everything that
 * existed *because* an attach can be invalidated while provider I/O is in
 * flight is kept exactly: the per-view lifecycle epoch, the reservation that a
 * close invalidates, the cancellation of an in-flight attach, and the bounded
 * shutdown that reports failure instead of hanging.
 */

import { randomBytes } from "node:crypto";

import {
	MAX_ATTACH_REQUEST_BYTES,
	MAX_OUTPUT_BUFFER_BYTES,
	MAX_OUTPUT_FRAME_BYTES,
	MAX_TARGET_GENERATION,
	TERMINAL_PROTOCOL_VERSION,
	TerminalError,
	TerminalErrorCode,
	agentIdFromSurfaceKey,
	encodeFrame,
	terminalError,
	validateAgentSurfaceKey,
	validateAttachmentId,
	validateInput,
	validateInputSequence,
	validatePtySize,
	validateSchema,
	type AckRequest,
	type AttachReceipt,
	type AttachRequest,
	type DetachRequest,
	type InputRequest,
	type ResizeRequest,
	type TerminalFrame,
} from "../../ipc/agent.js";
import { delay } from "./api.js";
import {
	CancellationToken,
	PortError,
	PortErrorCode,
	type AgentId,
	type AgentObservation,
} from "./ports.js";
import type { HerdrAgentRuntime } from "./runtime.js";
import type { AgentSurface } from "./surface.js";

const POLL_INTERVAL_MS = 40;
const MAX_ATTACHMENTS = 64;
/**
 * Output is acknowledged cumulatively by the view. Keep a bounded number of
 * frames and bytes in flight so a hidden or stalled view cannot turn a
 * provider control stream into an unbounded allocation in main.
 */
const MAX_OUTPUT_IN_FLIGHT_FRAMES = 64;
const MAX_OUTPUT_IN_FLIGHT_BYTES = MAX_OUTPUT_BUFFER_BYTES;

/** Where encoded frames go. The Electron adapter wraps `webContents.send`. */
export interface FrameSink {
	send(raw: Uint8Array): void;
}

/** Maps a `PortError` onto the view-facing terminal error, once. */
export function terminalErrorFromPort(error: unknown): TerminalError {
	if (error instanceof TerminalError) {
		return error;
	}
	if (!(error instanceof PortError)) {
		return terminalError(TerminalErrorCode.Internal);
	}
	switch (error.code) {
		case PortErrorCode.Unavailable:
			return terminalError(TerminalErrorCode.SurfaceUnavailable);
		case PortErrorCode.Conflict:
			return terminalError(TerminalErrorCode.AttachmentLimit);
		case PortErrorCode.TimedOut:
			return terminalError(TerminalErrorCode.TimedOut);
		case PortErrorCode.Cancelled:
			return terminalError(TerminalErrorCode.SurfaceUnavailable);
		case PortErrorCode.Incompatible:
			return terminalError(TerminalErrorCode.RuntimeUnavailable);
		case PortErrorCode.Failed:
			return terminalError(TerminalErrorCode.RuntimeUnavailable);
	}
}

class OutputFlow {
	acknowledgedSequence = 0;
	lastSentSequence = 0;
	inFlightBytes = 0;
	readonly inFlight = new Map<number, number>();

	canRead(): boolean {
		return (
			this.inFlight.size < MAX_OUTPUT_IN_FLIGHT_FRAMES &&
			this.inFlightBytes < MAX_OUTPUT_IN_FLIGHT_BYTES
		);
	}

	reserve(sequence: number, bytes: number): void {
		if (
			bytes === 0 ||
			bytes > MAX_OUTPUT_FRAME_BYTES ||
			sequence !== this.lastSentSequence + 1 ||
			this.inFlight.size >= MAX_OUTPUT_IN_FLIGHT_FRAMES ||
			this.inFlightBytes + bytes > MAX_OUTPUT_IN_FLIGHT_BYTES
		) {
			throw terminalError(TerminalErrorCode.Backpressure);
		}
		this.lastSentSequence = sequence;
		this.inFlight.set(sequence, bytes);
		this.inFlightBytes += bytes;
	}

	acknowledge(sequence: number): void {
		if (sequence > this.lastSentSequence) {
			throw terminalError(TerminalErrorCode.InvalidRequest);
		}
		if (sequence <= this.acknowledgedSequence) {
			return;
		}
		for (const [sent, bytes] of [...this.inFlight]) {
			if (sent <= sequence) {
				this.inFlight.delete(sent);
				this.inFlightBytes -= bytes;
			}
		}
		this.acknowledgedSequence = sequence;
	}
}

interface AgentAttachment {
	readonly surfaceKey: string;
	readonly viewLabel: string;
	readonly targetGeneration: number;
	readonly lifecycleEpoch: number;
	readonly surface: AgentSurface;
	stopped: boolean;
	lastInputSequence: number;
	readonly output: OutputFlow;
}

interface ActiveAttach {
	readonly viewLabel: string;
	readonly lifecycleEpoch: number;
	readonly cancellation: CancellationToken;
	readonly finished: Promise<void>;
}

export class AgentSurfaceManager {
	readonly #attachments = new Map<string, AgentAttachment>();
	readonly #readers = new Map<string, Promise<void>>();
	readonly #viewEpochs = new Map<string, number>();
	/**
	 * A reservation prevents a provider attach in flight from publishing after
	 * a close or replacement invalidated its view.
	 */
	readonly #attachReservations = new Map<string, number>();
	/**
	 * Every provider attach has an owned in-flight record until its result is
	 * consumed or the quit path has awaited it. Without this, a cancelled
	 * reservation could leave provider I/O running with no owner.
	 */
	readonly #attachOperations = new Map<number, ActiveAttach>();
	#nextId = 1;
	#nextAttachOperation = 1;
	#nextGenerationCounter = 1;

	async attach(
		runtime: HerdrAgentRuntime,
		viewLabel: string,
		request: AttachRequest,
		sink: FrameSink,
		onFailure: (agentId: AgentId) => void,
	): Promise<[AttachReceipt, AgentObservation]> {
		validateAttachRequest(request);
		const agentId = agentIdFromSurfaceKey(request.surfaceKey);

		// Reserve this view and release the prior attachment first. The Herdr
		// attach below is provider I/O: a close or reopen can invalidate this
		// reservation while the provider is slow or unavailable, and the
		// result must then be discarded rather than published.
		await this.detachView(viewLabel);
		const lifecycleEpoch = this.#reserveView(viewLabel);
		let surface: AgentSurface;
		let observation: AgentObservation;
		try {
			[surface, observation] = await this.#runAttachOperation(
				runtime,
				agentId,
				request.surfaceKey,
				true,
				viewLabel,
				lifecycleEpoch,
			);
		} catch (error) {
			this.#clearReservation(viewLabel, lifecycleEpoch);
			throw terminalErrorFromPort(error);
		}
		if (!this.#reservationIsCurrent(viewLabel, lifecycleEpoch)) {
			surface.detach();
			throw terminalError(TerminalErrorCode.SurfaceUnavailable);
		}
		let attachmentId: string;
		let targetGeneration: number;
		try {
			attachmentId = this.#nextAttachmentId();
			targetGeneration = this.#nextGeneration();
		} catch (error) {
			this.#clearReservation(viewLabel, lifecycleEpoch);
			surface.detach();
			throw error;
		}
		if (this.#attachReservations.get(viewLabel) !== lifecycleEpoch) {
			surface.detach();
			throw terminalError(TerminalErrorCode.SurfaceUnavailable);
		}
		if (this.#attachments.size >= MAX_ATTACHMENTS) {
			this.#attachReservations.delete(viewLabel);
			surface.detach();
			throw terminalError(TerminalErrorCode.AttachmentLimit);
		}
		const attachment: AgentAttachment = {
			surfaceKey: request.surfaceKey,
			viewLabel,
			targetGeneration,
			lifecycleEpoch,
			surface,
			stopped: false,
			lastInputSequence: 0,
			output: new OutputFlow(),
		};
		this.#attachments.set(attachmentId, attachment);
		// The handshake could only announce a default grid, because the socket
		// is opened before there is an attachment. Say the real one now, before
		// the first frame is read, so the agent's first paint is the right size
		// rather than an 80x24 one that reflows a moment later.
		attachment.surface.resize(request.cols, request.rows);

		const receipt: AttachReceipt = {
			schemaVersion: TERMINAL_PROTOCOL_VERSION,
			attachmentId,
			surfaceKey: request.surfaceKey,
			targetGeneration,
		};
		const started: TerminalFrame = {
			type: "started",
			schemaVersion: TERMINAL_PROTOCOL_VERSION,
			attachmentId,
			sequence: 0,
			surfaceKey: request.surfaceKey,
			targetGeneration,
			cols: request.cols,
			rows: request.rows,
		};
		try {
			sink.send(encodeFrame(started));
		} catch {
			this.#clearReservation(viewLabel, lifecycleEpoch);
			this.#detachExact(viewLabel, receipt);
			throw terminalError(TerminalErrorCode.ChannelClosed);
		}

		this.#readers.set(
			attachmentId,
			this.#readSurface(attachmentId, attachment, sink, onFailure),
		);
		if (!this.#reservationIsCurrent(viewLabel, lifecycleEpoch)) {
			this.#detachExact(viewLabel, receipt);
			throw terminalError(TerminalErrorCode.SurfaceUnavailable);
		}
		this.#clearReservation(viewLabel, lifecycleEpoch);
		return [receipt, observation];
	}

	async #runAttachOperation(
		runtime: HerdrAgentRuntime,
		agentId: AgentId,
		surfaceKey: string,
		takeover: boolean,
		viewLabel: string,
		lifecycleEpoch: number,
	): Promise<[AgentSurface, AgentObservation]> {
		const operationKey = this.#nextAttachOperation;
		this.#nextAttachOperation += 1;
		const cancellation = new CancellationToken(this.#nextOperationId());
		let settle: () => void = () => {};
		const finished = new Promise<void>((resolve) => {
			settle = resolve;
		});
		this.#attachOperations.set(operationKey, {
			viewLabel,
			lifecycleEpoch,
			cancellation,
			finished,
		});
		const work = runtime
			.attachSurfaceWithObservation(agentId, surfaceKey, takeover, cancellation)
			.finally(settle);
		// The reservation can be cancelled while the provider is still working.
		// Racing the poll below lets the caller give up without abandoning the
		// operation record: `detachAllUntil` can still await this exact worker.
		let result: [AgentSurface, AgentObservation] | undefined;
		let failure: unknown;
		const guarded = work.then(
			(value) => {
				result = value;
			},
			(error) => {
				failure = error;
			},
		);
		for (;;) {
			const settled = await Promise.race([
				guarded.then(() => true),
				delay(POLL_INTERVAL_MS).then(() => false),
			]);
			if (settled) {
				this.#attachOperations.delete(operationKey);
				if (result !== undefined) {
					return result;
				}
				throw failure;
			}
			if (!this.#reservationIsCurrent(viewLabel, lifecycleEpoch)) {
				// The owner has cancelled this reservation. The operation stays
				// in the map so `detachAllUntil` can await or boundedly abandon
				// its provider work, and a surface that arrives late is
				// detached rather than leaked.
				cancellation.cancel();
				void work.then(
					([surface]) => surface.detach(),
					() => undefined,
				);
				throw terminalError(TerminalErrorCode.SurfaceUnavailable);
			}
		}
	}

	async input(viewLabel: string, request: InputRequest): Promise<void> {
		validateSchema(request.schemaVersion);
		validateAgentSurfaceKey(request.surfaceKey);
		validateAttachmentId(request.attachmentId);
		validateInputSequence(request.inputSequence);
		validateInput(request.bytes);
		const attachment = this.#owned(
			request.attachmentId,
			viewLabel,
			request.surfaceKey,
			request.targetGeneration,
		);
		if (request.inputSequence !== attachment.lastInputSequence + 1) {
			throw terminalError(TerminalErrorCode.InvalidRequest);
		}
		attachment.lastInputSequence = request.inputSequence;
		const text = Buffer.from(request.bytes).toString("utf8");
		// A lossy decode would silently change what the agent receives.
		if (!Buffer.from(text, "utf8").equals(Buffer.from(request.bytes))) {
			throw terminalError(TerminalErrorCode.InvalidRequest);
		}
		try {
			await attachment.surface.sendText(text);
		} catch (error) {
			throw terminalErrorFromPort(error);
		}
	}

	async resize(viewLabel: string, request: ResizeRequest): Promise<void> {
		validateSchema(request.schemaVersion);
		validateAgentSurfaceKey(request.surfaceKey);
		validateAttachmentId(request.attachmentId);
		validatePtySize(request);
		const attachment = this.#owned(
			request.attachmentId,
			viewLabel,
			request.surfaceKey,
			request.targetGeneration,
		);
		// Herdr's control stream is a terminal, and an agent's TUI is laid out
		// to the size its client reports. A surface that never reports one is
		// drawn at the 80x24 the handshake announced, whatever size it is.
		try {
			attachment.surface.resize(request.cols, request.rows);
		} catch (error) {
			throw terminalErrorFromPort(error);
		}
	}

	acknowledge(viewLabel: string, request: AckRequest): void {
		validateSchema(request.schemaVersion);
		validateAgentSurfaceKey(request.surfaceKey);
		validateAttachmentId(request.attachmentId);
		validateInputSequence(request.sequence);
		const attachment = this.#owned(
			request.attachmentId,
			viewLabel,
			request.surfaceKey,
			request.targetGeneration,
		);
		attachment.output.acknowledge(request.sequence);
	}

	detach(viewLabel: string, request: DetachRequest): void {
		validateSchema(request.schemaVersion);
		validateAgentSurfaceKey(request.surfaceKey);
		validateAttachmentId(request.attachmentId);
		if (
			request.targetGeneration === 0 ||
			request.targetGeneration > MAX_TARGET_GENERATION
		) {
			throw terminalError(TerminalErrorCode.WrongAttachment);
		}
		this.#detachExact(viewLabel, request);
	}

	/** Releases every attachment a view owns, and cancels its in-flight attach. */
	async detachView(viewLabel: string): Promise<void> {
		this.#attachReservations.delete(viewLabel);
		this.#cancelAttachOperations(viewLabel, undefined);
		for (const [id, attachment] of [...this.#attachments]) {
			if (attachment.viewLabel === viewLabel) {
				this.#attachments.delete(id);
				attachment.stopped = true;
				attachment.surface.detach();
			}
		}
		await this.#reapFinishedReaders();
	}

	async detachAll(): Promise<boolean> {
		return this.detachAllUntil(Date.now() + 5_000);
	}

	/**
	 * Detaches every Agent Surface and reaps its reader before the caller's
	 * lifecycle deadline. Provider Agents remain untouched; a reader that
	 * misses the deadline is abandoned and reported, never silently awaited.
	 */
	async detachAllUntil(deadline: number): Promise<boolean> {
		this.#attachReservations.clear();
		const operations = [...this.#attachOperations.values()];
		this.#attachOperations.clear();
		for (const operation of operations) {
			operation.cancellation.cancel();
		}
		const attachments = [...this.#attachments.values()];
		this.#attachments.clear();
		const readers = [...this.#readers.values()];
		this.#readers.clear();
		for (const attachment of attachments) {
			attachment.stopped = true;
			attachment.surface.detach();
		}
		const pending = [
			...operations.map((operation) => operation.finished),
			...readers,
		];
		const results = await Promise.all(
			pending.map((promise) => awaitUntil(promise, deadline)),
		);
		return results.every((stopped) => stopped);
	}

	#reserveView(viewLabel: string): number {
		const epoch = (this.#viewEpochs.get(viewLabel) ?? 0) + 1;
		if (!Number.isSafeInteger(epoch)) {
			throw terminalError(TerminalErrorCode.RuntimeUnavailable);
		}
		this.#viewEpochs.set(viewLabel, epoch);
		this.#attachReservations.set(viewLabel, epoch);
		return epoch;
	}

	#reservationIsCurrent(viewLabel: string, epoch: number): boolean {
		return this.#attachReservations.get(viewLabel) === epoch;
	}

	#clearReservation(viewLabel: string, epoch: number): void {
		if (this.#attachReservations.get(viewLabel) === epoch) {
			this.#attachReservations.delete(viewLabel);
		}
		this.#cancelAttachOperations(viewLabel, epoch);
	}

	#cancelAttachOperations(viewLabel: string, epoch: number | undefined): void {
		for (const operation of this.#attachOperations.values()) {
			if (
				operation.viewLabel === viewLabel &&
				(epoch === undefined || operation.lifecycleEpoch === epoch)
			) {
				operation.cancellation.cancel();
			}
		}
	}

	async #reapFinishedReaders(): Promise<void> {
		for (const [id, reader] of [...this.#readers]) {
			if (!this.#attachments.has(id)) {
				this.#readers.delete(id);
				await awaitUntil(reader, Date.now() + POLL_INTERVAL_MS * 2);
			}
		}
	}

	#detachExact(viewLabel: string, request: DetachRequest): void {
		const existing = this.#attachments.get(request.attachmentId);
		if (existing === undefined) {
			return;
		}
		if (
			existing.viewLabel !== viewLabel ||
			existing.surfaceKey !== request.surfaceKey ||
			existing.targetGeneration !== request.targetGeneration
		) {
			throw terminalError(TerminalErrorCode.WrongAttachment);
		}
		this.#attachments.delete(request.attachmentId);
		existing.stopped = true;
		existing.surface.detach();
	}

	detachReceipt(viewLabel: string, receipt: AttachReceipt): void {
		this.#detachExact(viewLabel, receipt);
	}

	#owned(
		attachmentId: string,
		viewLabel: string,
		surfaceKey: string,
		targetGeneration: number,
	): AgentAttachment {
		if (
			targetGeneration === 0 ||
			targetGeneration > MAX_TARGET_GENERATION ||
			!Number.isInteger(targetGeneration)
		) {
			throw terminalError(TerminalErrorCode.WrongAttachment);
		}
		const attachment = this.#attachments.get(attachmentId);
		if (
			attachment === undefined ||
			attachment.viewLabel !== viewLabel ||
			attachment.surfaceKey !== surfaceKey ||
			attachment.targetGeneration !== targetGeneration
		) {
			throw terminalError(TerminalErrorCode.WrongAttachment);
		}
		return attachment;
	}

	#current(
		attachmentId: string,
		surfaceKey: string,
		targetGeneration: number,
	): AgentAttachment | undefined {
		const attachment = this.#attachments.get(attachmentId);
		if (
			attachment === undefined ||
			attachment.surfaceKey !== surfaceKey ||
			attachment.targetGeneration !== targetGeneration
		) {
			return undefined;
		}
		return attachment;
	}

	#removeIfCurrent(
		attachmentId: string,
		surfaceKey: string,
		targetGeneration: number,
		lifecycleEpoch: number,
	): void {
		const attachment = this.#attachments.get(attachmentId);
		if (
			attachment === undefined ||
			attachment.surfaceKey !== surfaceKey ||
			attachment.targetGeneration !== targetGeneration ||
			attachment.lifecycleEpoch !== lifecycleEpoch
		) {
			return;
		}
		this.#attachments.delete(attachmentId);
		attachment.stopped = true;
		attachment.surface.detach();
	}

	#nextAttachmentId(): string {
		const bytes = randomBytes(16);
		bytes[0] ^= this.#nextId & 0xff;
		this.#nextId += 1;
		return bytes.toString("hex");
	}

	#nextOperationId(): string {
		const counter = this.#nextId;
		this.#nextId += 1;
		if (counter > 0x0000_ffff_ffff) {
			throw terminalError(TerminalErrorCode.RuntimeUnavailable);
		}
		return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
	}

	#nextGeneration(): number {
		for (;;) {
			const generation = this.#nextGenerationCounter;
			this.#nextGenerationCounter += 1;
			if (generation === 0 || generation > MAX_TARGET_GENERATION) {
				throw terminalError(TerminalErrorCode.RuntimeUnavailable);
			}
			const used = [...this.#attachments.values()].some(
				(attachment) => attachment.targetGeneration === generation,
			);
			if (!used) {
				return generation;
			}
		}
	}

	async #readSurface(
		attachmentId: string,
		attachment: AgentAttachment,
		sink: FrameSink,
		onFailure: (agentId: AgentId) => void,
	): Promise<void> {
		const { surfaceKey, targetGeneration, lifecycleEpoch, surface } =
			attachment;
		let pending: Uint8Array = new Uint8Array(0);
		let pendingOffset = 0;
		let sequence = 0;
		while (!attachment.stopped) {
			if (pendingOffset === pending.length) {
				pending = new Uint8Array(0);
				pendingOffset = 0;
				const current = this.#current(
					attachmentId,
					surfaceKey,
					targetGeneration,
				);
				if (current === undefined || !current.output.canRead()) {
					await delay(POLL_INTERVAL_MS);
					continue;
				}
				try {
					pending = await surface.readRecent();
				} catch (error) {
					if (!attachment.stopped) {
						// A control-stream read failure is not evidence that the
						// Agent exited. Reconcile its visible runtime health
						// separately; only provider reconciliation may remove
						// an Agent.
						onFailure(surface.agentId);
						sequence += 1;
						try {
							sink.send(
								encodeFrame({
									type: "error",
									schemaVersion: TERMINAL_PROTOCOL_VERSION,
									attachmentId,
									sequence,
									error: terminalErrorFromPort(error).body,
								}),
							);
						} catch {
							// The view is already gone; the attachment below is
							// released either way.
						}
					}
					attachment.stopped = true;
					break;
				}
			}
			while (pendingOffset < pending.length) {
				const end = Math.min(
					pendingOffset + MAX_OUTPUT_FRAME_BYTES,
					pending.length,
				);
				const chunk = pending.subarray(pendingOffset, end);
				sequence += 1;
				const current = this.#current(
					attachmentId,
					surfaceKey,
					targetGeneration,
				);
				let reserved = false;
				if (current !== undefined) {
					try {
						current.output.reserve(sequence, chunk.length);
						reserved = true;
					} catch {
						reserved = false;
					}
				}
				if (!reserved) {
					sequence -= 1;
					break;
				}
				try {
					sink.send(
						encodeFrame({
							type: "output",
							schemaVersion: TERMINAL_PROTOCOL_VERSION,
							attachmentId,
							sequence,
							bytes: chunk,
						}),
					);
				} catch {
					attachment.stopped = true;
					break;
				}
				pendingOffset = end;
			}
			await delay(POLL_INTERVAL_MS);
		}
		this.#removeIfCurrent(
			attachmentId,
			surfaceKey,
			targetGeneration,
			lifecycleEpoch,
		);
	}
}

function validateAttachRequest(request: AttachRequest): void {
	validateSchema(request.schemaVersion);
	validateAgentSurfaceKey(request.surfaceKey);
	if (request.targetGeneration !== 0) {
		throw terminalError(TerminalErrorCode.InvalidRequest);
	}
	validatePtySize(request);
	if (Buffer.byteLength(request.surfaceKey) + 64 > MAX_ATTACH_REQUEST_BYTES) {
		throw terminalError(TerminalErrorCode.InvalidRequest);
	}
}

/** Awaits a promise until an absolute deadline. Never rejects. */
async function awaitUntil(
	promise: Promise<unknown>,
	deadline: number,
): Promise<boolean> {
	let settled = false;
	const guarded = promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	while (!settled && Date.now() < deadline) {
		await Promise.race([guarded, delay(5)]);
	}
	return settled;
}

export { OutputFlow as OutputFlowForTests };
