import { describe, expect, it } from "vitest";
import { CloseTimeout, withCloseDeadline } from "./cleanupDeadline.js";

describe("a step of a workspace close", () => {
	it("passes through the answer it got", async () => {
		await expect(
			withCloseDeadline("editor", Promise.resolve(true), 50),
		).resolves.toBe(true);
	});

	it("passes through the failure it got", async () => {
		await expect(
			withCloseDeadline("terminal", Promise.reject(new Error("no tmux")), 50),
		).rejects.toThrow("no tmux");
	});

	it("ends by itself when nothing ever answers", async () => {
		// The case the close used to get stuck in: a runtime that neither
		// succeeds nor fails. It has to become a failure, because a close that
		// never finishes is a workspace nobody can get out of.
		const never = new Promise<void>(() => undefined);
		const error: unknown = await withCloseDeadline("agents", never, 10).catch(
			(raw: unknown) => raw,
		);
		expect(error).toBeInstanceOf(CloseTimeout);
		expect((error as CloseTimeout).diagnostic).toBe("close_agents_unknown");
	});
});
