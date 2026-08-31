import { beforeEach, describe, expect, it } from "vitest";
import { KeyRouter, PREFIX_TIMEOUT_MS, type KeyStroke } from "./keyRouter.js";

function stroke(key: string, overrides: Partial<KeyStroke> = {}): KeyStroke {
	return {
		key,
		command: false,
		shift: false,
		option: false,
		control: false,
		isAutoRepeat: false,
		...overrides,
	};
}

const commandQ = stroke("q", { command: true });

describe("the Command-Q chord", () => {
	let router: KeyRouter;

	beforeEach(() => {
		router = new KeyRouter();
	});

	it("swallows the first Command-Q and arms instead of quitting", () => {
		expect(router.route(commandQ, 0)).toEqual({
			kind: "armed",
			deadline: PREFIX_TIMEOUT_MS,
		});
		expect(router.isArmed(0)).toBe(true);
	});

	it("forwards the second Command-Q within the second", () => {
		router.route(commandQ, 0);
		expect(router.route(commandQ, PREFIX_TIMEOUT_MS)).toEqual({
			kind: "forward",
		});
	});

	it("arms again rather than forwarding after the second has passed", () => {
		router.route(commandQ, 0);
		expect(router.route(commandQ, PREFIX_TIMEOUT_MS + 1)).toEqual({
			kind: "armed",
			deadline: PREFIX_TIMEOUT_MS * 2 + 1,
		});
	});

	it("leaves every other key alone while nothing is armed", () => {
		for (const key of [
			stroke("w", { command: true }),
			stroke("n", { command: true }),
			stroke("1", { command: true }),
			stroke("c", { command: true }),
			stroke("k", { control: true }),
			stroke("a"),
			// The chord keys themselves: without the prefix they are ordinary.
			stroke("z"),
			stroke("3"),
			stroke("P", { shift: true }),
		]) {
			expect(router.route(key, 0)).toEqual({ kind: "pass" });
		}
	});

	it("is not armed by a Command-Q that carries other modifiers", () => {
		for (const key of [
			stroke("q", { command: true, shift: true }),
			stroke("q", { command: true, option: true }),
			stroke("q", { command: true, control: true }),
			stroke("q"),
		]) {
			expect(router.route(key, 0)).toEqual({ kind: "pass" });
		}
	});

	it("swallows a held Command-Q without ever arming or forwarding", () => {
		expect(router.route({ ...commandQ, isAutoRepeat: true }, 0)).toEqual({
			kind: "consume",
		});
		expect(router.isArmed(0)).toBe(false);
	});

	it("disarms when what is focused changes", () => {
		router.route(commandQ, 0);
		router.focusChanged();
		expect(router.isArmed(0)).toBe(false);
		expect(router.route(commandQ, 10)).toEqual({
			kind: "armed",
			deadline: 10 + PREFIX_TIMEOUT_MS,
		});
	});
});

describe("completing a chord", () => {
	let router: KeyRouter;

	function complete(second: KeyStroke) {
		router.route(commandQ, 0);
		return router.route(second, 10);
	}

	beforeEach(() => {
		router = new KeyRouter();
	});

	it("runs the workspace and agent cycles", () => {
		expect(complete(stroke("P", { shift: true }))).toEqual({
			kind: "run",
			action: { kind: "cycle-workspace", step: -1 },
		});
		expect(complete(stroke("N", { shift: true }))).toEqual({
			kind: "run",
			action: { kind: "cycle-workspace", step: 1 },
		});
		expect(complete(stroke("{", { shift: true }))).toEqual({
			kind: "run",
			action: { kind: "cycle-agent", step: -1 },
		});
		expect(complete(stroke("}", { shift: true }))).toEqual({
			kind: "run",
			action: { kind: "cycle-agent", step: 1 },
		});
	});

	it("toggles the workbench's terminal", () => {
		expect(complete(stroke("t"))).toEqual({
			kind: "run",
			action: { kind: "toggle-terminal" },
		});
	});

	it("runs the window commands", () => {
		expect(complete(stroke("C", { shift: true }))).toEqual({
			kind: "run",
			action: { kind: "add-workspace" },
		});
		expect(complete(stroke("<", { shift: true }))).toEqual({
			kind: "run",
			action: { kind: "open-settings" },
		});
	});

	it("cancels on a key the table has no row for", () => {
		// `Z` used to collapse the sidebar. The sidebar has one form now, so the
		// row is gone and the key falls through to the same cancellation any
		// other unbound key gets.
		expect(complete(stroke("z"))).toEqual({ kind: "cancelled" });
	});

	it("selects the Nth sidebar entry by its digit", () => {
		for (const ordinal of [1, 5, 9]) {
			expect(complete(stroke(String(ordinal)))).toEqual({
				kind: "run",
				action: { kind: "select-entry", ordinal },
			});
		}
	});

	it("distinguishes the shifted chord from the unshifted one", () => {
		// Modifiers are matched exactly, so retiring the unshifted `N` — it
		// stepped the activity ring, which no longer exists — leaves it
		// cancelling rather than falling through to its shifted neighbour.
		expect(complete(stroke("n"))).toEqual({ kind: "cancelled" });
		expect(complete(stroke("N", { shift: true }))).toEqual({
			kind: "run",
			action: { kind: "cycle-workspace", step: 1 },
		});
	});

	it("cancels on a key the table does not have, and forwards nothing", () => {
		expect(complete(stroke("w", { command: true }))).toEqual({
			kind: "cancelled",
		});
		expect(router.isArmed(10)).toBe(false);
		// And the Command-W that was swallowed must not have become a quit.
		expect(router.route(commandQ, 20)).toEqual({
			kind: "armed",
			deadline: 20 + PREFIX_TIMEOUT_MS,
		});
	});

	it("cancels on the pane and split keys DevHub deliberately does not bind", () => {
		for (const key of ["h", "j", "k", "l", "v", "s", "d", "0"]) {
			expect(complete(stroke(key))).toEqual({ kind: "cancelled" });
		}
	});

	it("is over once the second has passed", () => {
		router.route(commandQ, 0);
		expect(router.route(stroke("z"), PREFIX_TIMEOUT_MS + 1)).toEqual({
			kind: "pass",
		});
	});

	it("takes its table as data, so an override is another array", () => {
		const overridden = new KeyRouter([
			{ key: "s", action: { kind: "open-settings" } },
		]);
		overridden.route(commandQ, 0);
		expect(overridden.route(stroke("s"), 10)).toEqual({
			kind: "run",
			action: { kind: "open-settings" },
		});
		overridden.route(commandQ, 20);
		expect(overridden.route(stroke("z"), 30)).toEqual({ kind: "cancelled" });
	});
});
