import { describe, expect, it } from "vitest";
import {
	orchestratorViewWire,
	shellTitleFor,
	titleText,
	workReference,
} from "./shellTitle.js";
import type { WorkspaceRepositoryWire } from "../../ipc/contract.js";
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
		repositories: overrides.repositories,
	} as unknown as ShellTitleFacts;
}

/** A Sidebar row for `workspace`: on `acme/widget`, with what it is working on. */
function row(
	workspace: string,
	working: Partial<WorkspaceRepositoryWire> = {},
): WorkspaceRepositoryWire {
	return {
		workspaceId: workspace,
		branch: "feature/123-login",
		repositoryUrl: "https://github.com/acme/widget",
		issueRepository: { owner: "acme", repository: "widget" },
		...working,
	};
}

const ISSUE_123 = {
	url: "https://github.com/acme/widget/issues/123",
	number: 123,
	title: "ログイン修正",
	state: "open",
} as const;

const PULL_130 = {
	number: 130,
	url: "https://github.com/acme/widget/pull/130",
	title: "Tidy the reconciler",
	state: "open",
	conversations: { unresolved: 0, uncounted: 0 },
} as const;

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

describe("the Issue in the shell window's title", () => {
	const agentSelection: ShellTitleFacts["selection"] = {
		context: { kind: "agent", agentId: AGENT },
		presentation: "full",
	};

	it("puts the Issue's number right after the Workspace's name", () => {
		const repositories = [row(WORKSPACE, { issue: ISSUE_123 })];
		expect(shellTitleFor(facts({ repositories }))).toBe("widget #123 — DevHub");
		expect(
			shellTitleFor(facts({ repositories, editorElement: "reconciler.ts" })),
		).toBe("reconciler.ts — widget #123 — DevHub");
		expect(
			shellTitleFor(
				facts({
					repositories,
					selection: agentSelection,
					activity: "Reading the reconciler",
				}),
			),
		).toBe("Reading the reconciler — widget #123 — DevHub");
	});

	it("names the pull request, as PR #N, on a branch that names no Issue", () => {
		const repositories = [
			row(WORKSPACE, { branch: "tidy-reconciler", pullRequest: PULL_130 }),
		];
		expect(
			shellTitleFor(facts({ repositories, editorElement: "reconciler.ts" })),
		).toBe("reconciler.ts — widget PR #130 — DevHub");
	});

	it("prefers the Issue to the pull request when the branch has both", () => {
		expect(
			workReference(
				row(WORKSPACE, { issue: ISSUE_123, pullRequest: PULL_130 }),
			),
		).toBe("#123");
	});

	it("names no number when neither is known, exactly as before", () => {
		for (const repositories of [
			undefined,
			[],
			[row(WORKSPACE, { branch: "main" })],
			// The branch names #123 and GitHub has not answered yet, or could
			// not: the row shows no Issue, and neither does the title.
			[row(WORKSPACE, { pending: { number: 123 } })],
			[row(WORKSPACE, { unavailable: { number: 123, reason: "offline" } })],
			// Another Workspace's Issue is not this one's.
			[row(SCRATCH, { issue: ISSUE_123 })],
		]) {
			expect(
				shellTitleFor(facts({ repositories, editorElement: "a.ts" })),
			).toBe("a.ts — widget — DevHub");
		}
	});

	it("names the repository when the Issue lives in another one", () => {
		const repositories = [
			row(WORKSPACE, {
				issue: {
					...ISSUE_123,
					url: "https://github.com/acme/plan/issues/123",
				},
			}),
		];
		expect(shellTitleFor(facts({ repositories }))).toBe(
			"widget acme/plan#123 — DevHub",
		);
	});

	it("names the upstream for a fork, whose Issues are numbered there", () => {
		expect(
			workReference(
				row(WORKSPACE, {
					repositoryUrl: "https://github.com/me/widget",
					issue: ISSUE_123,
				}),
			),
		).toBe("acme/widget#123");
		expect(
			workReference(
				row(WORKSPACE, {
					repositoryUrl: "https://github.com/me/widget",
					pullRequest: PULL_130,
				}),
			),
		).toBe("PR acme/widget#130");
	});

	it("reads the same repository in any case as the same", () => {
		expect(
			workReference(
				row(WORKSPACE, {
					repositoryUrl: "https://github.com/Acme/Widget",
					issue: ISSUE_123,
				}),
			),
		).toBe("#123");
	});

	it("moves with the branch: another Issue, a pull request, then none", () => {
		const titles = [
			[row(WORKSPACE, { issue: ISSUE_123 })],
			[
				row(WORKSPACE, {
					branch: "feature/128-tooltips",
					issue: {
						...ISSUE_123,
						number: 128,
						url: "https://github.com/acme/widget/issues/128",
					},
				}),
			],
			[row(WORKSPACE, { branch: "tidy", pullRequest: PULL_130 })],
			[row(WORKSPACE, { branch: "main" })],
		].map((repositories) =>
			shellTitleFor(facts({ repositories, editorElement: "a.ts" })),
		);
		expect(titles).toEqual([
			"a.ts — widget #123 — DevHub",
			"a.ts — widget #128 — DevHub",
			"a.ts — widget PR #130 — DevHub",
			"a.ts — widget — DevHub",
		]);
	});
});

describe("the shell window's title on the Orchestrator screen", () => {
	const ORCHESTRATOR = workspaceId("9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d");
	const CHILD = agentId("1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9");
	const WORKER = agentId("2c3d4e5f-6071-4829-93a4-b5c6d7e8f901");
	const PAYMENTS = workspaceId("3d4e5f60-7182-493a-a4b5-c6d7e8f90123");
	const PAYER = agentId("4e5f6071-8293-4a4b-b5c6-d7e8f9012345");

	function orchestrator(
		view: ShellTitleFacts["orchestratorView"],
		context: ShellTitleFacts["selection"]["context"] = { kind: "orchestrator" },
		repositories?: readonly WorkspaceRepositoryWire[],
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
				{
					id: PAYMENTS,
					label: "payments",
					agents: [{ id: PAYER, displayName: "Claude 2", named: false }],
				},
			],
			editorElement: "ignored.ts",
			orchestratorWorkspaceId: ORCHESTRATOR,
			orchestratorView: view,
			repositories,
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

	it("leads with the task's Workspace — its first open agent's — then its title", () => {
		expect(
			shellTitleFor(
				orchestrator({
					kind: "task",
					subject: "本番DBマイグレーション承認",
					agentIds: ["gone-agent", PAYER, WORKER],
				}),
			),
		).toBe("payments · 本番DBマイグレーション承認 — Orchestrator — DevHub");
	});

	it("names the task's Workspace with its Issue", () => {
		const escalation = {
			kind: "task",
			subject: "本番DBマイグレーション承認",
			agentIds: [PAYER],
		} as const;
		expect(
			shellTitleFor(
				orchestrator(escalation, undefined, [
					row(PAYMENTS, {
						repositoryUrl: "https://github.com/acme/payments",
						issueRepository: { owner: "acme", repository: "payments" },
						issue: {
							...ISSUE_123,
							url: "https://github.com/acme/payments/issues/123",
						},
					}),
				]),
			),
		).toBe(
			"payments #123 · 本番DBマイグレーション承認 — Orchestrator — DevHub",
		);
		expect(
			shellTitleFor(
				orchestrator(escalation, undefined, [
					row(PAYMENTS, {
						repositoryUrl: "https://github.com/acme/payments",
						issueRepository: { owner: "acme", repository: "payments" },
						pullRequest: {
							...PULL_130,
							url: "https://github.com/acme/payments/pull/130",
						},
					}),
				]),
			),
		).toBe(
			"payments PR #130 · 本番DBマイグレーション承認 — Orchestrator — DevHub",
		);
	});

	it("takes the first bound agent's Workspace", () => {
		expect(
			shellTitleFor(
				orchestrator({
					kind: "task",
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
					kind: "task",
					subject: "方針の確認",
					agentIds: [],
				}),
			),
		).toBe("方針の確認 — Orchestrator — DevHub");
		expect(
			shellTitleFor(
				orchestrator({
					kind: "task",
					subject: "方針の確認",
					agentIds: [CHILD],
				}),
			),
		).toBe("方針の確認 — Orchestrator — DevHub");
	});

	it("calls a child agent of the row what any agent is called", () => {
		expect(
			shellTitleFor(
				orchestrator(
					{ kind: "task", subject: "x", agentIds: [] },
					{ kind: "agent", agentId: CHILD },
				),
			),
		).toBe("helper — Orchestrator — DevHub");
	});

	it("puts a subject on one line and cuts a long one near 80 characters", () => {
		const title = shellTitleFor(
			orchestrator({
				kind: "task",
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
	it("is the board or a task's id, and nothing else", () => {
		expect(orchestratorViewWire({ kind: "board" })).toEqual({ kind: "board" });
		expect(orchestratorViewWire({ kind: "task", id: 4, body: "x" })).toEqual({
			kind: "task",
			id: 4,
		});
		// The Files tab, and the file it showed, are gone.
		expect(
			orchestratorViewWire({ kind: "file", path: "a.md" }),
		).toBeUndefined();
		expect(orchestratorViewWire({ kind: "task", id: "4" })).toBeUndefined();
		expect(orchestratorViewWire({ kind: "title", text: "x" })).toBeUndefined();
		expect(orchestratorViewWire(null)).toBeUndefined();
	});
});
