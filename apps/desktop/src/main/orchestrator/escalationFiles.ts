/**
 * An escalation's pictures, kept with it.
 *
 * The orchestrator points at a screenshot or an SVG an agent made — often in
 * some other worktree, which may be gone by the time the person reads it. So
 * when an escalation is raised or asked again (`escalation new` / `ask`),
 * every local image the body names — `![…](path)`, `#![…](path)`, in prose
 * or in a table cell — is copied into the escalation's own folder,
 * `<userData>/devhub/escalations/<id>/`, and the reference is rewritten to
 * the copy, with the original path kept in the alt text.
 *
 * Only files under an allowed folder are taken (the open Workspaces, the
 * orchestrator's root — symlinks followed), each at most `MAX_FILE` and all
 * of one body at most `MAX_TOTAL`. A reference that breaks a rule refuses the
 * whole body, with the reason, so the orchestrator can fix it rather than
 * the person finding a hole. Code (fenced or inline) is left alone, and so
 * are URLs and files already in an escalation's folder.
 */

import { copyFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

/** A file and a body's files, at most. */
export const MAX_FILE = 10 * 1024 * 1024;
export const MAX_TOTAL = 25 * 1024 * 1024;

/** What is taken in: pictures, SVG included. */
const IMAGE_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".avif",
	".bmp",
	".svg",
]);

export class EscalationFileError extends Error {
	override readonly name = "EscalationFileError";
}

export interface ImportPlace {
	/** `<userData>/devhub/escalations`: each escalation's folder is under it. */
	readonly storeRoot: string;
	readonly id: number;
	/** What a relative path is relative to; absent, a relative path is refused. */
	readonly baseDir: string | undefined;
	/** The folders a file may be taken from. */
	readonly allowedRoots: readonly string[];
	readonly home?: string;
	readonly maxFile?: number;
	readonly maxTotal?: number;
}

export interface Imported {
	readonly markdown: string;
	/** Each file taken: where from, where to. */
	readonly files: readonly { readonly from: string; readonly to: string }[];
}

/** `![alt](target "title")`, `#` before it or not. Not across lines. */
const IMAGE =
	/(#?)!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^\s)]+)(\s+"[^"\n]*")?\s*\)/gu;

function isLocal(target: string): boolean {
	return (
		target !== "" &&
		!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target) &&
		!target.startsWith("//") &&
		!target.startsWith("#")
	);
}

function extensionOf(path: string): string {
	const name = basename(path);
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

function inside(path: string, root: string): boolean {
	return (
		path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
	);
}

function realOrUndefined(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** The stretches of `markdown` that are code: fences and inline spans. */
function codeRanges(markdown: string): readonly [number, number][] {
	const ranges: [number, number][] = [];
	const fence =
		/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gmu;
	for (const match of markdown.matchAll(fence))
		ranges.push([match.index, match.index + match[0].length]);
	const inline = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu;
	for (const match of markdown.matchAll(inline)) {
		const at = match.index;
		if (!ranges.some(([from, to]) => at >= from && at < to))
			ranges.push([at, at + match[0].length]);
	}
	return ranges;
}

/** A name for the copy: its index, and the original's name made safe. */
function copyName(index: number, from: string): string {
	const safe = basename(from)
		.replace(/[^\p{L}\p{N}._-]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	return `${String(index + 1)}-${safe === "" ? "image" : safe}`;
}

/**
 * Copy the local images `markdown` names into the escalation's folder and
 * point the references at the copies. Throws `EscalationFileError`, naming
 * the reference, when one is outside the allowed folders, not there, or too
 * large; nothing is copied then.
 */
export function importEscalationFiles(
	markdown: string,
	place: ImportPlace,
): Imported {
	const home = place.home ?? homedir();
	const maxFile = place.maxFile ?? MAX_FILE;
	const maxTotal = place.maxTotal ?? MAX_TOTAL;
	const storeRoot =
		realOrUndefined(place.storeRoot) ?? resolve(place.storeRoot);
	const roots = place.allowedRoots
		.map(realOrUndefined)
		.filter((root): root is string => root !== undefined);
	const code = codeRanges(markdown);
	const plan: {
		readonly start: number;
		readonly end: number;
		readonly hash: string;
		readonly alt: string;
		readonly title: string;
		readonly shown: string;
		readonly real: string;
	}[] = [];
	for (const match of markdown.matchAll(IMAGE)) {
		const at = match.index;
		if (code.some(([from, to]) => at >= from && at < to)) continue;
		const raw = match[3]!;
		const target = raw.startsWith("<") ? raw.slice(1, -1) : raw;
		if (!isLocal(target)) continue;
		let path: string;
		try {
			path = decodeURI(target);
		} catch {
			path = target;
		}
		if (!IMAGE_EXTENSIONS.has(extensionOf(path))) continue;
		const absolute =
			path === "~" || path.startsWith("~/")
				? join(home, path.slice(1))
				: isAbsolute(path)
					? path
					: place.baseDir === undefined
						? undefined
						: resolve(place.baseDir, path);
		if (absolute === undefined)
			throw new EscalationFileError(
				`${path} is relative, and the escalation names no workspace or agent it is relative to: give an absolute path.`,
			);
		const real = realOrUndefined(absolute);
		if (real === undefined)
			throw new EscalationFileError(`${path} is not there (${absolute}).`);
		// Already one of an escalation's own: nothing to take.
		if (inside(real, storeRoot)) continue;
		if (!roots.some((root) => inside(real, root)))
			throw new EscalationFileError(
				`${path} is outside the open workspaces and the orchestrator's folder: it is not taken into the escalation.`,
			);
		plan.push({
			start: at,
			end: at + match[0].length,
			hash: match[1]!,
			alt: match[2]!,
			title: match[4] ?? "",
			shown: path,
			real,
		});
	}
	if (plan.length === 0) return { markdown, files: [] };

	const sources = [...new Set(plan.map((one) => one.real))];
	let total = 0;
	for (const source of sources) {
		const info = statSync(source);
		if (!info.isFile())
			throw new EscalationFileError(`${source} is not a file.`);
		if (info.size > maxFile)
			throw new EscalationFileError(
				`${source} is ${megabytes(info.size)}; an escalation takes files of at most ${megabytes(maxFile)}.`,
			);
		total += info.size;
	}
	if (total > maxTotal)
		throw new EscalationFileError(
			`the images come to ${megabytes(total)}; an escalation takes at most ${megabytes(maxTotal)} of them.`,
		);

	const folder = join(place.storeRoot, String(place.id));
	mkdirSync(folder, { recursive: true });
	const taken = new Map<string, string>();
	const existing = new Set<string>();
	for (const source of sources) {
		let index = 0;
		let to = join(folder, copyName(index, source));
		while (existing.has(to) || exists(to)) {
			index += 1;
			to = join(folder, copyName(index, source));
		}
		existing.add(to);
		copyFileSync(source, to);
		taken.set(source, to);
	}

	let out = "";
	let last = 0;
	for (const one of plan) {
		const to = taken.get(one.real)!;
		const alt = one.alt.trim() === "" ? one.shown : `${one.alt} (${one.shown})`;
		out +=
			markdown.slice(last, one.start) +
			`${one.hash}![${alt.replace(/[[\]]/gu, "")}](<${to}>${one.title})`;
		last = one.end;
	}
	out += markdown.slice(last);
	return {
		markdown: out,
		files: sources.map((from) => ({ from, to: taken.get(from)! })),
	};
}

function exists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
