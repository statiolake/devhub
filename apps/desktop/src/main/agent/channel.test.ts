/** Ported from the `channel.rs` test module of the Tauri agent adapter. */

import { describe, expect, it, vi } from "vitest";

import {
	MAX_INPUT_SEQUENCE,
	MAX_OUTPUT_BUFFER_BYTES,
	TERMINAL_PROTOCOL_VERSION,
	TerminalErrorCode,
	decodeFrame,
	validateAgentSurfaceKey,
	validateInputSequence,
	type AttachRequest,
} from "../../ipc/agent.js";
import {
	AgentSurfaceManager,
	OutputFlowForTests,
	terminalErrorFromPort,
	type FrameSink,
} from "./channel.js";
import { delay } from "./api.js";
import { CancellationToken, gonePort, unavailablePort } from "./ports.js";
import type { HerdrAgentRuntime } from "./runtime.js";
import type { AgentSurface } from "./surface.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const SURFACE_KEY = `agent:${AGENT_ID}`;
const MAX_OUTPUT_IN_FLIGHT_FRAMES = 64;

function attachRequest(): AttachRequest {
	return {
		schemaVersion: TERMINAL_PROTOCOL_VERSION,
		surfaceKey: SURFACE_KEY,
		targetGeneration: 0,
		cols: 80,
		rows: 24,
		pixelWidth: 0,
		pixelHeight: 0,
	};
}

function collectingSink(): FrameSink & { frames: Uint8Array[] } {
	const frames: Uint8Array[] = [];
	return {
		frames,
		send(raw) {
			frames.push(raw);
		},
	};
}

/** A surface whose provider reads are scripted, with detach observable. */
function fakeSurface(
	chunks: Buffer[],
): AgentSurface & { detached: boolean; resizes: [number, number][] } {
	const queue = [...chunks];
	const surface = {
		agentId: AGENT_ID,
		surfaceKey: SURFACE_KEY,
		detached: false,
		resizes: [] as [number, number][],
		async sendText() {},
		resize(cols: number, rows: number) {
			surface.resizes.push([cols, rows]);
		},
		async readRecent() {
			return queue.shift() ?? Buffer.alloc(0);
		},
		detach() {
			surface.detached = true;
		},
	};
	return surface as unknown as AgentSurface & {
		detached: boolean;
		resizes: [number, number][];
	};
}

function fakeRuntime(
	attach: (
		agentId: string,
		surfaceKey: string,
		takeover: boolean,
		cancel: CancellationToken,
	) => Promise<[AgentSurface, unknown]>,
): HerdrAgentRuntime {
	return {
		attachSurfaceWithObservation: attach,
	} as unknown as HerdrAgentRuntime;
}

describe("the agent surface key", () => {
	it("is semantic and provider-free", () => {
		expect(() => validateAgentSurfaceKey(`agent:${AGENT_ID}`)).not.toThrow();
		expect(() => validateAgentSurfaceKey("agent:/herdr-pane")).toThrow();
		expect(() =>
			validateAgentSurfaceKey(`workspace-terminal:${AGENT_ID}`),
		).toThrow();
	});

	it("validates the input sequence before any provider control", () => {
		expect(() => validateInputSequence(MAX_INPUT_SEQUENCE + 1)).toThrow();
		expect(() => validateInputSequence(0)).toThrow();
		expect(() => validateInputSequence(1)).not.toThrow();
	});
});

describe("the output flow", () => {
	it("is bounded, and cumulative acknowledgements release bytes", () => {
		const flow = new OutputFlowForTests();
		const frameBytes = MAX_OUTPUT_BUFFER_BYTES / MAX_OUTPUT_IN_FLIGHT_FRAMES;
		for (
			let sequence = 1;
			sequence <= MAX_OUTPUT_IN_FLIGHT_FRAMES;
			sequence += 1
		) {
			flow.reserve(sequence, frameBytes);
		}
		expect(flow.canRead()).toBe(false);
		expect(() => flow.reserve(65, 1)).toThrow();
		flow.acknowledge(32);
		expect(flow.canRead()).toBe(true);
		flow.reserve(65, 1);
		expect(() => flow.acknowledge(66)).toThrow();
		expect(() => flow.reserve(67, 1)).toThrow();
	});

	it("never decodes or diffs control-stream bytes", () => {
		const flow = new OutputFlowForTests();
		const first = Uint8Array.from([0, 0xff, 0x1b, 0x5b, 0x32, 0x4a]);
		const second = Uint8Array.from([0, 0xff, 0x1b, 0x5b, 0x32, 0x4a]);
		flow.reserve(1, first.length);
		flow.acknowledge(1);
		flow.reserve(2, second.length);
		expect(flow.lastSentSequence).toBe(2);
	});
});

describe("the agent surface manager", () => {
	it("publishes a started frame and streams bounded output", async () => {
		const surface = fakeSurface([Buffer.from("herdr-harness\n")]);
		const manager = new AgentSurfaceManager();
		const sink = collectingSink();
		const [receipt] = await manager.attach(
			fakeRuntime(async () => [surface, { agentId: AGENT_ID }]),
			"view",
			attachRequest(),
			sink,
			() => undefined,
		);
		expect(receipt.surfaceKey).toBe(SURFACE_KEY);
		expect(receipt.attachmentId).toMatch(/^[0-9a-f]{32}$/);
		expect(receipt.targetGeneration).toBe(1);

		await delay(120);
		const frames = sink.frames.map((raw) => decodeFrame(raw));
		expect(frames[0].type).toBe("started");
		const output = frames.find((frame) => frame.type === "output");
		expect(output).toBeDefined();
		if (output?.type === "output") {
			expect(Buffer.from(output.bytes).toString("utf8")).toBe(
				"herdr-harness\n",
			);
			manager.acknowledge("view", {
				schemaVersion: TERMINAL_PROTOCOL_VERSION,
				surfaceKey: SURFACE_KEY,
				attachmentId: receipt.attachmentId,
				targetGeneration: receipt.targetGeneration,
				sequence: output.sequence,
			});
		}
		manager.detach("view", {
			schemaVersion: TERMINAL_PROTOCOL_VERSION,
			surfaceKey: SURFACE_KEY,
			attachmentId: receipt.attachmentId,
			targetGeneration: receipt.targetGeneration,
		});
		expect(surface.detached).toBe(true);
		expect(await manager.detachAllUntil(Date.now() + 1_000)).toBe(true);
	});

	it("tells the provider what size the surface is, on attach and on resize", async () => {
		// An agent's TUI is laid out to the size its client reports. Before the
		// attachment exists the handshake can only announce a default, so the
		// real grid has to arrive before the first frame is read — otherwise the
		// first paint is an 80x24 one in a much larger pane.
		const surface = fakeSurface([]);
		const manager = new AgentSurfaceManager();
		const [receipt] = await manager.attach(
			fakeRuntime(async () => [surface, { agentId: AGENT_ID }]),
			"view",
			{ ...attachRequest(), cols: 203, rows: 61 },
			collectingSink(),
			() => undefined,
		);
		expect(surface.resizes).toEqual([[203, 61]]);
		await manager.resize("view", {
			schemaVersion: TERMINAL_PROTOCOL_VERSION,
			surfaceKey: SURFACE_KEY,
			attachmentId: receipt.attachmentId,
			targetGeneration: receipt.targetGeneration,
			cols: 120,
			rows: 40,
			pixelWidth: 0,
			pixelHeight: 0,
		});
		expect(surface.resizes).toEqual([
			[203, 61],
			[120, 40],
		]);
	});

	it("refuses input that skips a sequence and refuses a foreign attachment", async () => {
		const surface = fakeSurface([]);
		const sendText = vi.fn(async () => undefined);
		(surface as unknown as { sendText: unknown }).sendText = sendText;
		const manager = new AgentSurfaceManager();
		const [receipt] = await manager.attach(
			fakeRuntime(async () => [surface, { agentId: AGENT_ID }]),
			"view",
			attachRequest(),
			collectingSink(),
			() => undefined,
		);
		const base = {
			schemaVersion: TERMINAL_PROTOCOL_VERSION,
			surfaceKey: SURFACE_KEY,
			attachmentId: receipt.attachmentId,
			targetGeneration: receipt.targetGeneration,
		};
		await manager.input("view", { ...base, inputSequence: 1, bytes: [65] });
		await expect(
			manager.input("view", { ...base, inputSequence: 3, bytes: [66] }),
		).rejects.toMatchObject({ code: TerminalErrorCode.InvalidRequest });
		await expect(
			manager.input("other-view", { ...base, inputSequence: 2, bytes: [66] }),
		).rejects.toMatchObject({ code: TerminalErrorCode.WrongAttachment });
		expect(sendText).toHaveBeenCalledTimes(1);
		await manager.detachAllUntil(Date.now() + 1_000);
	});

	it("cancels and bounds an attach still in flight when the view closes", async () => {
		const manager = new AgentSurfaceManager();
		const surface = fakeSurface([]);
		let observed: CancellationToken | undefined;
		const runtime = fakeRuntime(async (_id, _key, _takeover, cancel) => {
			observed = cancel;
			await delay(400);
			return [surface, { agentId: AGENT_ID }];
		});
		// The rejection is captured as it happens: the assertion below runs
		// after the close, and an unobserved rejection in between would be
		// reported as an unhandled error rather than as this test's subject.
		const attaching = manager
			.attach(
				runtime,
				"view",
				attachRequest(),
				collectingSink(),
				() => undefined,
			)
			.then(
				() => undefined,
				(failure: unknown) => failure,
			);
		// The close invalidates the reservation while the provider is working.
		await delay(60);
		const stopped = await manager.detachAllUntil(Date.now() + 1_000);
		expect(await attaching).toMatchObject({
			code: TerminalErrorCode.SurfaceUnavailable,
		});
		expect(observed?.isCancelled).toBe(true);
		expect(stopped).toBe(true);
		// A surface that arrived after the cancellation is released, never leaked.
		await delay(450);
		expect(surface.detached).toBe(true);
	});

	it("reports a provider attach failure to the caller as a terminal error", async () => {
		const manager = new AgentSurfaceManager();
		await expect(
			manager.attach(
				fakeRuntime(async () => {
					throw unavailablePort();
				}),
				"view",
				attachRequest(),
				collectingSink(),
				() => undefined,
			),
		).rejects.toMatchObject({ code: TerminalErrorCode.SurfaceUnavailable });
	});

	it("reports a control-stream read failure without removing the agent", async () => {
		const manager = new AgentSurfaceManager();
		const surface = fakeSurface([]);
		(surface as unknown as { readRecent: unknown }).readRecent = async () => {
			throw unavailablePort();
		};
		const sink = collectingSink();
		const onFailure = vi.fn();
		await manager.attach(
			fakeRuntime(async () => [surface, { agentId: AGENT_ID }]),
			"view",
			attachRequest(),
			sink,
			onFailure,
		);
		await delay(120);
		expect(onFailure).toHaveBeenCalledWith(AGENT_ID);
		const error = sink.frames
			.map((raw) => decodeFrame(raw))
			.find((frame) => frame.type === "error");
		expect(error?.type).toBe("error");
		await manager.detachAllUntil(Date.now() + 1_000);
	});

	it("tells an ended agent apart from a surface that would not connect", () => {
		// The two look identical to a person unless they are named apart: one
		// is worth retrying, the other has nothing left to retry against.
		expect(terminalErrorFromPort(gonePort()).code).toBe(
			TerminalErrorCode.SessionUnavailable,
		);
		expect(terminalErrorFromPort(unavailablePort()).code).toBe(
			TerminalErrorCode.SurfaceUnavailable,
		);
	});
});
