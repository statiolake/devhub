import { deflateRawSync, crc32 } from "node:zlib";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import {
	findColorTheme,
	listColorThemes,
	loadColorTheme,
} from "./colorThemeCatalog.js";
import {
	extractTheme,
	LIBRARY_MARKER,
	ThemeLibrary,
	ThemeRefused,
	workbenchVsix,
	type WorkbenchExtensions,
} from "./themeLibrary.js";
import {
	isSafeEntryName,
	writeZip,
	ZipArchive,
	ZipRefused,
} from "./zipArchive.js";

let root: string;
beforeEach(() => {
	root = makeScratchDir("theme-library");
});
afterEach(() => {
	removeScratchDir(root);
});

const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

function nordVsix(
	extra: Record<string, Buffer> = {},
	manifest: Record<string, unknown> = {},
): Buffer {
	return writeZip(
		Object.entries({
			"extension.vsixmanifest": Buffer.from("<PackageManifest/>"),
			"extension/package.json": json({
				name: "nord-visual-studio-code",
				publisher: "arcticicestudio",
				version: "0.19.0",
				displayName: "Nord",
				main: "./out/extension.js",
				activationEvents: ["*"],
				contributes: {
					themes: [
						{
							label: "Nord",
							uiTheme: "vs-dark",
							path: "./themes/nord-color-theme.json",
						},
					],
					commands: [{ command: "x", title: "X" }],
				},
				...manifest,
			}),
			"extension/themes/nord-color-theme.json": json({
				include: "./base.json",
				colors: { "editor.background": "#2e3440" },
				tokenColors: "./tokens.json",
			}),
			"extension/themes/base.json": json({ colors: { foreground: "#d8dee9" } }),
			"extension/themes/tokens.json": json({
				tokenColors: [
					{ scope: "comment", settings: { foreground: "#616e88" } },
				],
			}),
			"extension/LICENSE.md": Buffer.from("MIT"),
			"extension/out/extension.js": Buffer.from("process.exit(1)"),
			"extension/README.md": Buffer.from("# Nord"),
			...extra,
		}).map(([name, data]) => ({ name, data })),
	);
}

describe("reading a .vsix", () => {
	it("keeps only the theme: its files, includes, token files, licence and an inert manifest", () => {
		const theme = extractTheme(nordVsix());
		expect(theme.id).toBe("arcticicestudio.nord-visual-studio-code");
		expect([...theme.files.keys()].sort()).toEqual([
			"LICENSE.md",
			"package.json",
			"themes/base.json",
			"themes/nord-color-theme.json",
			"themes/tokens.json",
		]);
		const manifest = JSON.parse(
			theme.files.get("package.json")?.toString() ?? "{}",
		) as Record<string, unknown>;
		expect(manifest).not.toHaveProperty("main");
		expect(manifest).not.toHaveProperty("activationEvents");
		expect(manifest["contributes"]).toEqual({
			themes: [
				{
					label: "Nord",
					uiTheme: "vs-dark",
					path: "./themes/nord-color-theme.json",
				},
			],
		});
	});

	it("refuses an archive that contributes no theme, or is not one", () => {
		expect(() =>
			extractTheme(nordVsix({}, { contributes: { commands: [] } })),
		).toThrow(/contributes no colour theme/);
		expect(() =>
			extractTheme(Buffer.from("not a zip at all, honestly")),
		).toThrow(ThemeRefused);
		expect(() =>
			extractTheme(writeZip([{ name: "readme.txt", data: Buffer.from("x") }])),
		).toThrow(/no package.json/);
	});

	it("refuses a theme path or include that leaves the extension", () => {
		expect(() =>
			extractTheme(
				nordVsix(
					{},
					{
						contributes: {
							themes: [{ label: "Evil", path: "../../evil.json" }],
						},
					},
				),
			),
		).toThrow(/outside the extension/);
		expect(() =>
			extractTheme(
				nordVsix({
					"extension/themes/nord-color-theme.json": json({
						include: "../../../etc/x.json",
					}),
				}),
			),
		).toThrow(/outside the extension/);
	});

	it("refuses zip-slip names, oversized entries and size lies", () => {
		expect(isSafeEntryName("extension/../../x")).toBe(false);
		expect(isSafeEntryName("/etc/passwd")).toBe(false);
		expect(isSafeEntryName("C:/x")).toBe(false);
		expect(isSafeEntryName("a\\b")).toBe(false);
		expect(isSafeEntryName("extension/themes/a.json")).toBe(true);
		const slip = ZipArchive.open(
			writeZip([{ name: "../evil", data: Buffer.from("x") }]),
		);
		expect(() => slip.read(slip.entries[0]!)).toThrow(ZipRefused);

		const big = ZipArchive.open(nordVsix(), {
			maxEntries: 100,
			maxEntryBytes: 10,
			maxTotalBytes: 1_000_000,
		});
		expect(() => big.read(big.entry("extension/package.json")!)).toThrow(
			/more than 10/,
		);
		expect(() =>
			ZipArchive.open(nordVsix(), {
				maxEntries: 2,
				maxEntryBytes: 1e6,
				maxTotalBytes: 1e6,
			}),
		).toThrow(/more than 2/);

		// A deflated entry that inflates past the size it declares: a bomb.
		const payload = Buffer.alloc(100_000, 0x61);
		const archive = writeZip([
			{ name: "extension/package.json", data: payload },
		]);
		const deflated = deflateRawSync(payload);
		const bomb = rewriteAsDeflated(archive, deflated, 10, crc32(payload));
		const opened = ZipArchive.open(bomb);
		expect(() => opened.read(opened.entries[0]!)).toThrow(ZipRefused);
	});

	it("round-trips through the workbench's .vsix", () => {
		const theme = extractTheme(nordVsix());
		const again = extractTheme(workbenchVsix(theme));
		expect([...again.files.keys()].sort()).toEqual(
			[...theme.files.keys()].sort(),
		);
	});
});

/** One stored entry rewritten as deflated, with a declared size of `size`. */
function rewriteAsDeflated(
	archive: Buffer,
	deflated: Buffer,
	size: number,
	crc: number,
): Buffer {
	const name = archive.subarray(30, 30 + archive.readUInt16LE(26));
	const local = Buffer.alloc(30);
	archive.copy(local, 0, 0, 30);
	local.writeUInt16LE(8, 8);
	local.writeUInt32LE(crc >>> 0, 14);
	local.writeUInt32LE(deflated.length, 18);
	local.writeUInt32LE(size, 22);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(8, 10);
	central.writeUInt32LE(crc >>> 0, 16);
	central.writeUInt32LE(deflated.length, 20);
	central.writeUInt32LE(size, 24);
	central.writeUInt16LE(name.length, 28);
	central.writeUInt32LE(0, 42);
	const body = Buffer.concat([local, name, deflated]);
	const directory = Buffer.concat([central, name]);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(body.length, 16);
	return Buffer.concat([body, directory, end]);
}

describe("the library", () => {
	function workbench(fail = false) {
		const calls: string[] = [];
		const extensions: WorkbenchExtensions = {
			installVsix: (path) => {
				calls.push(
					`install ${String(existsSync(path))} ${path.endsWith(".vsix")}`,
				);
				// What VS Code would be given is the reduced copy.
				const theme = extractTheme(readFileSync(path));
				calls.push(`files ${[...theme.files.keys()].sort().join(",")}`);
				return fail
					? Promise.reject(new Error("the services are down"))
					: Promise.resolve();
			},
			uninstall: (id) => {
				calls.push(`uninstall ${id}`);
				return Promise.resolve();
			},
		};
		return { calls, extensions };
	}

	it("installs a theme the catalog then finds, into the workbench too, and uninstalls it", async () => {
		const library = new ThemeLibrary(join(root, "themes"), root);
		const { calls, extensions } = workbench();
		const { theme, workbenchProblem } = await library.install(
			nordVsix(),
			"open-vsx:test",
			extensions,
		);
		expect(workbenchProblem).toBeUndefined();
		expect(theme).toMatchObject({
			id: "arcticicestudio.nord-visual-studio-code",
			version: "0.19.0",
			inWorkbench: true,
			themes: [{ name: "Nord", type: "vs-dark" }],
		});
		expect(calls[0]).toBe("install true true");
		expect(calls[1]).toBe(
			"files LICENSE.md,package.json,themes/base.json,themes/nord-color-theme.json,themes/tokens.json",
		);
		expect(existsSync(join(theme.directory, "out"))).toBe(false);
		expect(existsSync(join(theme.directory, LIBRARY_MARKER))).toBe(true);
		// No staging directory is left behind.
		expect(readdirSync(join(root, "themes"))).toEqual([
			"arcticicestudio.nord-visual-studio-code-0.19.0",
		]);

		const entries = listColorThemes({
			builtin: undefined,
			user: undefined,
			devhub: join(root, "themes"),
		});
		const nord = findColorTheme(entries, "Nord");
		expect(nord).toBeDefined();
		const definition = loadColorTheme(nord!);
		expect(definition.colors).toEqual({
			foreground: "#d8dee9",
			"editor.background": "#2e3440",
		});
		expect(definition.tokenColors).toEqual([
			{ scopes: ["comment"], foreground: "#616e88" },
		]);

		await library.uninstall(
			"arcticicestudio.nord-visual-studio-code",
			extensions,
		);
		expect(calls.at(-1)).toBe(
			"uninstall arcticicestudio.nord-visual-studio-code",
		);
		expect(await library.list()).toEqual([]);
	});

	it("keeps DevHub's copy and says why when the workbench install fails", async () => {
		const library = new ThemeLibrary(join(root, "themes"), root);
		const { extensions } = workbench(true);
		const { theme, workbenchProblem } = await library.install(
			nordVsix(),
			"open-vsx:test",
			extensions,
		);
		expect(workbenchProblem).toBe("the services are down");
		expect(theme.inWorkbench).toBe(false);
	});

	it("replaces an older version, and leaves nothing when the archive is refused", async () => {
		const library = new ThemeLibrary(join(root, "themes"), root);
		await library.install(nordVsix({}, { version: "0.18.0" }), "x", undefined);
		await library.install(nordVsix(), "x", undefined);
		expect((await library.list()).map((theme) => theme.version)).toEqual([
			"0.19.0",
		]);
		await expect(
			library.install(Buffer.from("junk"), "x", undefined),
		).rejects.toThrow(ThemeRefused);
		expect(readdirSync(join(root, "themes"))).toHaveLength(1);
	});
});
