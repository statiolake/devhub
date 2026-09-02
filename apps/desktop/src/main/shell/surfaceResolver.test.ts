/**
 * What a surface key resolves to, and when it resolves to a refusal.
 *
 * The interesting case is a Workspace that is closing. Its terminal surface
 * still has a key, still has a session and still has a folder — right up until
 * it does not — so "does this surface exist" is the wrong question to answer
 * with. The resolver refuses it by name instead, which is what stops a close
 * from being reported as a broken tmux.
 */

import { describe, expect, it } from "vitest";
import { AppModel } from "../../model/appModel.js";
import {
	AgentProfile,
	agentId,
	agentProfileId,
	cleanupProgress,
	displayPath,
	Workspace,
	workspaceId,
	workspaceRoot,
} from "../../model/domain.js";
import { TerminalFailure } from "../../ipc/terminal.js";
import { createSurfaceResolver } from "./terminalWiring.js";

const WS = workspaceId("550e8400-e29b-41d4-a716-446655440000");
const AG = agentId("550e8400-e29b-41d4-a716-4466554400a0");
const ROOT = "/projects/widget";

const codex = AgentProfile.create(
	agentProfileId("codex"),
	"Codex",
	"codex",
	"codex",
);

function modelWithWorkspace(): AppModel {
	const model = new AppModel();
	model.addWorkspace(new Workspace(WS, workspaceRoot(ROOT), displayPath(ROOT)));
	model.addAgent(WS, AG, codex);
	return model;
}

function resolverFor(model: AppModel) {
	return createSurfaceResolver(() => model);
}

/** The refusal code a call produced, or nothing if it did not refuse. */
function refusalOf(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		return error instanceof TerminalFailure ? error.code : "not-a-refusal";
	}
	return undefined;
}

describe("an open workspace", () => {
	it("resolves its terminal", () => {
		const resolve = resolverFor(modelWithWorkspace());
		expect(resolve(`workspace-terminal:${WS}`)).toMatchObject({
			kind: "workspace",
			workspaceId: WS,
		});
	});

	it("resolves its agent", () => {
		const resolve = resolverFor(modelWithWorkspace());
		expect(resolve(`agent:${AG}`)).toMatchObject({
			kind: "agent",
			agentId: AG,
		});
	});
});

describe("a workspace that is closing", () => {
	it("refuses its terminal by name, rather than reporting no such surface", () => {
		const model = modelWithWorkspace();
		model.markWorkspaceClosing(WS, cleanupProgress(0, false, false));
		expect(
			refusalOf(() => resolverFor(model)(`workspace-terminal:${WS}`)),
		).toBe("workspace_closing");
	});

	it("refuses the agents that are closing with it", () => {
		const model = modelWithWorkspace();
		model.markWorkspaceClosing(WS, cleanupProgress(0, false, false));
		expect(refusalOf(() => resolverFor(model)(`agent:${AG}`))).toBe(
			"workspace_closing",
		);
	});
});

describe("keys that name nothing", () => {
	it("has no surface for a workspace that is gone", () => {
		const resolve = resolverFor(new AppModel());
		expect(resolve(`workspace-terminal:${WS}`)).toBeUndefined();
	});

	it("has no surface for a key that is not an identity", () => {
		const resolve = resolverFor(modelWithWorkspace());
		expect(resolve("workspace-terminal:not-a-uuid")).toBeUndefined();
	});

	it("still answers the scratch terminal, which belongs to no workspace", () => {
		const model = modelWithWorkspace();
		model.markWorkspaceClosing(WS, cleanupProgress(0, false, false));
		// The scratch session is not a workspace's, so nothing about a closing
		// workspace may take it away.
		expect(resolverFor(model)("global-terminal")).toMatchObject({
			kind: "scratch",
		});
	});
});
