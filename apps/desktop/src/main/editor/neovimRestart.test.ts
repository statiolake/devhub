import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { followRestartSh } from "./neovimRestart.js";

/**
 * The follow loop under a real `sh`, with "servers" that write what
 * DevHub's setup would: the pid at attach, `restart` or the status at
 * VimLeave.
 */
function run(script: string): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		execFile("sh", ["-c", script], (error, stdout) => {
			resolve({
				code: typeof error?.code === "number" ? error.code : 0,
				out: stdout,
			});
		});
	});
}

describe("following :restart from the pane's program", () => {
	it("waits on the server a restart started and ends with its status", async () => {
		const state = await mkdtemp(join(tmpdir(), "devhub-restart-"));
		try {
			// The first server restarts: it starts the next (not the script's
			// child), says `restart` and exits 0; the next says its pid once
			// attached, runs a while and exits 3 (`:cq 3`).
			const script = `state=${state}
( sh -c 'echo $$ > "$0/pid"; sleep 0.5; echo 3 > "$0/exit"' "$state" & ) &
echo restart > "$state/restart"
sleep 0.1 &
pid=$!
wait "$pid"
status=$?
${followRestartSh()}
echo "done $status"
exit "$status"`;
			const started = Date.now();
			const { code, out } = await run(script);
			expect(out.trim()).toBe("done 3");
			expect(code).toBe(3);
			expect(Date.now() - started).toBeGreaterThanOrEqual(400);
		} finally {
			await rm(state, { recursive: true, force: true });
		}
	});

	it("ends with the first server's status when it did not restart", async () => {
		const state = await mkdtemp(join(tmpdir(), "devhub-restart-"));
		try {
			const { code } = await run(`state=${state}
sh -c 'exit 1' &
pid=$!
wait "$pid"
status=$?
${followRestartSh()}
exit "$status"`);
			expect(code).toBe(1);
		} finally {
			await rm(state, { recursive: true, force: true });
		}
	});
});
