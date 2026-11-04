import { describe, expect, it } from "vitest";
import { agentId } from "../../../model/domain.js";
import type { AppSnapshot } from "../../../model/appModel.js";
import {
	confirmationId,
	type IntentOutcome,
	type UserIntent,
} from "../../../model/intents.js";
import {
	restartAsTheMenuDoes,
	stopAsTheRowDoes,
	type ActedAgent,
} from "./windowActs.js";

const ID = agentId("00000000-0000-4000-8000-0000000000a1");
const CONFIRM = confirmationId("00000000-0000-4000-8000-0000000000c1");
const SNAPSHOT = {} as AppSnapshot;

function agent(overrides: Partial<ActedAgent> = {}): ActedAgent {
	return {
		id: ID,
		displayName: "Claude 1",
		status: "idle",
		controlState: { kind: "running" },
		failure: undefined,
		...overrides,
	};
}

/**
 * The coordinator's side, as far as these acts see it: an idle Agent is
 * stopped at once, a busy one (or one with a terminal) is asked about, and a
 * refusal is thrown in its own words.
 */
function coordinator(asks: IntentOutcome | Error | undefined) {
	const sent: UserIntent[] = [];
	const dispatch = (intent: UserIntent): Promise<IntentOutcome> => {
		sent.push(intent);
		if (intent.type.startsWith("confirm_"))
			return Promise.resolve({
				kind: "deferred",
				operationId: "op" as never,
				snapshot: SNAPSHOT,
			});
		if (asks instanceof Error) return Promise.reject(asks);
		return Promise.resolve(
			asks ?? {
				kind: "deferred",
				operationId: "op" as never,
				snapshot: SNAPSHOT,
			},
		);
	};
	return { sent, dispatch };
}

function asked(
	purpose: Extract<IntentOutcome, { kind: "confirmation_required" }>["purpose"],
): IntentOutcome {
	return {
		kind: "confirmation_required",
		confirmationId: CONFIRM,
		snapshot: SNAPSHOT,
		purpose,
	};
}

describe("agent stop, the row's way", () => {
	it("stops an idle agent with no question, as the row does", async () => {
		const { sent, dispatch } = coordinator(undefined);
		expect(await stopAsTheRowDoes(agent(), dispatch)).toEqual({
			busy: false,
			movedTerminal: false,
			retried: false,
		});
		expect(sent).toEqual([{ type: "stop_agent", agentId: ID }]);
	});

	it("gives the confirmation the window would ask the person for, keeping the terminal", async () => {
		const { sent, dispatch } = coordinator(
			asked({ kind: "agent_stop", agentId: ID, terminal: true }),
		);
		expect(
			await stopAsTheRowDoes(agent({ status: "working" }), dispatch),
		).toEqual({ busy: true, movedTerminal: true, retried: false });
		expect(sent).toEqual([
			{ type: "stop_agent", agentId: ID },
			{
				type: "confirm_stop_agent",
				confirmationId: CONFIRM,
				moveTerminal: true,
			},
		]);
		const noTerminal = coordinator(
			asked({ kind: "agent_stop", agentId: ID, terminal: false }),
		);
		await stopAsTheRowDoes(agent({ status: "waiting" }), noTerminal.dispatch);
		expect(noTerminal.sent[1]).toEqual({
			type: "confirm_stop_agent",
			confirmationId: CONFIRM,
		});
	});

	it("is the row's Retry Stop after a Stop that failed, and refused while one runs", async () => {
		const retry = coordinator(undefined);
		expect(
			await stopAsTheRowDoes(
				agent({
					controlState: { kind: "stop-failed", diagnostic: "x" as never },
				}),
				retry.dispatch,
			),
		).toMatchObject({ retried: true });
		expect(retry.sent).toEqual([{ type: "retry_stop_agent", agentId: ID }]);
		const stopping = coordinator(undefined);
		await expect(
			stopAsTheRowDoes(
				agent({ controlState: { kind: "stopping" } }),
				stopping.dispatch,
			),
		).rejects.toThrow("Claude 1 is already stopping.");
		expect(stopping.sent).toEqual([]);
	});

	it("passes the coordinator's refusal on, and confirms nothing", async () => {
		const { sent, dispatch } = coordinator(new Error("unknown agent"));
		await expect(stopAsTheRowDoes(agent(), dispatch)).rejects.toThrow(
			"unknown agent",
		);
		expect(sent).toHaveLength(1);
	});
});

describe("agent restart, the menu's way", () => {
	it("restarts, confirming what the window would ask", async () => {
		const { sent, dispatch } = coordinator(
			asked({ kind: "agent_restart", agentId: ID }),
		);
		expect(
			await restartAsTheMenuDoes(agent({ status: "working" }), dispatch),
		).toEqual({ busy: true });
		expect(sent).toEqual([
			{ type: "restart_agent", agentId: ID },
			{ type: "confirm_restart_agent", confirmationId: CONFIRM },
		]);
	});

	it("refuses where the menu does not offer it, and where the coordinator refuses", async () => {
		for (const controlState of [
			{ kind: "stopping" },
			{ kind: "stop-failed", diagnostic: "x" },
		] as ActedAgent["controlState"][]) {
			const { sent, dispatch } = coordinator(undefined);
			await expect(
				restartAsTheMenuDoes(agent({ controlState }), dispatch),
			).rejects.toThrow(/only a running agent's session can be restarted/);
			expect(sent).toEqual([]);
		}
		const refused = coordinator(
			new Error(
				"DevHub cannot reach the host of “Claude 1” now, and the host is what starts its CLI again.",
			),
		);
		await expect(
			restartAsTheMenuDoes(agent(), refused.dispatch),
		).rejects.toThrow(/cannot reach the host/);
		expect(refused.sent).toHaveLength(1);
	});
});
