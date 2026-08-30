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

	it("leaves every other key alone, armed or not", () => {
		for (const key of [
			stroke("w", { command: true }),
			stroke("n", { command: true }),
			stroke("1", { command: true }),
			stroke("c", { command: true }),
			stroke("k", { control: true }),
			stroke("a"),
		]) {
			expect(router.route(key, 0)).toEqual({
				kind: "pass",
				clearedPrefix: false,
			});
		}
	});

	it("clears the prefix when the second key is something else", () => {
		router.route(commandQ, 0);
		expect(router.route(stroke("w", { command: true }), 10)).toEqual({
			kind: "pass",
			clearedPrefix: true,
		});
		expect(router.isArmed(10)).toBe(false);
		// And the Command-W that followed must not have become a quit.
		expect(router.route(commandQ, 20)).toEqual({
			kind: "armed",
			deadline: 20 + PREFIX_TIMEOUT_MS,
		});
	});

	it("is not armed by a Command-Q that carries other modifiers", () => {
		for (const key of [
			stroke("q", { command: true, shift: true }),
			stroke("q", { command: true, option: true }),
			stroke("q", { command: true, control: true }),
			stroke("q"),
		]) {
			expect(router.route(key, 0)).toEqual({
				kind: "pass",
				clearedPrefix: false,
			});
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
