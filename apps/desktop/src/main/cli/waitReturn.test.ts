import { describe, expect, it } from "vitest";
import { agentId, workspaceId } from "../../model/domain.js";
import type { NavigationSelection } from "../../model/appModel.js";
import { WaitSelectionReturns } from "./waitReturn.js";

const A: NavigationSelection = {
	context: {
		kind: "workspace",
		workspaceId: workspaceId("11111111-1111-4111-8111-111111111111"),
	},
	presentation: "full",
};
const B: NavigationSelection = {
	context: {
		kind: "workspace",
		workspaceId: workspaceId("22222222-2222-4222-8222-222222222222"),
	},
	presentation: "full",
};
const AGENT_BESIDE: NavigationSelection = {
	context: {
		kind: "agent",
		agentId: agentId("33333333-3333-4333-8333-333333333333"),
	},
	presentation: "beside",
};

const MARKER = "/tmp/devhub-wait-abc/marker";

describe("what a --wait open goes back to", () => {
	it("goes back to what was selected before the open", () => {
		const returns = new WaitSelectionReturns();
		returns.push(MARKER, A, B);
		expect(returns.take(MARKER, B)).toEqual(A);
	});

	/**
	 * The exact-record rule: a person who navigated away during the edit chose
	 * where they are, and closing the editor does not overrule that choice.
	 */
	it("stays put when the selection has moved on since the open", () => {
		const returns = new WaitSelectionReturns();
		returns.push(MARKER, A, B);
		expect(returns.take(MARKER, AGENT_BESIDE)).toBeUndefined();
	});

	/** The presentation is part of the selection, so it is part of the record. */
	it("stays put when only the presentation has changed", () => {
		const returns = new WaitSelectionReturns();
		returns.push(MARKER, A, { ...AGENT_BESIDE, presentation: "full" });
		expect(returns.take(MARKER, AGENT_BESIDE)).toBeUndefined();
	});

	it("goes back to an Agent shown the way it was shown", () => {
		const returns = new WaitSelectionReturns();
		returns.push(MARKER, AGENT_BESIDE, B);
		expect(returns.take(MARKER, B)).toEqual(AGENT_BESIDE);
	});

	it("knows nothing about a marker it was never told about", () => {
		const returns = new WaitSelectionReturns();
		expect(returns.take(MARKER, A)).toBeUndefined();
	});

	it("forgets a wait once it has ended, whatever it answered", () => {
		const returns = new WaitSelectionReturns();
		returns.push(MARKER, A, B);
		expect(returns.take(MARKER, B)).toEqual(A);
		expect(returns.take(MARKER, B)).toBeUndefined();

		returns.push(MARKER, A, B);
		expect(returns.take(MARKER, AGENT_BESIDE)).toBeUndefined();
		expect(returns.size).toBe(0);
	});

	it("keeps nested waits apart", () => {
		const returns = new WaitSelectionReturns();
		const inner = "/tmp/devhub-wait-def/marker";
		returns.push(MARKER, A, B);
		returns.push(inner, B, AGENT_BESIDE);
		expect(returns.take(inner, AGENT_BESIDE)).toEqual(B);
		expect(returns.take(MARKER, B)).toEqual(A);
	});
});

/**
 * A `--wait` from an Agent's pane arranges the window — the editor beside that
 * Agent — and the arrangement *is* the selection, so it is recorded and checked
 * by the one rule above rather than by a second set of bookkeeping.
 */
describe("a --wait that arranged the window", () => {
	const WORKSPACE_BESIDE: NavigationSelection = {
		context: {
			kind: "workspace",
			workspaceId: workspaceId("11111111-1111-4111-8111-111111111111"),
		},
		presentation: "beside",
	};

	it("restores the arrangement the open replaced", () => {
		const returns = new WaitSelectionReturns();
		returns.push(MARKER, AGENT_BESIDE, WORKSPACE_BESIDE);
		expect(returns.take(MARKER, WORKSPACE_BESIDE)).toEqual(AGENT_BESIDE);
	});

	/** Already split, and the same split: there is nothing to put back. */
	it("restores nothing when the open changed nothing", () => {
		const returns = new WaitSelectionReturns();
		returns.push(MARKER, WORKSPACE_BESIDE, WORKSPACE_BESIDE);
		expect(returns.take(MARKER, WORKSPACE_BESIDE)).toBeUndefined();
	});

	/** The split toggled by hand during the edit is the person's choice. */
	it("restores nothing when the split was changed by hand during the wait", () => {
		const returns = new WaitSelectionReturns();
		returns.push(MARKER, AGENT_BESIDE, WORKSPACE_BESIDE);
		expect(
			returns.take(MARKER, { ...WORKSPACE_BESIDE, presentation: "full" }),
		).toBeUndefined();
	});

	/**
	 * Two waits from the same Agent's pane produce the *same* selection, so the
	 * exact-record check alone cannot tell the earlier one's window from the
	 * later one's. Ending the earlier one first must not take the later one's
	 * split away while its editor is still open.
	 */
	it("never undoes an arrangement a later wait set", () => {
		const returns = new WaitSelectionReturns();
		const second = "/tmp/devhub-wait-def/marker";
		returns.push(MARKER, AGENT_BESIDE, WORKSPACE_BESIDE);
		returns.push(second, WORKSPACE_BESIDE, WORKSPACE_BESIDE);

		expect(returns.take(MARKER, WORKSPACE_BESIDE)).toBeUndefined();
		expect(returns.take(second, WORKSPACE_BESIDE)).toBeUndefined();
	});

	/** Ended the other way round — innermost first — each one comes back. */
	it("restores both when nested waits end innermost first", () => {
		const returns = new WaitSelectionReturns();
		const inner = "/tmp/devhub-wait-def/marker";
		returns.push(MARKER, A, WORKSPACE_BESIDE);
		returns.push(inner, WORKSPACE_BESIDE, AGENT_BESIDE);

		expect(returns.take(inner, AGENT_BESIDE)).toEqual(WORKSPACE_BESIDE);
		expect(returns.take(MARKER, WORKSPACE_BESIDE)).toEqual(A);
	});
});
