import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveNLSConfiguration } from "code-oss-dev/out/vs/base/node/nls.js";

// A language pack is translated once into the build's own message table and
// cached under `<userData>/clp`. The compiled workbench looks a message up by
// its index in that table, and DevHub's `commit` is the VS Code submodule's: it
// stays the same while patches/vscode/ add or drop `localize` calls. These
// tests hold the cache to the table it was made from — see
// patches/vscode/0009-a-language-pack-is-cached-per-message-table.patch.

const COMMIT = "a44adf7f53e00964ab890f9f8758a334f1fc15bc";

/** A build's message table, as `nls.keys.json` and `nls.messages.json` state it. */
type Build = { keys: Array<[string, string[]]>; messages: string[] };

const TRUST_MODULE = "vs/workbench/contrib/terminal/browser/terminalInstance";

const BEFORE: Build = {
	keys: [[TRUST_MODULE, ["terminal.requestTrust", "terminalHelpAriaLabel"]]],
	messages: [
		"Creating a terminal process requires executing code",
		"Use {0} for terminal accessibility help",
	],
};

// The next build adds a `localize` call ahead of the trust request, the way
// patches/vscode/0005 did, so every index after it moves up by one.
const AFTER: Build = {
	keys: [
		[
			TRUST_MODULE,
			[
				"devhub.terminal.launchFailed",
				"terminal.requestTrust",
				"terminalHelpAriaLabel",
			],
		],
	],
	messages: ["Press any key to close the terminal.", ...BEFORE.messages],
};

const JAPANESE = {
	contents: {
		[TRUST_MODULE]: {
			"terminal.requestTrust":
				"ターミナル プロセスを作成するには、コードを実行する必要があります",
			terminalHelpAriaLabel: "ターミナル ユーザー補助のヘルプに {0} を使用する",
		},
	},
};

let scratch: string;
let userDataPath: string;
let savedDev: string | undefined;

beforeEach(async () => {
	// A source run turns language packs off altogether.
	savedDev = process.env["VSCODE_DEV"];
	delete process.env["VSCODE_DEV"];

	scratch = await mkdtemp(join(tmpdir(), "devhub-nls-"));
	userDataPath = join(scratch, "user-data");
	await mkdir(userDataPath);
	const pack = join(scratch, "ja.i18n.json");
	await writeFile(pack, JSON.stringify(JAPANESE));
	await writeFile(
		join(userDataPath, "languagepacks.json"),
		JSON.stringify({
			ja: { hash: "pack-hash", translations: { vscode: pack } },
		}),
	);
});

afterEach(async () => {
	if (savedDev !== undefined) process.env["VSCODE_DEV"] = savedDev;
	await rm(scratch, { recursive: true, force: true });
});

async function writeBuild(name: string, build: Build): Promise<string> {
	const dir = join(scratch, name);
	await mkdir(dir);
	await writeFile(join(dir, "nls.keys.json"), JSON.stringify(build.keys));
	await writeFile(
		join(dir, "nls.messages.json"),
		JSON.stringify(build.messages),
	);
	return dir;
}

/** What the workbench of the build at `nlsMetadataPath` would read. */
async function translatedTable(nlsMetadataPath: string): Promise<{
	file: string;
	messages: string[];
}> {
	const config = await resolveNLSConfiguration({
		userLocale: "ja",
		osLocale: "ja",
		commit: COMMIT,
		userDataPath,
		nlsMetadataPath,
	});
	const file = config.languagePack?.messagesFile;
	if (!file) throw new Error("the language pack was not used");
	return { file, messages: JSON.parse(await readFile(file, "utf-8")) };
}

describe("the translated message table a language pack is cached as", () => {
	it("is made again for a build whose table moved under the same commit", async () => {
		await translatedTable(await writeBuild("before", BEFORE));

		const after = await translatedTable(await writeBuild("after", AFTER));

		// Reusing the first table would put the accessibility hint where the
		// trust request belongs, and the trust request where the new message is.
		expect(after.messages).toEqual([
			"Press any key to close the terminal.",
			JAPANESE.contents[TRUST_MODULE]["terminal.requestTrust"],
			JAPANESE.contents[TRUST_MODULE].terminalHelpAriaLabel,
		]);
	});

	it("is made again when only an English fallback changed", async () => {
		const before = await translatedTable(await writeBuild("before", AFTER));
		const reworded = await translatedTable(
			await writeBuild("reworded", {
				keys: AFTER.keys,
				messages: ["Press any key to close this terminal.", ...BEFORE.messages],
			}),
		);

		expect(reworded.file).not.toBe(before.file);
		expect(reworded.messages[0]).toBe("Press any key to close this terminal.");
	});

	it("is reused by the same build, and kept beside the commit it was made for", async () => {
		const build = await writeBuild("build", AFTER);
		const first = await translatedTable(build);
		const second = await translatedTable(build);

		expect(second.file).toBe(first.file);
		expect(first.file).toContain(
			join(userDataPath, "clp", "pack-hash.ja", `${COMMIT}.`),
		);
	});
});
