/**
 * The Linux Neovims this DevHub carries, read out of its own bundle.
 *
 * `scripts/build_nvim.py` fetches them at build time — pinned by release tag
 * and sha256 — into `dist/nvim/`, and `scripts/package-nightly.py` copies that
 * directory to `Contents/Resources/nvim/`. Either way it is one statement,
 * `nvim.json`, and one tarball per target beside it, so there is one reader.
 * Nothing is downloaded while DevHub runs, and nothing on a host is asked to
 * download anything: the bytes travel over the connection DevHub already
 * holds (`neovimTerraform.ts`).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const NEOVIM_TARGETS = ["linux-x64", "linux-arm64"] as const;
export type NeovimTarget = (typeof NEOVIM_TARGETS)[number];

export interface NeovimTargetStatement {
	readonly file: string;
	readonly sha256: string;
	readonly topLevelDirectory: string;
	/** The newest glibc symbol version its `nvim` asks for: `2.17`. */
	readonly glibc: string;
}

export interface NeovimStatement {
	readonly version: string;
	readonly targets: Readonly<
		Partial<Record<NeovimTarget, NeovimTargetStatement>>
	>;
}

export function parseNeovimStatement(
	text: string,
): NeovimStatement | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record["version"] !== "string") return undefined;
	const raw = record["targets"];
	if (typeof raw !== "object" || raw === null) return undefined;
	const targets: Partial<Record<NeovimTarget, NeovimTargetStatement>> = {};
	for (const target of NEOVIM_TARGETS) {
		const entry = (raw as Record<string, unknown>)[target];
		if (entry === undefined) continue;
		if (typeof entry !== "object" || entry === null) return undefined;
		const fields = entry as Record<string, unknown>;
		for (const field of ["file", "sha256", "topLevelDirectory", "glibc"]) {
			if (typeof fields[field] !== "string") return undefined;
		}
		targets[target] = fields as unknown as NeovimTargetStatement;
	}
	return { version: record["version"], targets };
}

/** One target's tarball, verified against the statement. */
export interface NeovimTarball {
	readonly version: string;
	readonly bytes: Uint8Array;
	readonly sha256: string;
	readonly topLevelDirectory: string;
	readonly glibc: string;
}

/** Where a host's Neovim comes from, as terraforming needs it. */
export interface NeovimDelivery {
	/**
	 * What this DevHub carries, or the sentence for why it carries nothing —
	 * a source run that has not fetched them, a bundle packaged without.
	 */
	statement(): Promise<NeovimStatement | string>;
	tarball(target: NeovimTarget): Promise<NeovimTarball>;
}

export interface BundledNeovimDeliveryOptions {
	readonly directory: string;
	/** Which sentence tells the person what to do about a missing bundle. */
	readonly packaged: boolean;
}

export class BundledNeovimDelivery implements NeovimDelivery {
	readonly #options: BundledNeovimDeliveryOptions;
	#statement: Promise<NeovimStatement | string> | undefined;
	readonly #reading = new Map<NeovimTarget, Promise<NeovimTarball>>();

	constructor(options: BundledNeovimDeliveryOptions) {
		this.#options = options;
	}

	statement(): Promise<NeovimStatement | string> {
		this.#statement ??= this.#readStatement();
		return this.#statement;
	}

	async #readStatement(): Promise<NeovimStatement | string> {
		const path = join(this.#options.directory, "nvim.json");
		const text = await readFile(path, "utf8").catch(() => undefined);
		if (text === undefined)
			return `this DevHub carries no Neovim for Linux (${path} is missing). ${this.#remedy()}`;
		return (
			parseNeovimStatement(text) ??
			`${path} is not a statement of the Neovims this DevHub carries. ${this.#remedy()}`
		);
	}

	/** One read per target per DevHub start, however many hosts ask. */
	tarball(target: NeovimTarget): Promise<NeovimTarball> {
		const existing = this.#reading.get(target);
		if (existing) return existing;
		const pending = this.#read(target);
		pending.catch(() => {
			if (this.#reading.get(target) === pending) this.#reading.delete(target);
		});
		this.#reading.set(target, pending);
		return pending;
	}

	async #read(target: NeovimTarget): Promise<NeovimTarball> {
		const statement = await this.statement();
		if (typeof statement === "string") throw new Error(statement);
		const entry = statement.targets[target];
		if (entry === undefined) {
			throw new Error(
				`this DevHub carries no Neovim for ${target}. ${this.#remedy()}`,
			);
		}
		const path = join(this.#options.directory, entry.file);
		const bytes = await readFile(path).catch(() => undefined);
		if (bytes === undefined) {
			throw new Error(
				`${path} is missing although nvim.json names it. ${this.#remedy()}`,
			);
		}
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		if (sha256 !== entry.sha256) {
			throw new Error(
				`${path} hashes to ${sha256}, not the ${entry.sha256} nvim.json says. ${this.#remedy()}`,
			);
		}
		return {
			version: statement.version,
			bytes: new Uint8Array(bytes),
			sha256,
			topLevelDirectory: entry.topLevelDirectory,
			glibc: entry.glibc,
		};
	}

	#remedy(): string {
		return this.#options.packaged
			? "This DevHub was packaged without it; install a build that carries it."
			: "Fetch it in this checkout with scripts/build_nvim.py.";
	}
}

/** `2.17` against `2.14`: whether `have` is at least `need`. */
export function glibcAtLeast(have: string, need: string): boolean {
	const a = have.split(".").map((part) => Number.parseInt(part, 10));
	const b = need.split(".").map((part) => Number.parseInt(part, 10));
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const x = a[index] ?? 0;
		const y = b[index] ?? 0;
		if (Number.isNaN(x) || Number.isNaN(y)) return false;
		if (x !== y) return x > y;
	}
	return true;
}
