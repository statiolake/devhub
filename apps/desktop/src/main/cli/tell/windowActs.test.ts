import { describe, expect, it } from "vitest";
import {
	agentId,
	CLEAN_INSPECTION,
	workspaceId,
	type CloseInspectionInputs,
} from "../../../model/domain.js";
import type { AppSnapshot } from "../../../model/appModel.js";
import {
	confirmationId,
	type IntentOutcome,
	type UserIntent,
} from "../../../model/intents.js";
import {
	closeAsTheWindowDoes,
	restartAsTheMenuDoes,
	stopAsTheRowDoes,
	type ActedAgent,
	type ClosedWorkspace,
	type CloseWindow,
} from "./windowActs.js";
import type { TellCloseAnswers } from "./service.js";

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

const WS = workspaceId("00000000-0000-4000-8000-0000000000b1");

function closing(overrides: Partial<ClosedWorkspace> = {}): ClosedWorkspace {
	return {
		id: WS,
		label: "app",
		scratch: false,
		closing: false,
		worktree: undefined,
		...overrides,
	};
}

const WORKTREE = { root: "/src/app-12", branch: "12-fix", dirty: true };

function answers(given: Partial<TellCloseAnswers> = {}): TellCloseAnswers {
	return {
		worktree: undefined,
		agents: undefined,
		terminals: undefined,
		discardUnsaved: false,
		...given,
	};
}

const BUSY: CloseInspectionInputs = {
	agents: { kind: "busy", count: 2 },
	terminalProcesses: { kind: "busy", count: 1 },
	terminalPanes: { kind: "clean" },
	terminalWindows: { kind: "clean" },
	unsavedEditors: { kind: "unsaved", tabs: ["main.ts", "README.md"] },
};

/**
 * The window's close as `workspace close` sees it: the reading the close
 * sheet is drawn from, the coordinator (which asks when that reading is not
 * clean), and what is left once the close settled.
 */
function closeWindow(
	inspection: CloseInspectionInputs,
	options: {
		readonly coordinatorReads?: CloseInspectionInputs;
		readonly failure?: string;
	} = {},
) {
	const sent: UserIntent[] = [];
	const read = options.coordinatorReads ?? inspection;
	const clean = read === CLEAN_INSPECTION;
	const window: CloseWindow = {
		inspect: () => Promise.resolve(inspection),
		failure: () => options.failure,
		dispatch: (intent) => {
			sent.push(intent);
			if (intent.type === "request_close_workspace" && !clean)
				return Promise.resolve({
					kind: "confirmation_required",
					confirmationId: CONFIRM,
					snapshot: SNAPSHOT,
					purpose: {
						kind: "workspace_close",
						inspection: {
							...read,
							workspaceId: WS,
							workspaceLabel: "app",
						},
						worktree: intent.worktree,
					},
				});
			return Promise.resolve({ kind: "updated", snapshot: SNAPSHOT });
		},
	};
	return { sent, window };
}

describe("workspace close, the window's way", () => {
	it("closes a workspace with nothing to ask about by the window's one intent", async () => {
		const { sent, window } = closeWindow(CLEAN_INSPECTION);
		expect(await closeAsTheWindowDoes(closing(), answers(), window)).toEqual({
			kind: "closed",
			worktree: "none",
			busyTerminalProcesses: 0,
			discarded: [],
		});
		// The window's intents only: no selection, no focus, nothing shown.
		expect(sent).toEqual([
			{ type: "request_close_workspace", workspaceId: WS, worktree: "keep" },
		]);
	});

	it("asks every question the window's sheets would, and sends nothing", async () => {
		const { sent, window } = closeWindow(BUSY);
		const result = await closeAsTheWindowDoes(
			closing({ worktree: WORKTREE }),
			answers(),
			window,
		);
		expect(result.kind).toBe("questions");
		if (result.kind !== "questions") return;
		expect(
			result.questions.map((question) => [question.flag, question.values]),
		).toEqual([
			["--worktree", ["keep", "remove"]],
			["--agents", ["stop"]],
			["--terminals", ["close"]],
			["--discard-unsaved", []],
		]);
		expect(result.questions[0]!.why).toMatch(
			/removes \/src\/app-12 \(12-fix\) unless kept; it has uncommitted changes/,
		);
		expect(result.questions[3]!.why).toMatch(/main\.ts, README\.md/);
		expect(sent).toEqual([]);
	});

	it("asks each question only when it applies", async () => {
		for (const [inspection, flag] of [
			[{ ...CLEAN_INSPECTION, agents: { kind: "busy", count: 1 } }, "--agents"],
			[
				{
					...CLEAN_INSPECTION,
					terminalWindows: {
						kind: "unknown",
						diagnostic: "close_terminal_unknown",
					},
				},
				"--terminals",
			],
			[
				{
					...CLEAN_INSPECTION,
					unsavedEditors: {
						kind: "unknown",
						diagnostic: "close_editor_unresponsive",
					},
				},
				"--discard-unsaved",
			],
		] as const) {
			const { sent, window } = closeWindow(inspection as CloseInspectionInputs);
			const result = await closeAsTheWindowDoes(closing(), answers(), window);
			expect(result).toMatchObject({
				kind: "questions",
				questions: [{ flag }],
			});
			expect(sent).toEqual([]);
		}
	});

	it("gives the close sheet's confirmation once every question is answered", async () => {
		const { sent, window } = closeWindow(BUSY);
		expect(
			await closeAsTheWindowDoes(
				closing(),
				answers({ agents: "stop", terminals: "close", discardUnsaved: true }),
				window,
			),
		).toEqual({
			kind: "closed",
			worktree: "none",
			busyTerminalProcesses: 1,
			discarded: ["main.ts", "README.md"],
		});
		expect(sent).toEqual([
			{ type: "request_close_workspace", workspaceId: WS, worktree: "keep" },
			{ type: "confirm_close_workspace", confirmationId: CONFIRM },
		]);
	});

	it("answers the folder question as the window's sheets do", async () => {
		const cases = [
			[{ ...WORKTREE, dirty: true }, "remove", "remove-anyway", "removed"],
			[{ ...WORKTREE, dirty: undefined }, "remove", "remove-anyway", "removed"],
			[{ ...WORKTREE, dirty: false }, "remove", "remove", "removed"],
			[WORKTREE, "keep", "keep", "kept"],
		] as const;
		for (const [worktree, answer, disposition, said] of cases) {
			const { sent, window } = closeWindow(CLEAN_INSPECTION);
			expect(
				await closeAsTheWindowDoes(
					closing({ worktree }),
					answers({ worktree: answer }),
					window,
				),
			).toMatchObject({ kind: "closed", worktree: said });
			expect(sent).toEqual([
				{
					type: "request_close_workspace",
					workspaceId: WS,
					worktree: disposition,
				},
			]);
		}
	});

	it("leaves the confirmation unanswered when a question came up after it looked", async () => {
		const { sent, window } = closeWindow(CLEAN_INSPECTION, {
			coordinatorReads: {
				...CLEAN_INSPECTION,
				agents: { kind: "busy", count: 1 },
			},
		});
		expect(
			await closeAsTheWindowDoes(closing(), answers(), window),
		).toMatchObject({ kind: "questions", questions: [{ flag: "--agents" }] });
		expect(sent).toEqual([
			{ type: "request_close_workspace", workspaceId: WS, worktree: "keep" },
		]);
	});

	it("refuses what the window refuses, before sending anything", async () => {
		for (const [workspace, given, refusal] of [
			[closing({ scratch: true }), answers(), /Scratch cannot be closed/],
			[
				closing({ orchestrator: true }),
				answers(),
				/orchestrator's workspace cannot be closed/,
			],
			[closing({ closing: true }), answers(), /app is already closing/],
			[
				closing(),
				answers({ worktree: "remove" }),
				/not a worktree DevHub removes on close/,
			],
		] as const) {
			const { sent, window } = closeWindow(CLEAN_INSPECTION);
			await expect(
				closeAsTheWindowDoes(workspace, given, window),
			).rejects.toThrow(refusal);
			expect(sent).toEqual([]);
		}
	});

	it("says why the workspace is still open when the close stopped at a step", async () => {
		const { window } = closeWindow(CLEAN_INSPECTION, {
			failure: "the close stopped at its worktree step (cleanup_failed)",
		});
		await expect(
			closeAsTheWindowDoes(
				closing({ worktree: { ...WORKTREE, dirty: false } }),
				answers({ worktree: "remove" }),
				window,
			),
		).rejects.toThrow(/stopped at its worktree step/);
	});
});
