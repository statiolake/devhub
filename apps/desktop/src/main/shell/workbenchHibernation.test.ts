import { describe, expect, it, vi } from "vitest";
import { hibernate, type Hibernating } from "./workbenchHibernation.js";

/** A workbench away for `awayFor` checks, then shown again. */
function workbench(
	options: {
		awayFor?: number;
		reasons?: readonly string[] | Error;
		vetoed?: boolean;
	} = {},
) {
	let checks = 0;
	const calls: string[] = [];
	const fake = {
		calls,
		away: () => ++checks <= (options.awayFor ?? Infinity),
		keepAwake: vi.fn(() => {
			calls.push("keepAwake");
			const reasons = options.reasons ?? [];
			return reasons instanceof Error
				? Promise.reject(reasons)
				: Promise.resolve(reasons);
		}),
		unload: vi.fn(() => {
			calls.push("unload");
			return Promise.resolve(options.vetoed ?? false);
		}),
		sleep: vi.fn(() => {
			calls.push("sleep");
		}),
	} satisfies Hibernating & { calls: string[] };
	return fake;
}

describe("closing a workbench that has been away", () => {
	it("asks, unloads gracefully, then destroys it", async () => {
		const one = workbench();
		expect(await hibernate(one)).toBe(true);
		expect(one.calls).toEqual(["keepAwake", "unload", "sleep"]);
	});

	it("leaves one that is not away long enough alone", async () => {
		const one = workbench({ awayFor: 0 });
		expect(await hibernate(one)).toBe(false);
		expect(one.calls).toEqual([]);
	});

	it("keeps one up that would lose unsaved work, a terminal process or a debug session", async () => {
		const one = workbench({ reasons: ["main.ts", "terminal zsh"] });
		expect(await hibernate(one)).toBe(false);
		expect(one.calls).toEqual(["keepAwake"]);
	});

	it("keeps one up that does not answer", async () => {
		const one = workbench({ reasons: new Error("no reply") });
		expect(await hibernate(one)).toBe(false);
		expect(one.unload).not.toHaveBeenCalled();
	});

	it("keeps one up that came back while it was being asked", async () => {
		const one = workbench({ awayFor: 1 });
		expect(await hibernate(one)).toBe(false);
		expect(one.unload).not.toHaveBeenCalled();
	});

	it("keeps one up whose unload was vetoed", async () => {
		const one = workbench({ vetoed: true });
		expect(await hibernate(one)).toBe(false);
		expect(one.sleep).not.toHaveBeenCalled();
	});
});
