import { describe, expect, it } from "vitest";
import { agentId, workspaceId } from "../../model/domain.js";
import {
	AppError,
	AppErrorCode,
	operationId,
	operationToken,
	type ProviderEvent,
} from "../../model/intents.js";
import { completionRefusalRoute } from "./completionRefusal.js";

const token = operationToken(
	operationId("550e8400-e29b-41d4-a716-000000000001"),
	1,
);

const failed: ProviderEvent = {
	type: "operation_failed",
	token,
	detail: "/src/api could not be opened as a workspace: not a directory",
};

const launched: ProviderEvent = {
	type: "agent_launch_completed",
	token,
	workspaceId: workspaceId("550e8400-e29b-41d4-a716-000000000002"),
	agentId: agentId("550e8400-e29b-41d4-a716-000000000003"),
	result: { kind: "failed", code: "tmux_command_failed" },
};

const portRefusal = new AppError(AppErrorCode.PortUnavailable).withPort("app");

describe("a completion the coordinator refused", () => {
	it("is not published again when failOperation already reported it at its subject", () => {
		expect(completionRefusalRoute(failed, portRefusal)).toBe("reject");
	});

	it("is published when nothing has reported it yet", () => {
		expect(completionRefusalRoute(launched, portRefusal)).toBe("publish");
	});

	it("is only refused when it answers an operation something newer settled", () => {
		expect(
			completionRefusalRoute(
				launched,
				new AppError(AppErrorCode.StaleCompletion),
			),
		).toBe("reject");
	});

	it("stops the process when it answers an operation never started", () => {
		expect(
			completionRefusalRoute(
				failed,
				new AppError(AppErrorCode.UnknownOperation),
			),
		).toBe("crash");
	});
});
