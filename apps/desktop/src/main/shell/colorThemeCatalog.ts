/**
 * The colour themes this DevHub can wear, and reading one.
 *
 * A theme is contributed by an extension — `contributes.themes` in its
 * `package.json` — exactly as VS Code finds it: the built-in extensions
 * (`theme-defaults` and the rest, where the running VS Code's
 * `builtinExtensionsPath` says) and the ones the person installed into
 * DevHub's extensions directory (`extensionsPath`). A theme is named the way
 * VS Code names it in `workbench.colorTheme` — its `id`, or its label when it
 * has none — and DevHub also accepts the label it shows in the theme picker.
 *
 * Reading follows `colorThemeData.ts#_loadColorTheme`: the file is JSON with
 * comments, an `include` is read first and the including file's colours win,
 * and a colour written as `"default"` is taken back out. A TextMate
 * (`.tmTheme`) theme carries no workbench colours DevHub reads, so it
 * contributes only its type — every colour is then the registry's default.
 *
 * Synchronous on purpose. It runs before the window exists, because the
 * window is created in the theme's colours, and it reads a few hundred small
 * files at most.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import {
	themeTypeOfUiTheme,
	type ColorThemeDefinition,
} from "../../model/colorTheme.js";

/** Where extensions are, as the running VS Code says. */
export interface ExtensionRoots {
	/** The built-in extensions: every directory in it is one. */
	readonly builtin: string | undefined;
	/** The person's own: `<publisher>.<name>-<version>` directories. */
	readonly user: string | undefined;
}

/** One `contributes.themes` entry, found. */
export interface ColorThemeEntry {
	readonly settingsId: string;
	readonly label: string;
	readonly id: string | undefined;
	readonly uiTheme: unknown;
	/** The theme file, absolute. */
	readonly path: string;
	readonly extension: string;
}

/**
 * JSON with comments and trailing commas, as VS Code's own parser reads a
 * theme. A file that is not that is `undefined`.
 */
export function parseJsonc(text: string): unknown {
	let out = "";
	let index = 0;
	const length = text.length;
	while (index < length) {
		const char = text[index];
		if (char === '"') {
			const start = index;
			index += 1;
			while (index < length && text[index] !== '"') {
				index += text[index] === "\\" ? 2 : 1;
			}
			index += 1;
			out += text.slice(start, index);
		} else if (char === "/" && text[index + 1] === "/") {
			while (index < length && text[index] !== "\n") index += 1;
		} else if (char === "/" && text[index + 1] === "*") {
			const end = text.indexOf("*/", index + 2);
			index = end < 0 ? length : end + 2;
		} else {
			out += char;
			index += 1;
		}
	}
	// Trailing commas, now that no comment or string can hide one.
	const cleaned = removeTrailingCommas(out);
	try {
		return JSON.parse(cleaned) as unknown;
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function removeTrailingCommas(text: string): string {
	let out = "";
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		if (char === '"') {
			const start = index;
			index += 1;
			while (index < text.length && text[index] !== '"') {
				index += text[index] === "\\" ? 2 : 1;
			}
			index += 1;
			out += text.slice(start, index);
			continue;
		}
		if (char === ",") {
			let next = index + 1;
			while (next < text.length && /\s/.test(text[next] ?? "")) next += 1;
			if (text[next] === "}" || text[next] === "]") {
				index += 1;
				continue;
			}
		}
		out += char;
		index += 1;
	}
	return out;
}

function readJson(path: string): unknown {
	try {
		return parseJsonc(readFileSync(path, "utf8"));
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

function isMissing(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES";
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** A `%key%` label, through the extension's `package.nls.json`. */
function localized(
	value: unknown,
	nls: () => Record<string, unknown> | undefined,
): string | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^%(.+)%$/.exec(value);
	if (!match) return value;
	const entry = nls()?.[match[1] ?? ""];
	if (typeof entry === "string") return entry;
	const message = record(entry)?.["message"];
	return typeof message === "string" ? message : value;
}

function themesOf(directory: string): ColorThemeEntry[] {
	const manifest = record(readJson(join(directory, "package.json")));
	const themes = record(manifest?.["contributes"])?.["themes"];
	if (!manifest || !Array.isArray(themes)) return [];
	let nlsTable: Record<string, unknown> | undefined | null = null;
	const nls = (): Record<string, unknown> | undefined => {
		if (nlsTable === null) {
			nlsTable = record(readJson(join(directory, "package.nls.json")));
		}
		return nlsTable;
	};
	const extension = `${String(manifest["publisher"])}.${String(manifest["name"])}`;
	const entries: ColorThemeEntry[] = [];
	for (const theme of themes) {
		const fields = record(theme);
		const path = fields?.["path"];
		if (!fields || typeof path !== "string") continue;
		const label =
			localized(fields["label"], nls) ??
			path.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
		const id = typeof fields["id"] === "string" ? fields["id"] : undefined;
		entries.push({
			settingsId: id ?? label,
			label,
			id,
			uiTheme: fields["uiTheme"],
			path: resolve(directory, path),
			extension,
		});
	}
	return entries;
}

function subdirectories(root: string | undefined): string[] {
	if (root === undefined || !existsSync(root)) return [];
	return readdirSync(root)
		.filter((name) => !name.startsWith("."))
		.map((name) => join(root, name))
		.filter((path) => {
			try {
				return statSync(path).isDirectory();
			} catch (error) {
				if (isMissing(error)) return false;
				throw error;
			}
		});
}

/** `1.10.0` after `1.9.3`, as far as a directory name says. */
function compareVersions(a: string, b: string): number {
	const parts = (text: string): number[] =>
		text.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
	const left = parts(a);
	const right = parts(b);
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const delta = (left[index] ?? 0) - (right[index] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}

/**
 * The person's extension directories that are live: not marked removed in
 * `.obsolete`, and the newest version of each when several are on disk.
 */
function userExtensionDirectories(root: string | undefined): string[] {
	if (root === undefined) return [];
	const obsolete = record(readJson(join(root, ".obsolete"))) ?? {};
	const newest = new Map<string, { version: string; path: string }>();
	for (const path of subdirectories(root)) {
		const name = path.slice(root.length + 1);
		if (obsolete[name] === true) continue;
		const match = /^(.*?)-(\d[\w.-]*)$/.exec(name);
		const key = (match?.[1] ?? name).toLowerCase();
		const version = match?.[2] ?? "0";
		const seen = newest.get(key);
		if (!seen || compareVersions(version, seen.version) > 0) {
			newest.set(key, { version, path });
		}
	}
	return [...newest.values()].map(({ path }) => path);
}

/** Every theme contributed under these roots, built-ins first. */
export function listColorThemes(roots: ExtensionRoots): ColorThemeEntry[] {
	return [
		...subdirectories(roots.builtin),
		...userExtensionDirectories(roots.user),
	].flatMap(themesOf);
}

/**
 * The theme a setting names: by what `workbench.colorTheme` would say, then by
 * the label the picker shows, then by its bare `id`; and, failing those, the
 * same ignoring case.
 */
export function findColorTheme(
	entries: readonly ColorThemeEntry[],
	name: string,
): ColorThemeEntry | undefined {
	const exact =
		entries.find((entry) => entry.settingsId === name) ??
		entries.find((entry) => entry.label === name) ??
		entries.find((entry) => entry.id === name);
	if (exact) return exact;
	const folded = name.toLowerCase();
	return entries.find(
		(entry) =>
			entry.settingsId.toLowerCase() === folded ||
			entry.label.toLowerCase() === folded,
	);
}

/** Why a theme file could not be read, for the person. */
export class ColorThemeUnreadable extends Error {}

/** How deep `include` may go before it is a loop. */
const MAX_INCLUDE_DEPTH = 16;

function collectColors(
	path: string,
	into: Record<string, string>,
	depth: number,
): void {
	if (depth > MAX_INCLUDE_DEPTH) {
		throw new ColorThemeUnreadable(
			`${path}: its includes go deeper than ${String(MAX_INCLUDE_DEPTH)} files.`,
		);
	}
	if (extname(path).toLowerCase() !== ".json") return;
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (isMissing(error)) {
			throw new ColorThemeUnreadable(`${path} could not be read.`);
		}
		throw error;
	}
	const document = record(parseJsonc(text));
	if (!document) {
		throw new ColorThemeUnreadable(`${path} is not a JSON theme.`);
	}
	const include = document["include"];
	if (typeof include === "string") {
		collectColors(resolve(dirname(path), include), into, depth + 1);
	}
	const colors = document["colors"];
	if (colors === undefined) return;
	const table = record(colors);
	if (!table) {
		throw new ColorThemeUnreadable(`${path}: 'colors' is not an object.`);
	}
	for (const [id, value] of Object.entries(table)) {
		if (value === "default") {
			// The theme's own "use the default": an included file's value goes.
			delete into[id];
		} else if (typeof value === "string") {
			into[id] = value;
		}
	}
}

/** The theme's type and colours, with its includes folded in. */
export function loadColorTheme(entry: ColorThemeEntry): ColorThemeDefinition {
	const colors: Record<string, string> = {};
	collectColors(entry.path, colors, 0);
	return {
		settingsId: entry.settingsId,
		label: entry.label,
		type: themeTypeOfUiTheme(entry.uiTheme),
		colors,
	};
}
