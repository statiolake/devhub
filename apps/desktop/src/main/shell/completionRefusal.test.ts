import { describe, expect, it } from "vitest";
import { agentId, workspaceId } from "../../model/domain.js";
import {
	AppError,
	AppErrorCode,
	operationId,
	operationToken,
	type ProviderEvent,
} from "../../model/intents.js";
import {
	errorWire,
	errorWireAt,
	TypedFailure,
	withDetail,
} from "../../model/wire.js";
import { completionRefusal } from "./completionRefusal.js";

const token = operationToken(
	operationId("550e8400-e29b-41d4-a716-000000000001"),
	1,
);

const words = withDetail(
	errorWireAt("workspace_unavailable"),
	"/src/api could not be opened as a workspace: not a directory",
);

const failed: ProviderEvent = {
	type: "operation_failed",
	token,
	failure: words,
};

const launched: ProviderEvent = {
	type: "agent_launch_completed",
	token,
	workspaceId: workspaceId("550e8400-e29b-41d4-a716-000000000002"),
	agentId: agentId("550e8400-e29b-41d4-a716-000000000003"),
	result: { kind: "failed", code: "tmux_command_failed", detail: "no tmux" },
};

const launchRefusal = new AppError(AppErrorCode.PortUnavailable)
	.withPort("agent")
	.withAgentFailure("tmux_command_failed")
	.withDetail("no tmux");

function rejectionWire(refusal: ReturnType<typeof completionRefusal>) {
	if (refusal.kind !== "answer") throw new Error("expected an answer");
	return errorWire(refusal.rejection);
}

describe("a completion the coordinator refused", () => {
	it("is not drawn again when failOperation already drew it at its subject", () => {
		const refusal = completionRefusal(failed, new TypedFailure(words));
		expect(refusal).toMatchObject({ kind: "answer" });
		expect(refusal).not.toHaveProperty("publish");
		// The request reads the words that were drawn, marked as drawn.
		expect(rejectionWire(refusal)).toEqual({ ...words, reported: true });
	});

	it("is drawn once when nothing has drawn it, and the request is told so", () => {
		const refusal = completionRefusal(launched, launchRefusal);
		const drawn = errorWire(launchRefusal);
		expect(refusal).toMatchObject({ kind: "answer", publish: drawn });
		expect(rejectionWire(refusal)).toEqual({ ...drawn, reported: true });
	});

	it("is only refused, undrawn, when it answers an operation something newer settled", () => {
		const stale = new AppError(AppErrorCode.StaleCompletion);
		expect(completionRefusal(launched, stale)).toEqual({
			kind: "answer",
			rejection: stale,
		});
	});

	it("stops the process when it answers an operation never started", () => {
		expect(
			completionRefusal(failed, new AppError(AppErrorCode.UnknownOperation)),
		).toEqual({ kind: "crash" });
	});
});
