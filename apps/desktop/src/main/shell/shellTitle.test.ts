import { describe, expect, it } from "vitest";
import { editorElement, shellTitleFor } from "./shellTitle.js";
import type { ShellTitleFacts } from "./shellTitle.js";
import { agentId, workspaceId } from "../../model/domain.js";

const WORKSPACE = workspaceId("63752e9f-c93d-4d49-87f0-70f352eea8b0");
const AGENT = agentId("5d7fd0e2-2a0e-4a2b-9f3e-9a1a0a0b1c2d");

function facts(
	overrides: Partial<ShellTitleFacts> & {
		readonly activity?: string | undefined;
	} = {},
): ShellTitleFacts {
	return {
		selection: {
			context: { kind: "workspace", workspaceId: WORKSPACE },
			presentation: "full",
			...(overrides.selection ?? {}),
		},
		workspaces: [
			{
				id: WORKSPACE,
				label: "widget",
				agents: [
					{
						id: AGENT,
						displayName: "Claude 1",
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
						context: { kind: "global" },
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

	it("never loses DevHub or the workspace, whatever is selected", () => {
		const everySelection: ShellTitleFacts["selection"][] = [
			{ context: { kind: "global" }, presentation: "full" },
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
