/**
 * Which `devcontainer.json` a version-11 dev container Workspace was using,
 * looked up before its state is migrated.
 *
 * A version-11 file wrote the definition down only when the person chose one
 * other than the folder's default; otherwise `devcontainer up` was run
 * without `--config` and the CLI picked. Version 12 always names the
 * definition (`EditorAttachment`), so the one the CLI picked has to be found
 * out, and two things know it:
 *
 * 1. **The container**, if there is one: `@devcontainers/cli` stamps the file
 *    it built from on the container as `devcontainer.config_file`. That is
 *    the answer that is true about the container the person has been using.
 * 2. **The folder**, if there is none: the CLI's own default order,
 *    `.devcontainer/devcontainer.json` and then `.devcontainer.json`, which is
 *    what `devcontainer up` without `--config` would take.
 *
 * Neither found is not guessed past. The record is left without one and the
 * migration opens that Workspace's editor on this Mac, saying so.
 *
 * It runs before the document is decoded (`StatePreparation`), because the
 * model cannot ask a machine anything and the migration itself is a pure
 * function of the document.
 */

import { Buffer } from "node:buffer";
import { posix } from "node:path";
import type { StatePreparation } from "../../model/persistence.js";
import {
	CONFIG_FILE_LABEL,
	DEV_CONTAINER_CONFIGS,
	dockerOutput,
	LOCAL_FOLDER_LABEL,
	type DockerCli,
} from "../runtime/container.js";
import { lastLine } from "../runtime/remoteShellRuntime.js";
import type { FileKind } from "../runtime/runtime.js";

export interface ContainerMigrationSources {
	readonly docker: DockerCli;
	/** Whether a path on this Mac is a file: the default-order fallback. */
	readonly stat: (path: string) => Promise<FileKind>;
}

export function prepareContainerMigration(
	sources: ContainerMigrationSources,
): StatePreparation {
	return async (document, version) => {
		if (version >= 12) return [];
		const workspaces = document["workspaces"];
		if (!Array.isArray(workspaces)) return [];
		const notes: string[] = [];
		for (const record of workspaces) {
			if (!isRecord(record)) continue;
			const location = record["location"];
			if (!isRecord(location) || location["kind"] !== "container") continue;
			if (location["config_path"] !== undefined) continue;
			const folder = location["workspace_folder"];
			if (typeof folder !== "string") continue;
			const found = await definitionOf(sources, folder);
			if (found.note !== undefined) notes.push(found.note);
			if (found.configPath !== undefined) {
				location["config_path"] = found.configPath;
			}
		}
		return notes;
	};
}

async function definitionOf(
	sources: ContainerMigrationSources,
	folder: string,
): Promise<{
	readonly configPath: string | undefined;
	readonly note: string | undefined;
}> {
	// Docker not answering — not running, or not installed — is not a reason
	// to lose the attachment: the folder's default definition is what the CLI
	// would have used, and the note says that is where the answer came from.
	const listed = await dockerOutput(sources.docker, [
		"ps",
		"-a",
		"--filter",
		`label=${LOCAL_FOLDER_LABEL}=${folder}`,
		"--format",
		// `.Label`, not `index .Labels`: in `docker ps` the labels are one
		// string, and only this form reads one of them.
		`{{.Label "${CONFIG_FILE_LABEL}"}}`,
	]).catch((failure: unknown) => ({
		code: 1,
		stdout: Buffer.alloc(0),
		stderr: Buffer.from(
			failure instanceof Error ? failure.message : String(failure),
		),
	}));
	let dockerNote: string | undefined;
	if (listed.code === 0) {
		const labelled = [
			...new Set(
				listed.stdout
					.toString("utf8")
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line.length > 0),
			),
		];
		if (labelled.length === 1) {
			return { configPath: labelled[0], note: undefined };
		}
		if (labelled.length > 1) {
			// Two containers from two definitions of one folder, made before
			// DevHub kept track of which: the folder's default one is what a
			// version-11 DevHub would have brought up, and it is said.
			dockerNote =
				`${folder} has containers from ${String(labelled.length)} dev ` +
				`container definitions; its editor was attached to the folder's ` +
				`default one.`;
		}
	} else {
		dockerNote =
			`Docker did not answer (${lastLine(listed.stderr.toString("utf8")) || "no reason given"}), ` +
			`so the dev container definition for ${folder} was taken from the ` +
			`folder rather than from its container.`;
	}
	for (const candidate of DEV_CONTAINER_CONFIGS) {
		const path = posix.join(folder, candidate);
		if ((await sources.stat(path)) === "file") {
			return { configPath: path, note: dockerNote };
		}
	}
	return { configPath: undefined, note: dockerNote };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
