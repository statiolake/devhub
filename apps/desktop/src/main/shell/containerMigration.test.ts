import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { CommandOutput } from "../terminal/command.js";
import type { FileKind } from "../runtime/runtime.js";
import { prepareContainerMigration } from "./containerMigration.js";

function output(
	code: number,
	stdout = "",
	stderr = "",
): Promise<CommandOutput> {
	return Promise.resolve({
		success: code === 0,
		code,
		signal: null,
		stdout: Buffer.from(stdout, "utf8"),
		stderr: Buffer.from(stderr, "utf8"),
	});
}

/** A version-11 document with one container record that names no definition. */
function document(folder = "/src/api"): Record<string, unknown> {
	return {
		schema_version: 11,
		workspaces: [
			{ location: { kind: "local" }, canonical_path: "/src/other" },
			{
				location: { kind: "container", workspace_folder: folder },
				canonical_path: "/workspaces/api",
			},
		],
	};
}

function configOf(prepared: Record<string, unknown>): unknown {
	const records = prepared["workspaces"] as Record<string, unknown>[];
	return (records[1]!["location"] as Record<string, unknown>)["config_path"];
}

function files(
	present: readonly string[],
): (path: string) => Promise<FileKind> {
	return (path) => Promise.resolve(present.includes(path) ? "file" : "absent");
}

describe("the definition a version-11 container Workspace was using", () => {
	it("is the one its container was built from, when there is a container", async () => {
		const asked: string[][] = [];
		const prepared = document();
		const notes = await prepareContainerMigration({
			docker: {
				path: "/fake/docker",
				run: (args) => {
					asked.push([...args]);
					return output(0, "/src/api/.devcontainer/python/devcontainer.json\n");
				},
			},
			stat: files(["/src/api/.devcontainer/devcontainer.json"]),
		})(prepared, 11);
		expect(configOf(prepared)).toBe(
			"/src/api/.devcontainer/python/devcontainer.json",
		);
		expect(notes).toEqual([]);
		expect(asked[0]).toContain("label=devcontainer.local_folder=/src/api");
	});

	it("is the folder's default one when there is no container", async () => {
		const prepared = document();
		const notes = await prepareContainerMigration({
			docker: { path: "/fake/docker", run: () => output(0, "") },
			stat: files(["/src/api/.devcontainer.json"]),
		})(prepared, 11);
		expect(configOf(prepared)).toBe("/src/api/.devcontainer.json");
		expect(notes).toEqual([]);
	});

	it("is the folder's default one when Docker does not answer, and says where it came from", async () => {
		const prepared = document();
		const notes = await prepareContainerMigration({
			docker: {
				path: "/fake/docker",
				run: () => output(1, "", "Cannot connect to the Docker daemon"),
			},
			stat: files(["/src/api/.devcontainer/devcontainer.json"]),
		})(prepared, 11);
		expect(configOf(prepared)).toBe("/src/api/.devcontainer/devcontainer.json");
		expect(notes.join(" ")).toMatch(
			/Docker did not answer \(Cannot connect to the Docker daemon\)/u,
		);
	});

	it("is not guessed when neither the container nor the folder has one", async () => {
		const prepared = document();
		await prepareContainerMigration({
			docker: { path: "/fake/docker", run: () => output(0, "") },
			stat: files([]),
		})(prepared, 11);
		expect(configOf(prepared)).toBeUndefined();
	});

	it("leaves a current document, and a definition already written, alone", async () => {
		const run = () => Promise.reject(new Error("docker must not be asked"));
		const current = document();
		expect(
			await prepareContainerMigration({
				docker: { path: "/fake/docker", run },
				stat: files([]),
			})(current, 12),
		).toEqual([]);
		const written = document();
		(
			(written["workspaces"] as Record<string, unknown>[])[1]![
				"location"
			] as Record<string, unknown>
		)["config_path"] = "/src/api/.devcontainer.json";
		await prepareContainerMigration({
			docker: { path: "/fake/docker", run },
			stat: files([]),
		})(written, 11);
		expect(configOf(written)).toBe("/src/api/.devcontainer.json");
	});
});
