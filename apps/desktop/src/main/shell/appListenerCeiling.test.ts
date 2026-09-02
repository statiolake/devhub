import { describe, expect, it } from "vitest";
import {
	APPLICATION_WIDE_LISTENERS,
	LISTENERS_PER_WORKBENCH,
	NODE_DEFAULT_MAX_LISTENERS,
	appListenerCeiling,
} from "./appListenerCeiling.js";

describe("the listeners electron.app is accounted for", () => {
	it("grows with the workbenches, because the helpers do", () => {
		const one = appListenerCeiling(10);
		const two = appListenerCeiling(11);
		expect(two - one).toBe(LISTENERS_PER_WORKBENCH);
	});

	it("accounts for the startup that produced the warning", () => {
		// Four workbenches — a Scratch and three Workspaces — is the run whose
		// eleventh `child-process-gone` listener Node called a leak.
		expect(appListenerCeiling(4)).toBeGreaterThanOrEqual(11);
	});

	it("never tightens Node's own bar", () => {
		expect(appListenerCeiling(0)).toBe(NODE_DEFAULT_MAX_LISTENERS);
		expect(appListenerCeiling(1)).toBe(NODE_DEFAULT_MAX_LISTENERS);
	});

	it("still leaves a leak room to be reported", () => {
		// The point of a stated ceiling rather than `setMaxListeners(0)`: one
		// workbench that leaks its helpers must eventually cross it.
		const leaked = APPLICATION_WIDE_LISTENERS + LISTENERS_PER_WORKBENCH * 20;
		expect(leaked).toBeGreaterThan(appListenerCeiling(1));
	});
});
