import { describe, expect, it } from "vitest";
import { errorWireAt, TypedFailure, withSummary } from "../../model/wire.js";
import { unreachableFailure } from "../runtime/ssh.js";
import {
	CloseTimeout,
	sessionsLeftRunning,
	sessionsLeftRunningDetail,
	withCloseDeadline,
} from "./cleanupDeadline.js";

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

describe("a close whose machine does not answer", () => {
	// The exact failure a packaged run measured: sshd had run out of sessions
	// on the ControlMaster, OpenSSH exited 255 with nothing on stdout, and
	// `clientFailure` read that as the host being unreachable. The close
	// stopped at `terminal` and the row was stuck for ever.
	const unreachable = unreachableFailure(
		"build-box.example.com",
		"mux_client_request_session: send fds failed\n",
	);

	it("names what is still running, and on which machine", () => {
		expect(
			sessionsLeftRunning("terminal", "ssh:build-box.example.com", unreachable),
		).toBe("terminal sessions on ssh:build-box.example.com");
		expect(
			sessionsLeftRunning("agents", "ssh:build-box.example.com", unreachable),
		).toBe("Agent sessions on ssh:build-box.example.com");
	});

	it("says it in one sentence, however many steps left something", () => {
		const said = sessionsLeftRunningDetail([
			"Agent sessions on ssh:build-box.example.com",
			"terminal sessions on ssh:build-box.example.com",
		]);
		expect(said).toContain("Agent sessions on ssh:build-box.example.com");
		expect(said).toContain("terminal sessions on ssh:build-box.example.com");
		// And it says what happens to them next, because now something does:
		// the machine stays in `session_machines`, so the sweep asks it again
		// and closes exactly these (`sessionSweep.ts`).
		expect(said).toContain("tmux");
		expect(said).toMatch(/next time it can reach it/u);
	});

	it("does not continue past a machine that answered and refused", () => {
		// A tmux that said no is DevHub's own work failing, and trying again is
		// how a person fixes it. Continuing would throw away a step that could
		// have succeeded.
		const refused = new TypedFailure(
			withSummary(errorWireAt("tmux_command_failed"), "no such session"),
		);
		expect(
			sessionsLeftRunning("terminal", "ssh:build-box.example.com", refused),
		).toBeUndefined();
	});

	it("does not continue past a step that ran out of time", () => {
		// The host was up; DevHub simply did not get an answer in twenty
		// seconds. That is not "nothing can be stopped there".
		expect(
			sessionsLeftRunning(
				"terminal",
				"ssh:build-box.example.com",
				new CloseTimeout("close_terminal_unknown"),
			),
		).toBeUndefined();
	});

	it("applies to no other step", () => {
		// `worktree` is the one that must still stop the close: forgetting a
		// workspace whose folder is still on a disk DevHub cannot see is
		// forgetting where the work is.
		for (const step of ["editor", "view", "worktree", "state"] as const) {
			expect(
				sessionsLeftRunning(step, "ssh:build-box.example.com", unreachable),
			).toBeUndefined();
		}
	});
});
