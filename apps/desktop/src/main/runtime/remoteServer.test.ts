import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BundledRehDelivery,
	isPermanent,
	LIBC_PROBE,
	parseLibc,
	rehCommit,
	rehInstallKey,
	rehStatementName,
	rehTarballName,
	rehTargetFor,
	rehTopLevelDirectory,
	REH_TARGETS,
	remoteServerPaths,
	sourceBuildRefusal,
	startServerScript,
	unsupportedServerPlatform,
	type RehTarget,
} from "./remoteServer.js";

const REPO_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
	"..",
);

const PATHS = remoteServerPaths({
	home: "/home/vscode",
	dataFolderName: ".devhub-server",
	applicationName: "devhub-server",
	key: "abc-123",
});

describe("starting the remote extension host", () => {
	it("leaves its PATH alone when nothing is to be put in front", () => {
		expect(startServerScript(PATHS)).not.toMatch(/PATH=/u);
	});

	it("puts DevHub's devhub command in front of its PATH in a dev container", () => {
		// There is no DevHub tmux in a container to put it on a pane's PATH, so
		// the server carries it to the terminals and tasks it starts.
		const script = startServerScript(
			PATHS,
			"/home/vscode/.devhub-server/bin/x y",
		);
		expect(script).toContain(
			`PATH='/home/vscode/.devhub-server/bin/x y':"$PATH" nohup `,
		);
	});

	it("names everything it keeps by the install key, token included", () => {
		// A new server — new patches, same VS Code — gets a token, a socket and
		// a directory of its own rather than inheriting the old one's.
		expect(PATHS.install).toBe("/home/vscode/.devhub-server/bin/abc-123");
		expect(PATHS.token).toBe("/home/vscode/.devhub-server/.abc-123.token");
		expect(PATHS.socket).toBe("/home/vscode/.devhub-server/.abc-123.sock");
		expect(PATHS.installed).toBe(
			"/home/vscode/.devhub-server/bin/abc-123/.devhub-installed",
		);
	});
});

describe("which remote extension host a build connects to", () => {
	const COMMIT = "a44adf7f53e00964ab890f9f8758a334f1fc15bc";

	it("is the packaged build's commit", () => {
		expect(rehCommit({ commit: COMMIT, serverCommit: COMMIT })).toBe(COMMIT);
	});

	it("is the serverCommit a source run states, which has no commit", () => {
		// A source run's dev container window used to be refused here: the
		// window opened, its resolver said "states no commit", and Open
		// Settings — the remote settings file — failed with the same sentence.
		expect(rehCommit({ commit: undefined, serverCommit: COMMIT })).toBe(COMMIT);
	});

	it("is nothing when the build states neither", () => {
		expect(rehCommit({})).toBeUndefined();
	});

	it("is installed under the commit and the identity of DevHub's patches", () => {
		// The commit alone named the directory, so a DevHub whose patches changed
		// the server adopted the server an older DevHub had left there.
		expect(rehInstallKey(COMMIT, "0123456789ab")).toBe(
			`${COMMIT}-0123456789ab`,
		);
		expect(rehInstallKey(COMMIT, undefined)).toBeUndefined();
		expect(rehInstallKey(undefined, "0123456789ab")).toBeUndefined();
	});

	it("is accepted by the server when the client states no commit", () => {
		// What lets a commit-less source run talk to a server whose product.json
		// states the commit: the server checks the client's commit only when the
		// client states one. If the pinned VS Code ever makes that check
		// unconditional, a source run's servers must stop stating one.
		const server = readFileSync(
			join(
				REPO_ROOT,
				"vscode",
				"src",
				"vs",
				"server",
				"node",
				"remoteExtensionHostAgentServer.ts",
			),
			"utf8",
		);
		expect(server).toMatch(/if \(rendererCommit && myCommit\)/u);
	});

	it("refuses without naming one kind of machine", () => {
		const sentence = sourceBuildRefusal(
			"the dev container for /Users/me/project",
		);
		expect(sentence).toContain("states no commit or no server identity");
		expect(sentence).toContain("apps/desktop/scripts/dev.sh");
		expect(sentence).not.toMatch(/SSH workspaces/u);
	});
});

describe("which server a machine needs", () => {
	it("is glibc's or musl's, on x64 or arm64", () => {
		expect(
			rehTargetFor({ system: "Linux", architecture: "x64", libc: "glibc" }),
		).toBe("linux-x64");
		expect(
			rehTargetFor({ system: "Linux", architecture: "arm64", libc: "glibc" }),
		).toBe("linux-arm64");
		expect(
			rehTargetFor({ system: "Linux", architecture: "x64", libc: "musl" }),
		).toBe("alpine-x64");
		expect(
			rehTargetFor({ system: "Linux", architecture: "arm64", libc: "musl" }),
		).toBe("alpine-arm64");
	});

	it("is none for a Mac, an architecture DevHub has no server for, or a libc it could not tell", () => {
		expect(
			rehTargetFor({
				system: "Darwin",
				architecture: "arm64",
				libc: undefined,
			}),
		).toBeUndefined();
		expect(
			rehTargetFor({ system: "Linux", architecture: "riscv64", libc: "glibc" }),
		).toBeUndefined();
		expect(
			rehTargetFor({ system: "Linux", architecture: "x64", libc: "unknown" }),
		).toBeUndefined();
	});

	it("is refused in a sentence that names the machine and what it is", () => {
		const sentence = unsupportedServerPlatform("pi.local", {
			system: "Linux",
			architecture: "armv7l",
			libc: "glibc",
		});
		expect(sentence).toContain("pi.local, which is Linux armv7l, glibc");
		for (const target of REH_TARGETS) expect(sentence).toContain(target);
	});

	it("reads the libc probe's last word, and nothing else as an answer", () => {
		expect(parseLibc("musl\n")).toBe("musl");
		expect(parseLibc("glibc\n")).toBe("glibc");
		expect(parseLibc("something else\n")).toBe("unknown");
		expect(parseLibc("")).toBe("unknown");
	});

	it.runIf(process.platform === "linux")(
		"tells this Linux machine's libc rather than giving up",
		() => {
			const answer = parseLibc(
				execFileSync("/bin/sh", ["-c", LIBC_PROBE], { encoding: "utf8" }),
			);
			expect(["glibc", "musl"]).toContain(answer);
		},
	);
});

describe("the servers DevHub carries", () => {
	const COMMIT = "a44adf7f53e00964ab890f9f8758a334f1fc15bc";
	const IDENTITY = "0123456789ab";
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "devhub-reh-bundle-"));
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	/** One target's tarball and its statement, as build_reh.py writes them. */
	async function bundle(
		target: RehTarget,
		statement: Record<string, string> = {},
		bytes = Buffer.from(`the ${target} server`),
	): Promise<void> {
		await writeFile(join(directory, rehTarballName(target)), bytes);
		await writeFile(
			join(directory, rehStatementName(target)),
			JSON.stringify({
				target,
				commit: COMMIT,
				identity: IDENTITY,
				file: rehTarballName(target),
				sha256: createHash("sha256").update(bytes).digest("hex"),
				topLevelDirectory: rehTopLevelDirectory(target),
				...statement,
			}),
		);
	}

	function delivery(
		options: { packaged?: boolean; identity?: string } = {},
	): BundledRehDelivery {
		return new BundledRehDelivery({
			directory,
			commit: COMMIT,
			identity: options.identity ?? IDENTITY,
			dataFolderName: ".devhub-server",
			applicationName: "devhub-server",
			packaged: options.packaged ?? false,
		});
	}

	async function refusal(
		pending: Promise<unknown>,
	): Promise<{ text: string; permanent: boolean }> {
		const failure = await pending.then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		return { text: String(failure), permanent: isPermanent(failure) };
	}

	it("hands over a target's tarball with the directory inside it and its hash", async () => {
		await bundle("alpine-arm64");
		const tarball = await delivery().tarball("alpine-arm64");
		expect(Buffer.from(tarball.bytes).toString()).toBe(
			"the alpine-arm64 server",
		);
		expect(tarball.topLevelDirectory).toBe("devhub-reh-alpine-arm64");
		expect(tarball.sha256).toMatch(/^[0-9a-f]{64}$/u);
		expect(delivery().installKey).toBe(`${COMMIT}-${IDENTITY}`);
	});

	it("refuses a target it does not carry, saying which it does and how to build it", async () => {
		await bundle("linux-x64");
		const { text, permanent } = await refusal(delivery().tarball("alpine-x64"));
		expect(text).toContain(
			"no remote extension host for alpine-x64 (Linux x64, musl)",
		);
		expect(text).toContain("holds linux-x64 only");
		expect(text).toContain("scripts/build_reh.py alpine-x64");
		expect(permanent).toBe(true);
	});

	it("says a packaged app was packaged wrong rather than telling its user to build", async () => {
		const { text } = await refusal(
			delivery({ packaged: true }).tarball("linux-arm64"),
		);
		expect(text).toContain("holds no servers at all");
		expect(text).toContain("packaged without the server it needs");
		expect(text).not.toContain("build_reh.py");
	});

	it("refuses a server built from other patches than this DevHub's", async () => {
		await bundle("linux-x64", { identity: "ffffffffffff" });
		const { text, permanent } = await refusal(delivery().tarball("linux-x64"));
		expect(text).toContain("server identity ffffffffffff");
		expect(text).toContain(IDENTITY);
		expect(text).toContain("scripts/build_reh.py linux-x64");
		expect(permanent).toBe(true);
	});

	it("refuses a tarball that is not the one its statement hashed", async () => {
		await bundle("linux-x64", { sha256: "0".repeat(64) });
		const { text } = await refusal(delivery().tarball("linux-x64"));
		expect(text).toContain("is not the server that was built");
	});

	it("states no key, and hands out nothing, for a build that states no identity", async () => {
		await bundle("linux-x64");
		const quiet = new BundledRehDelivery({
			directory,
			commit: COMMIT,
			identity: undefined,
			dataFolderName: ".devhub-server",
			applicationName: "devhub-server",
			packaged: false,
		});
		expect(quiet.installKey).toBeUndefined();
		const { text } = await refusal(quiet.tarball("linux-x64"));
		expect(text).toContain("states no commit or no server identity");
	});
});
