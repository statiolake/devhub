/**
 * DevHub's own colour theme library: themes from Open VSX, installed for
 * DevHub without going through VS Code.
 *
 * `<userData>/devhub/themes/<publisher>.<name>-<version>/` holds one theme
 * extension each, and only what a colour theme is made of: a `package.json`
 * reduced to its `contributes.themes` (no `main`, no activation, no other
 * contribution — nothing in it can run), the theme files those name with
 * every file they `include` or take `tokenColors` from, the
 * `package.nls.json` its labels are translated through, and its licence.
 * Everything else in the `.vsix` is not extracted. `colorThemeCatalog.ts`
 * finds the themes there beside the built-in and installed ones.
 *
 * **The workbench wears it too.** A workbench is told the theme's name
 * (`workbenchManagedSettings.ts`), and a name its own catalog does not have
 * falls back to VS Code's default once its extensions are registered. So the
 * library's copy is also installed into the workbench's extensions, through
 * VS Code's own install-from-VSIX (`extensionCommands.ts`, the same path as
 * `devhub --install-extension x.vsix`): DevHub writes a `.vsix` of exactly
 * the files it extracted (`workbenchVsix`) and hands it to the extension
 * management service, so what VS Code installs is the reduced, inert copy and
 * not the archive that was downloaded. Uninstalling removes both.
 */

import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { parseJsonc } from "./colorThemeCatalog.js";
import {
	DEFAULT_ZIP_LIMITS,
	writeZip,
	ZipArchive,
	ZipRefused,
	type ZipLimits,
} from "./zipArchive.js";

/** Where DevHub's own themes are. */
export function themeLibraryDirectory(userDataPath: string): string {
	return join(userDataPath, "devhub", "themes");
}

/** Written beside each theme: where it came from. */
export const LIBRARY_MARKER = ".devhub-theme.json";

export interface LibraryTheme {
	/** `publisher.name`, as VS Code identifies the extension. */
	readonly id: string;
	readonly version: string;
	readonly displayName: string;
	/** The directory, absolute. */
	readonly directory: string;
	/** What each contributed theme is called in the settings. */
	readonly themes: readonly { readonly name: string; readonly type: string }[];
	/** Whether the workbench copy was installed. */
	readonly inWorkbench: boolean;
}

/** The archive is not a colour theme DevHub will install. */
export class ThemeRefused extends Error {}

const ID_PART = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
const LICENSE = /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i;
const MAX_THEMES = 64;

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** A path a manifest names, inside `extension/`, or nothing if it leaves. */
function inside(base: string, relative: string): string | undefined {
	if (relative.includes("\\") || relative.includes("\0")) return undefined;
	const joined = posix.normalize(posix.join(base, relative));
	return joined.startsWith("extension/") && !joined.includes("/../")
		? joined
		: undefined;
}

export interface ExtractedTheme {
	readonly id: string;
	readonly version: string;
	readonly displayName: string;
	/** Relative path under the theme's directory → bytes. */
	readonly files: ReadonlyMap<string, Buffer>;
}

/**
 * The theme in a `.vsix`, reduced to what DevHub keeps. Throws `ThemeRefused`
 * with a sentence for anything it will not install: not a zip, no
 * `extension/package.json`, no `contributes.themes`, a theme file that is
 * missing or is not JSON, a path outside the extension, a size over the caps.
 */
export function extractTheme(
	vsix: Buffer,
	limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): ExtractedTheme {
	let archive: ZipArchive;
	try {
		archive = ZipArchive.open(vsix, limits);
	} catch (error) {
		throw refusal(error);
	}
	const read = (name: string): Buffer | undefined => {
		const entry = archive.entry(name);
		if (!entry) return undefined;
		try {
			return archive.read(entry);
		} catch (error) {
			throw refusal(error);
		}
	};
	const manifestBytes = read("extension/package.json");
	if (!manifestBytes) {
		throw new ThemeRefused(
			"It is not a VS Code extension: it has no package.json.",
		);
	}
	const manifest = record(parseJsonc(manifestBytes.toString("utf8")));
	if (!manifest) throw new ThemeRefused("Its package.json is not JSON.");
	const publisher = manifest["publisher"];
	const name = manifest["name"];
	const version = manifest["version"];
	if (
		typeof publisher !== "string" ||
		typeof name !== "string" ||
		typeof version !== "string" ||
		!ID_PART.test(publisher) ||
		!ID_PART.test(name) ||
		!VERSION.test(version)
	) {
		throw new ThemeRefused(
			"Its package.json does not name a publisher, a name and a version.",
		);
	}
	const themes = record(manifest["contributes"])?.["themes"];
	if (!Array.isArray(themes) || themes.length === 0) {
		throw new ThemeRefused(
			`${publisher}.${name} contributes no colour theme (contributes.themes).`,
		);
	}
	if (themes.length > MAX_THEMES) {
		throw new ThemeRefused(`${publisher}.${name} contributes too many themes.`);
	}
	const files = new Map<string, Buffer>();
	const keptThemes: Record<string, unknown>[] = [];
	// A theme file and everything it reaches through `include` and a
	// `tokenColors` path: all JSON, all inside the extension.
	const take = (path: string, depth: number): void => {
		if (files.has(path)) return;
		if (depth > 16)
			throw new ThemeRefused(`${path}: its includes go too deep.`);
		if (!path.toLowerCase().endsWith(".json")) {
			throw new ThemeRefused(
				`${path.slice("extension/".length)} is not a JSON theme; DevHub installs JSON colour themes only.`,
			);
		}
		const bytes = read(path);
		if (!bytes) {
			throw new ThemeRefused(
				`${path.slice("extension/".length)} is missing from it.`,
			);
		}
		const document = record(parseJsonc(bytes.toString("utf8")));
		if (!document) {
			throw new ThemeRefused(`${path.slice("extension/".length)} is not JSON.`);
		}
		files.set(path, bytes);
		for (const reference of [document["include"], document["tokenColors"]]) {
			if (typeof reference !== "string") continue;
			const target = inside(posix.dirname(path), reference);
			if (!target) {
				throw new ThemeRefused(
					`${path.slice("extension/".length)} names a file outside the extension.`,
				);
			}
			take(target, depth + 1);
		}
	};
	for (const theme of themes) {
		const fields = record(theme);
		const path = fields?.["path"];
		if (!fields || typeof path !== "string") continue;
		const target = inside("extension", path);
		if (!target) {
			throw new ThemeRefused(
				`A theme's path (${path}) is outside the extension.`,
			);
		}
		take(target, 0);
		keptThemes.push({
			...(typeof fields["id"] === "string" ? { id: fields["id"] } : {}),
			...(fields["label"] !== undefined ? { label: fields["label"] } : {}),
			...(typeof fields["uiTheme"] === "string"
				? { uiTheme: fields["uiTheme"] }
				: {}),
			path: `./${target.slice("extension/".length)}`,
		});
	}
	if (keptThemes.length === 0) {
		throw new ThemeRefused(`${publisher}.${name} names no theme file.`);
	}
	const nls = read("extension/package.nls.json");
	if (nls && record(parseJsonc(nls.toString("utf8")))) {
		files.set("extension/package.nls.json", nls);
	}
	for (const entry of archive.entries) {
		const base = entry.name.slice("extension/".length);
		if (entry.name.startsWith("extension/") && LICENSE.test(base)) {
			const bytes = read(entry.name);
			if (bytes) files.set(entry.name, bytes);
		}
	}
	const displayName =
		typeof manifest["displayName"] === "string" &&
		!manifest["displayName"].startsWith("%")
			? manifest["displayName"]
			: name;
	const reduced = {
		name,
		publisher,
		version,
		displayName,
		...(typeof manifest["description"] === "string"
			? { description: manifest["description"] }
			: {}),
		...(typeof manifest["license"] === "string"
			? { license: manifest["license"] }
			: {}),
		engines: { vscode: "*" },
		categories: ["Themes"],
		contributes: { themes: keptThemes },
	};
	const out = new Map<string, Buffer>();
	out.set("package.json", Buffer.from(`${JSON.stringify(reduced, null, 2)}\n`));
	for (const [path, bytes] of files) {
		out.set(path.slice("extension/".length), bytes);
	}
	return { id: `${publisher}.${name}`, version, displayName, files: out };
}

function refusal(error: unknown): Error {
	if (error instanceof ZipRefused) {
		return new ThemeRefused(
			`The download is not a theme DevHub will install: ${error.message}.`,
		);
	}
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * A `.vsix` of exactly these files, under `extension/` as VS Code's
 * installer reads one.
 */
export function workbenchVsix(theme: ExtractedTheme): Buffer {
	return writeZip(
		[...theme.files].map(([path, data]) => ({
			name: `extension/${path}`,
			data,
		})),
	);
}

/** What installing into, and removing from, the workbench needs. */
export interface WorkbenchExtensions {
	installVsix(path: string): Promise<void>;
	uninstall(id: string): Promise<void>;
}

export class ThemeLibrary {
	constructor(
		readonly directory: string,
		private readonly scratch: string,
	) {}

	/** What is installed, newest version of each. */
	async list(): Promise<readonly LibraryTheme[]> {
		let names: string[];
		try {
			names = await readdir(this.directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const themes: LibraryTheme[] = [];
		for (const name of names.sort()) {
			if (name.startsWith(".")) continue;
			const directory = join(this.directory, name);
			const manifest = record(
				parseJsonc(
					await readFile(join(directory, "package.json"), "utf8").catch(
						() => "",
					),
				),
			);
			if (!manifest) continue;
			const marker = record(
				parseJsonc(
					await readFile(join(directory, LIBRARY_MARKER), "utf8").catch(
						() => "",
					),
				),
			);
			const contributed = record(manifest["contributes"])?.["themes"];
			themes.push({
				id: `${String(manifest["publisher"])}.${String(manifest["name"])}`,
				version: String(manifest["version"]),
				displayName: String(manifest["displayName"] ?? manifest["name"]),
				directory,
				themes: (Array.isArray(contributed) ? contributed : []).flatMap(
					(theme) => {
						const fields = record(theme);
						if (!fields) return [];
						const label =
							typeof fields["label"] === "string" ? fields["label"] : undefined;
						const id =
							typeof fields["id"] === "string" ? fields["id"] : undefined;
						const named = id ?? label;
						return named === undefined
							? []
							: [{ name: named, type: String(fields["uiTheme"] ?? "vs-dark") }];
					},
				),
				inWorkbench: marker?.["workbench"] === true,
			});
		}
		return themes;
	}

	/**
	 * Install a theme from its `.vsix`: extracted, written to a directory
	 * beside its final one and renamed into place (so the catalog never sees
	 * half of it), every other version of it removed, then installed into the
	 * workbench. A workbench install that fails leaves DevHub's copy, says so,
	 * and the shell and terminals still wear it.
	 */
	async install(
		vsix: Buffer,
		source: string,
		workbench: WorkbenchExtensions | undefined,
	): Promise<{
		readonly theme: LibraryTheme;
		readonly workbenchProblem?: string;
	}> {
		const extracted = extractTheme(vsix);
		await mkdir(this.directory, { recursive: true });
		const final = join(this.directory, `${extracted.id}-${extracted.version}`);
		const staging = await mkdtemp(join(this.directory, ".install-"));
		let workbenchProblem: string | undefined;
		try {
			for (const [path, bytes] of extracted.files) {
				const target = join(staging, path);
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, bytes);
			}
			let inWorkbench = false;
			if (workbench) {
				const vsixPath = join(
					await mkdtemp(join(this.scratch, "devhub-theme-")),
					`${extracted.id}-${extracted.version}.vsix`,
				);
				try {
					await writeFile(vsixPath, workbenchVsix(extracted));
					await workbench.installVsix(vsixPath);
					inWorkbench = true;
				} catch (error) {
					workbenchProblem =
						error instanceof Error ? error.message : String(error);
				} finally {
					await rm(dirname(vsixPath), { recursive: true, force: true });
				}
			}
			await writeFile(
				join(staging, LIBRARY_MARKER),
				`${JSON.stringify({ source, workbench: inWorkbench }, null, 2)}\n`,
			);
			await this.removeVersions(extracted.id);
			await rename(staging, final);
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
		const theme = (await this.list()).find((item) => item.directory === final);
		if (!theme) throw new Error(`${final} was installed and is not listed.`);
		return workbenchProblem === undefined
			? { theme }
			: { theme, workbenchProblem };
	}

	/** Remove a theme from the library, and from the workbench if it is there. */
	async uninstall(
		id: string,
		workbench: WorkbenchExtensions | undefined,
	): Promise<{ readonly workbenchProblem?: string }> {
		const installed = (await this.list()).filter(
			(theme) => theme.id.toLowerCase() === id.toLowerCase(),
		);
		if (installed.length === 0) {
			throw new Error(`No theme ${id} is installed in DevHub.`);
		}
		let workbenchProblem: string | undefined;
		if (workbench && installed.some((theme) => theme.inWorkbench)) {
			try {
				await workbench.uninstall(id);
			} catch (error) {
				workbenchProblem =
					error instanceof Error ? error.message : String(error);
			}
		}
		await this.removeVersions(id);
		return workbenchProblem === undefined ? {} : { workbenchProblem };
	}

	private async removeVersions(id: string): Promise<void> {
		if (!existsSync(this.directory)) return;
		const prefix = `${id.toLowerCase()}-`;
		for (const name of await readdir(this.directory)) {
			const lower = name.toLowerCase();
			if (lower.startsWith(prefix) && /^\d/.test(lower.slice(prefix.length))) {
				await rm(join(this.directory, name), { recursive: true, force: true });
			}
		}
	}
}
