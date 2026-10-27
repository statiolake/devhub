import { describe, expect, it, vi } from "vitest";
import {
	EditorTerminalExits,
	MAX_RESTARTS,
	RESTART_WINDOW_MS,
	SETTLE_POLL_MS,
	type WorkspaceCloseStanding,
} from "./editorTerminalExits.js";

const WS = "11111111-1111-4111-8111-111111111111";
const SCRATCH = "00000000-0000-4000-8000-00000000005c";

/** A close flow played by hand, with its timers run by the test. */
function harness(
	options: {
		readonly alive?: boolean;
		readonly sessionFails?: boolean;
	} = {},
) {
	const world = {
		standing: new Map<string, WorkspaceCloseStanding>([
			[WS, "open"],
			[SCRATCH, "open"],
		]),
		asking: false,
		now: 0,
	};
	const timers: (() => void)[] = [];
	const close = vi.fn<(id: string) => void>();
	const restart = vi.fn<(id: string) => void>();
	const exits = new EditorTerminalExits({
		standing: (id) => world.standing.get(id) ?? "gone",
		closable: (id) => id !== SCRATCH,
		asking: () => world.asking,
		sessionAlive: async () => {
			if (options.sessionFails) throw new Error("tmux did not answer");
			return options.alive ?? false;
		},
		close,
		restart,
		now: () => world.now,
		setTimer: (run, ms) => {
			expect(ms).toBe(SETTLE_POLL_MS);
			timers.push(run);
			return timers.length;
		},
		clearTimer: () => {
			timers.length = 0;
		},
	});
	/** Run the timers due now; how many ran. */
	const tick = () => {
		const due = timers.splice(0);
		for (const run of due) run();
		return due.length;
	};
	return { world, exits, close, restart, tick, timers };
}

describe("the editor area's shell exiting, in terminal mode", () => {
	it("is the close button: a Workspace with nothing to ask about closes, and no terminal is started", async () => {
		const { world, exits, close, restart, tick, timers } = harness();
		close.mockImplementation((id) => world.standing.set(id, "closing"));
		await exits.ended(WS);
		expect(close).toHaveBeenCalledWith(WS);
		tick();
		world.standing.delete(WS);
		tick();
		expect(restart).not.toHaveBeenCalled();
		expect(timers).toHaveLength(0);
	});

	it("starts the terminal over once the close's question is cancelled", async () => {
		const { world, exits, close, restart, tick } = harness();
		close.mockImplementation(() => {
			world.asking = true;
		});
		await exits.ended(WS);
		tick();
		tick();
		expect(restart).not.toHaveBeenCalled();
		// Cancelled: no question, nothing closing, the Workspace still there.
		world.asking = false;
		tick();
		expect(restart).not.toHaveBeenCalled();
		tick();
		expect(restart).toHaveBeenCalledWith(WS);
		expect(tick()).toBe(0);
	});

	it("waits through an answer that starts the close, and starts nothing for one that closes", async () => {
		const { world, exits, close, restart, tick } = harness();
		close.mockImplementation(() => {
			world.asking = true;
		});
		await exits.ended(WS);
		// Answered: the question goes, and the close it asked about runs.
		world.asking = false;
		world.standing.set(WS, "closing");
		tick();
		tick();
		world.standing.delete(WS);
		tick();
		expect(restart).not.toHaveBeenCalled();
	});

	it("starts the terminal over when the close leaves the Workspace open", async () => {
		const { world, exits, close, restart, tick } = harness();
		close.mockImplementation((id) => world.standing.set(id, "closing"));
		await exits.ended(WS);
		// The close failed part-way: the Workspace stays, with nothing running.
		world.standing.set(WS, "open");
		tick();
		tick();
		expect(restart).toHaveBeenCalledWith(WS);
	});

	it("never closes Scratch: its terminal is started over at once", async () => {
		const { exits, close, restart } = harness();
		await exits.ended(SCRATCH);
		expect(close).not.toHaveBeenCalled();
		expect(restart).toHaveBeenCalledWith(SCRATCH);
	});

	it("attaches again when the session is still there: the person detached, nothing exited", async () => {
		const { exits, close, restart } = harness({ alive: true });
		await exits.ended(WS);
		expect(close).not.toHaveBeenCalled();
		expect(restart).toHaveBeenCalledWith(WS);
	});

	it("does not close on a guess when the session cannot be read", async () => {
		const { exits, close, restart } = harness({ sessionFails: true });
		await exits.ended(WS);
		expect(close).not.toHaveBeenCalled();
		expect(restart).toHaveBeenCalledWith(WS);
	});

	it("does nothing for a Workspace that is closing or gone: that is DevHub's own teardown", async () => {
		const { world, exits, close, restart } = harness();
		world.standing.set(WS, "closing");
		await exits.ended(WS);
		await exits.ended("22222222-2222-4222-8222-222222222222");
		expect(close).not.toHaveBeenCalled();
		expect(restart).not.toHaveBeenCalled();
	});

	it("does nothing once DevHub is shutting down", async () => {
		const { exits, close, restart, timers } = harness();
		exits.dispose();
		await exits.ended(WS);
		await exits.ended(SCRATCH);
		expect(close).not.toHaveBeenCalled();
		expect(restart).not.toHaveBeenCalled();
		expect(timers).toHaveLength(0);
	});

	it("asks once while an exit is being decided", async () => {
		const { world, exits, close } = harness();
		close.mockImplementation(() => {
			world.asking = true;
		});
		await exits.ended(WS);
		await exits.ended(WS);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("stops starting over a terminal that keeps ending at once, rather than loop", async () => {
		const { world, exits, restart } = harness();
		for (let attempt = 0; attempt < MAX_RESTARTS + 2; attempt += 1)
			await exits.ended(SCRATCH);
		expect(restart).toHaveBeenCalledTimes(MAX_RESTARTS);
		world.now += RESTART_WINDOW_MS;
		await exits.ended(SCRATCH);
		expect(restart).toHaveBeenCalledTimes(MAX_RESTARTS + 1);
	});
});
