/**
 * An Agent profile's command is looked up on the Agent's own machine — the
 * machine its Workspace's folder is on, which is never a dev container: a
 * container is only where a Workspace's editor may be attached.
 */

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalRuntime } from "../runtime/local.js";
import { resolveAgentProfile } from "./agentProfileCommand.js";

const profile = { id: "fake", command: "fake-agent", args: ["--profile"] };

describe("an Agent profile's command", () => {
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
