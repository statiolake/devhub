import { describe, expect, it } from "vitest";
import { AppError, AppErrorCode } from "../../model/intents.js";
import { errorWireAt, TypedFailure, withDetail } from "../../model/wire.js";
import { completionRefusalRoute } from "./completionRefusal.js";

const reported = withDetail(
	errorWireAt("workspace_unavailable"),
	"/src/api could not be opened as a workspace: not a directory",
);

describe("a completion the coordinator refused", () => {
	it("is not published again when it was already drawn at its subject", () => {
		expect(
			completionRefusalRoute(new TypedFailure({ ...reported, reported: true })),
		).toBe("reject");
	});

	it("is published when nothing has drawn it yet", () => {
		expect(
			completionRefusalRoute(
				new AppError(AppErrorCode.PortUnavailable).withPort("agent"),
			),
		).toBe("publish");
		expect(completionRefusalRoute(new TypedFailure(reported))).toBe("publish");
	});

	it("is only refused when it answers an operation something newer settled", () => {
		expect(
			completionRefusalRoute(new AppError(AppErrorCode.StaleCompletion)),
		).toBe("reject");
	});

	it("stops the process when it answers an operation never started", () => {
		expect(
			completionRefusalRoute(new AppError(AppErrorCode.UnknownOperation)),
		).toBe("crash");
	});
});
