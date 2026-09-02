/**
 * What asking `gh` anything can come to, and why it is three answers.
 *
 * "There is no token" used to cover both a `gh` that is not installed and a
 * `gh` that is installed and logged out. One answer meant one sentence, and the
 * sentence told a person with no GitHub CLI at all to run `gh auth login` —
 * advice that cannot work, for a reason that was never the reason.
 *
 * These run a real `gh` off a real PATH rather than a mock, because the whole
 * distinction lives in how the process fails: a spawn that never starts and a
 * process that starts and exits non-zero are different events, and a stub that
 * resolves a value tests neither.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGitHubLogin, readGitHubToken } from "./github.js";

let directory: string;

/** A `gh` on PATH that behaves however this test needs it to. */
async function fakeGh(script: string): Promise<void> {
	const path = join(directory, "gh");
	await writeFile(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "devhub-gh-"));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("reading the GitHub token", () => {
	it("is the token when `gh` is holding one", async () => {
		await fakeGh('echo "gho_example"');
		const result = await readGitHubToken({ PATH: directory });
		expect(result).toEqual({ kind: "token", token: "gho_example" });
	});

	it("is `unauthenticated` when `gh` runs and declines", async () => {
		// The logged-out case: `gh` is installed and exits non-zero. The fix is
		// `gh auth login`, and this is the only outcome for which that is true.
		await fakeGh("exit 1");
		const result = await readGitHubToken({ PATH: directory });
		expect(result).toEqual({ kind: "unauthenticated" });
	});

	it("is `unauthenticated` when `gh` succeeds but says nothing", async () => {
		await fakeGh("exit 0");
		const result = await readGitHubToken({ PATH: directory });
		expect(result).toEqual({ kind: "unauthenticated" });
	});

	it("is `unrunnable`, naming PATH, when there is no `gh` to run", async () => {
		// Not a logged-out `gh`: no `gh`. Telling this person to log in is the bug
		// this outcome exists to prevent.
		const result = await readGitHubToken({ PATH: directory });
		expect(result).toEqual({
			kind: "unrunnable",
			reason: "there is no `gh` on DevHub's PATH",
		});
	});
});

/**
 * Who `gh` says this machine is.
 *
 * Two answers here rather than three: a page that wanted an owner and did not
 * get one has the same thing to do — say so, and ask for `owner/name` — whether
 * `gh` is missing or logged out. The *reason* still differs, because the reason
 * is what a person acts on, so it is carried rather than collapsed.
 */
describe("reading who GitHub says this machine is", () => {
	it("is the login when `gh` answers with one", async () => {
		await fakeGh('echo "octocat"');
		const result = await readGitHubLogin({ PATH: directory });
		expect(result).toEqual({ kind: "login", login: "octocat" });
	});

	it("says to log in when `gh` runs and declines", async () => {
		await fakeGh("exit 1");
		const result = await readGitHubLogin({ PATH: directory });
		expect(result).toEqual({
			kind: "unknown",
			reason: "`gh` is not signed in to GitHub — run `gh auth login`",
		});
	});

	it("names PATH, not the login, when there is no `gh` to run", async () => {
		const result = await readGitHubLogin({ PATH: directory });
		expect(result).toEqual({
			kind: "unknown",
			reason: "there is no `gh` on DevHub's PATH",
		});
	});
});
