/**
 * The workspaces DevHub keeps in its sidebar.
 *
 * A workspace is a folder DevHub has been told to remember. The folder path is
 * the identity: opening the same folder twice is the same workspace, whether it
 * came from the sidebar, from "open folder" inside a workbench, or from the
 * command line.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Workspace } from "../../ipc/contract.js";

export interface WorkspaceEntry {
	readonly id: string;
	readonly name: string;
	readonly path: string;
}

interface PersistedWorkspaces {
	readonly workspaces: readonly WorkspaceEntry[];
}

export class WorkspaceStore {
	private entries: WorkspaceEntry[];

	constructor(private readonly file: string) {
		this.entries = this.read();
	}

	private read(): WorkspaceEntry[] {
		let raw: string;
		try {
			raw = readFileSync(this.file, "utf8");
		} catch (error) {
			// Not having been written yet is the one condition that is not a
			// failure. Anything else — unreadable, a directory, no permission —
			// is a real problem and belongs to the root handler.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return [];
			}
			throw error;
		}

		const parsed = JSON.parse(raw) as PersistedWorkspaces;
		return [...parsed.workspaces];
	}

	private write(): void {
		mkdirSync(dirname(this.file), { recursive: true });
		writeFileSync(
			this.file,
			`${JSON.stringify({ workspaces: this.entries }, undefined, "\t")}\n`,
		);
	}

	all(): readonly WorkspaceEntry[] {
		return this.entries;
	}

	byId(id: string): WorkspaceEntry | undefined {
		return this.entries.find((entry) => entry.id === id);
	}

	byPath(path: string): WorkspaceEntry | undefined {
		return this.entries.find((entry) => entry.path === path);
	}

	/** Adds the folder if it is new; returns the entry either way. */
	add(path: string): WorkspaceEntry {
		const existing = this.byPath(path);
		if (existing) {
			return existing;
		}
		const entry: WorkspaceEntry = {
			id: path,
			name: basename(path) || path,
			path,
		};
		this.entries = [...this.entries, entry];
		this.write();
		return entry;
	}

	remove(id: string): WorkspaceEntry | undefined {
		const entry = this.byId(id);
		if (!entry) {
			return undefined;
		}
		this.entries = this.entries.filter((candidate) => candidate.id !== id);
		this.write();
		return entry;
	}
}

export function toWireWorkspace(
	entry: WorkspaceEntry,
	opened: boolean,
): Workspace {
	return { id: entry.id, name: entry.name, path: entry.path, opened };
}
