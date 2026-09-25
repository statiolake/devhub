/**
 * An Agent profile's command is looked up on the Agent's own machine.
 *
 * The container arm runs a real `ContainerRuntime` against a `docker` that is
 * a function, because the defect this guards against was a lookup that never
 * asked the container at all: a profile naming a script inside it was
 * searched for on this Mac's disk and refused.
 */

import { Buffer } from "node:buffer";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContainerRuntime } from "../runtime/container.js";
import { LocalRuntime } from "../runtime/local.js";
import type { CommandOutput } from "../terminal/command.js";
import { resolveAgentProfile } from "./agentProfileCommand.js";

const IN_CONTAINER = "/workspaces/ws/fake-agent.sh";

function output(code: number, stdout = ""): Promise<CommandOutput> {
	return Promise.resolve({
		success: code === 0,
		code,
		signal: null,
		stdout: Buffer.from(stdout, "utf8"),
		stderr: Buffer.alloc(0),
	});
}

/**
 * A running container whose login PATH is `/usr/bin:/bin` and in which only
 * `IN_CONTAINER` exists. Every script it is asked to run is recorded.
 */
function container(): { runtime: ContainerRuntime; scripts: string[] } {
	const scripts: string[] = [];
	const runtime = new ContainerRuntime({
		workspaceFolder: "/src/ws",
		docker: {
			path: "/fake/docker",
			run: (args) => {
				if (args[0] === "ps") return output(0, "abc\trunning\timg\n");
				if (args[0] === "inspect") return output(0, "");
				const script = args.at(-1) ?? "";
				scripts.push(script);
				if (script.includes('"$HOME"') && script.includes("uname -s")) {
					return output(0, "/home/vscode\nLinux\naarch64\n/bin/sh\n");
				}
				if (script.includes("env -0")) {
					return output(0, "PATH=/usr/bin:/bin\0HOME=/home/vscode\0");
				}
				if (script.includes("command -v --")) {
					return script.includes(IN_CONTAINER)
						? output(0, `${IN_CONTAINER}\n`)
						: output(1);
				}
				return output(0, "/home/vscode");
			},
		},
		devcontainer: {
			path: "/fake/devcontainer",
			run: () => Promise.reject(new Error("the container is already up")),
		},
	});
	return { runtime, scripts };
}

const profile = { id: "fake", command: IN_CONTAINER, args: ["--profile"] };

describe("an Agent profile's command", () => {
	it("is looked up in the container a container Workspace's Agent runs in", async () => {
		const { runtime, scripts } = container();
		expect(
			await resolveAgentProfile(runtime, profile, ["--extra"], "/usr/bin:/bin"),
		).toEqual({
			kind: "resolved",
			profile: {
				id: "fake",
				command: IN_CONTAINER,
				args: ["--profile", "--extra"],
			},
		});
		expect(scripts.some((script) => script.includes(IN_CONTAINER))).toBe(true);
	});

	it("is refused with the container's own search path when it is not there", async () => {
		const { runtime } = container();
		expect(
			await resolveAgentProfile(
				runtime,
				{ ...profile, command: "missing-agent" },
				[],
				"/opt/homebrew/bin",
			),
		).toEqual({
			kind: "unavailable",
			configured: "missing-agent",
			where: " in the dev container for /src/ws",
			lookup: { kind: "path", directories: ["/usr/bin", "/bin"] },
		});
	});

	describe("on this Mac", () => {
		let bin: string;
		beforeAll(async () => {
			bin = await mkdtemp(join(tmpdir(), "devhub-profile-"));
			await writeFile(join(bin, "local-agent"), "#!/bin/sh\n");
			await chmod(join(bin, "local-agent"), 0o755);
		});
		afterAll(() => rm(bin, { recursive: true, force: true }));

		it("is looked up in the launch PATH it is given", async () => {
			expect(
				await resolveAgentProfile(
					new LocalRuntime(),
					{ ...profile, command: "local-agent" },
					[],
					bin,
				),
			).toEqual({
				kind: "resolved",
				profile: {
					id: "fake",
					command: join(bin, "local-agent"),
					args: ["--profile"],
				},
			});
		});
	});
});
