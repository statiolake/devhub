/**
 * The Neovim editor on another machine: the forward's spec, where the
 * forwarded socket lands here, the socket directory a host answers, and what
 * a host without Neovim is told.
 */

import { execFileSync } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { unixSocketForwardSpec } from "../runtime/ssh.js";
import {
	forwardedSocketPath,
	neovimMissingMessage,
	SOCKET_DIRECTORY_SCRIPT,
} from "./neovimMachines.js";
import { makeScratchDir } from "../../model/testScratch.js";

describe("a Neovim socket on an SSH host", () => {
	it("is forwarded socket to socket, with no port", () => {
		expect(
			unixSocketForwardSpec(
				"/Users/me/devhub/nvim/fwd/0a1b.sock",
				"/tmp/devhub-nvim-1000/5c6d.sock",
			),
		).toBe(
			"/Users/me/devhub/nvim/fwd/0a1b.sock:/tmp/devhub-nvim-1000/5c6d.sock",
		);
		expect(() => unixSocketForwardSpec("/a:b", "/c")).toThrow(":");
	});

	it("lands at a short path here, one per host and remote path", () => {
		const one = forwardedSocketPath("/d", "ssh:build-box", "/tmp/x/a.sock");
		expect(one).toMatch(/^\/d\/[0-9a-f]{12}\.sock$/u);
		expect(forwardedSocketPath("/d", "ssh:other", "/tmp/x/a.sock")).not.toBe(
			one,
		);
		expect(forwardedSocketPath("/d", "ssh:build-box", "/tmp/x/a.sock")).toBe(
			one,
		);
	});

	it("lives in a directory only its user can enter, under TMPDIR", () => {
		const tmp = makeScratchDir("nvim-dir");
		const answer = execFileSync("sh", ["-c", SOCKET_DIRECTORY_SCRIPT], {
			encoding: "utf8",
			env: { ...process.env, TMPDIR: `${tmp}/` },
		});
		expect(answer).toMatch(new RegExp(`^${tmp}/devhub-nvim-[0-9]+$`, "u"));
		expect(statSync(answer).mode & 0o777).toBe(0o700);
		rmSync(tmp, { recursive: true, force: true });
	});

	it("names the host and the fix when there is no nvim", () => {
		const message = neovimMissingMessage("ssh:build-box", {
			kind: "unavailable",
			configured: "nvim",
			lookup: { kind: "search", directories: ["/usr/bin", "/bin"] },
			where: " on build-box",
		});
		expect(message).toContain("Neovim on build-box");
		expect(message).toContain("/usr/bin, /bin");
		expect(message).toContain('editor = "vscode"');
	});
});
