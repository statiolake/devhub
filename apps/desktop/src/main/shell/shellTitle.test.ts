import { describe, expect, it } from "vitest";
import {
	editorElement,
	orchestratorViewWire,
	shellTitleFor,
	titleText,
} from "./shellTitle.js";
import type { ShellTitleFacts } from "./shellTitle.js";
import { agentId, workspaceId } from "../../model/domain.js";

const WORKSPACE = workspaceId("63752e9f-c93d-4d49-87f0-70f352eea8b0");
const AGENT = agentId("5d7fd0e2-2a0e-4a2b-9f3e-9a1a0a0b1c2d");
/** Today's daily folder, which the model labels Scratch. */
const SCRATCH = workspaceId("0c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5");

function facts(
	overrides: Partial<ShellTitleFacts> & {
		readonly activity?: string | undefined;
		readonly displayName?: string;
		readonly named?: boolean;
	} = {},
): ShellTitleFacts {
	return {
		selection: {
			context: { kind: "workspace", workspaceId: WORKSPACE },
			presentation: "full",
			...(overrides.selection ?? {}),
		},
		workspaces: [
			{ id: SCRATCH, label: "Scratch", agents: [] },
			{
				id: WORKSPACE,
				label: "widget",
				agents: [
					{
						id: AGENT,
						displayName: overrides.displayName ?? "Claude 1",
						named: overrides.named ?? false,
						activity: overrides.activity,
					},
				],
			},
		],
		editorElement: overrides.editorElement,
	} as unknown as ShellTitleFacts;
}

describe("the shell window's title", () => {
	it("names the file, the workspace and DevHub while the Editor is showing one", () => {
		expect(shellTitleFor(facts({ editorElement: "reconciler.ts" }))).toBe(
			"reconciler.ts — widget — DevHub",
		);
	});

	it("still names the workspace and DevHub with no editor open", () => {
		expect(shellTitleFor(facts())).toBe("widget — DevHub");
	});

	it("calls the empty context Scratch, which is a workspace like any other", () => {
		expect(
			shellTitleFor(
				facts({
					selection: {
						context: { kind: "workspace", workspaceId: SCRATCH },
						presentation: "full",
					},
					editorElement: "notes.md",
				}),
			),
		).toBe("notes.md — Scratch — DevHub");
	});

	it("says what the selected Agent is doing, in the Agent's own words", () => {
		expect(
			shellTitleFor(
				facts({
					selection: {
						context: { kind: "agent", agentId: AGENT },
						presentation: "full",
					},
					activity: "Reading the reconciler",
					// The workbench is still on screen beside it, and still
					// naming a file. The Agent is what was selected, so the
					// Agent is what the window is called after.
					editorElement: "reconciler.ts",
				}),
			),
		).toBe("Reading the reconciler — widget — DevHub");
	});

	it("falls back to the Agent's name when it has said nothing", () => {
		expect(
			shellTitleFor(
				facts({
					selection: {
						context: { kind: "agent", agentId: AGENT },
						presentation: "full",
					},
					activity: undefined,
				}),
			),
		).toBe("Claude 1 — widget — DevHub");
	});

	/**
	 * The row's rule (`agentLeadingText`): a name a person gave the Agent leads
	 * its row, so it is what the window is called after too.
	 */
	it("is called after the name somebody gave the Agent, over what it is doing", () => {
		expect(
			shellTitleFor(
				facts({
					selection: {
						context: { kind: "agent", agentId: AGENT },
						presentation: "full",
					},
					displayName: "Investigator",
					named: true,
					activity: "Reading the reconciler",
				}),
			),
		).toBe("Investigator — widget — DevHub");
	});

	it("never loses DevHub or the workspace, whatever is selected", () => {
		const everySelection: ShellTitleFacts["selection"][] = [
			{
				context: { kind: "workspace", workspaceId: SCRATCH },
				presentation: "full",
			},
			{
				context: { kind: "workspace", workspaceId: WORKSPACE },
				presentation: "full",
			},
			{ context: { kind: "agent", agentId: AGENT }, presentation: "full" },
			{ context: { kind: "agent", agentId: AGENT }, presentation: "beside" },
		];
		for (const selection of everySelection) {
			for (const element of [undefined, "reconciler.ts"]) {
				const title = shellTitleFor(
					facts({ selection, editorElement: element }),
				);
				expect(title).toContain("DevHub");
				expect(title).toMatch(/widget|Scratch/);
			}
		}
	});

	it("refuses to name a selection the model does not have", () => {
		expect(() =>
			shellTitleFor(
				facts({
					selection: {
						context: {
							kind: "workspace",
							workspaceId: workspaceId("63752e9f-c93d-4d49-87f0-70f352eea8b1"),
						},
						presentation: "full",
					},
				}),
			),
		).toThrow(/not in the model/);
	});
});

describe("what the workbench reports as an element", () => {
	it("takes the editor it names", () => {
		expect(editorElement("● reconciler.ts", "Code - OSS")).toBe(
			"● reconciler.ts",
		);
	});

	it("takes nothing from a workbench that is only naming the product", () => {
		expect(editorElement("Code - OSS", "Code - OSS")).toBeUndefined();
	});

	it("takes nothing from a workbench that has not reported yet", () => {
		expect(editorElement(undefined, "Code - OSS")).toBeUndefined();
		expect(editorElement("   ", "Code - OSS")).toBeUndefined();
	});
});

describe("the shell window's title on the Orchestrator screen", () => {
	const ORCHESTRATOR = workspaceId("9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d");
	const CHILD = agentId("1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9");
	const WORKER = agentId("2c3d4e5f-6071-4829-93a4-b5c6d7e8f901");
	const PAYMENTS = workspaceId("3d4e5f60-7182-493a-a4b5-c6d7e8f90123");

	function orchestrator(
		view: ShellTitleFacts["orchestratorView"],
		context: ShellTitleFacts["selection"]["context"] = { kind: "orchestrator" },
	): ShellTitleFacts {
		return {
			selection: { context, presentation: "full" },
			workspaces: [
				{
					id: ORCHESTRATOR,
					label: "Orchestrator",
					agents: [
						{
							id: CHILD,
							displayName: "helper",
							named: true,
							activity: "Reading decisions.md",
						},
					],
				},
				{
					id: WORKSPACE,
					label: "#123 ログイン修正",
					agents: [{ id: WORKER, displayName: "Claude 1", named: false }],
				},
				{ id: PAYMENTS, label: "payments", agents: [] },
			],
			editorElement: "ignored.ts",
			orchestratorWorkspaceId: ORCHESTRATOR,
			orchestratorView: view,
		} as unknown as ShellTitleFacts;
	}

	it("is Orchestrator — DevHub on the board, whatever the workbench says", () => {
		expect(shellTitleFor(orchestrator({ kind: "board" }))).toBe(
			"Orchestrator — DevHub",
		);
		expect(shellTitleFor(orchestrator(undefined))).toBe(
			"Orchestrator — DevHub",
		);
	});

	it("leads with the escalation's Workspace, then its subject", () => {
		expect(
			shellTitleFor(
				orchestrator({
					kind: "escalation",
					subject: "本番DBマイグレーション承認",
					workspaceId: PAYMENTS,
					agentIds: [WORKER],
				}),
			),
		).toBe("payments · 本番DBマイグレーション承認 — Orchestrator — DevHub");
	});

	it("takes the first related agent's Workspace when it names none", () => {
		expect(
			shellTitleFor(
				orchestrator({
					kind: "escalation",
					subject: "本番DBマイグレーション承認",
					agentIds: [WORKER, CHILD],
				}),
			),
		).toBe(
			"#123 ログイン修正 · 本番DBマイグレーション承認 — Orchestrator — DevHub",
		);
	});

	it("is the subject alone with no Workspace to name, or only the Orchestrator's", () => {
		expect(
			shellTitleFor(
				orchestrator({
					kind: "escalation",
					subject: "方針の確認",
					agentIds: [],
				}),
			),
		).toBe("方針の確認 — Orchestrator — DevHub");
		expect(
			shellTitleFor(
				orchestrator({
					kind: "escalation",
					subject: "方針の確認",
					agentIds: [CHILD],
				}),
			),
		).toBe("方針の確認 — Orchestrator — DevHub");
	});

	it("names the file open in the Files tab", () => {
		expect(
			shellTitleFor(orchestrator({ kind: "file", path: "notes/decisions.md" })),
		).toBe("decisions.md — Orchestrator — DevHub");
	});

	it("calls a child agent of the row what any agent is called", () => {
		expect(
			shellTitleFor(
				orchestrator(
					{ kind: "escalation", subject: "x", agentIds: [] },
					{ kind: "agent", agentId: CHILD },
				),
			),
		).toBe("helper — Orchestrator — DevHub");
	});

	it("puts a subject on one line and cuts a long one near 80 characters", () => {
		const title = shellTitleFor(
			orchestrator({
				kind: "escalation",
				subject: `承認\n\tお願い\u0007します ${"とても長い件名 ".repeat(20)}`,
				agentIds: [],
			}),
		);
		const subject = title.split(" — ")[0] ?? "";
		expect(subject.startsWith("承認 お願い します とても長い件名")).toBe(true);
		expect(subject.endsWith("…")).toBe(true);
		expect(Array.from(subject).length).toBeLessThanOrEqual(80);
		// eslint-disable-next-line no-control-regex
		expect(title).not.toMatch(/[\u0000-\u001f]/u);
	});
});

describe("titleText", () => {
	it("leaves a short line alone", () => {
		expect(titleText("  ログイン修正 ")).toBe("ログイン修正");
	});

	it("cuts at a word when one is near the limit", () => {
		expect(titleText("alpha beta gamma delta", 15)).toBe("alpha beta…");
	});
});

describe("what the Orchestrator screen may report", () => {
	it("is an id or a path, and nothing else", () => {
		expect(orchestratorViewWire({ kind: "board" })).toEqual({ kind: "board" });
		expect(
			orchestratorViewWire({ kind: "escalation", id: 4, body: "x" }),
		).toEqual({ kind: "escalation", id: 4 });
		expect(orchestratorViewWire({ kind: "file", path: "a.md" })).toEqual({
			kind: "file",
			path: "a.md",
		});
		expect(
			orchestratorViewWire({ kind: "escalation", id: "4" }),
		).toBeUndefined();
		expect(orchestratorViewWire({ kind: "title", text: "x" })).toBeUndefined();
		expect(orchestratorViewWire(null)).toBeUndefined();
	});
});
