/**
 * Terraforming a host, with the host played by this machine's own `/bin/sh`
 * under a scratch `$HOME`: so the scripts that probe, unpack, write the
 * wrapper and copy the configuration are the real scripts, run by a real
 * shell and a real `tar`. What the host *is* — its libc, its glibc, its
 * tools, its own `nvim` — is the probe's answer, and the tests that are about
 * those answers give the probe the answer they need.
 *
 * The Neovim it installs is a stand-in (`bin/nvim` a script that answers
 * `--version`), except in the last test, which installs the real bundle when
 * `DEVHUB_TEST_NVIM_BUNDLE` names a `dist/nvim` from `scripts/build_nvim.py`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { socketDirectoryFor } from "./managedNeovim.js";
import { readNeovimConfig, type LocalNeovimConfig } from "./neovimConfig.js";
import {
	BundledNeovimDelivery,
	glibcAtLeast,
	type NeovimDelivery,
	type NeovimStatement,
} from "./neovimDelivery.js";
import { relayFileName } from "./neovimRelay.js";
import {
	chooseNeovimTarget,
	hostNeovimUsable,
	installDirectoryName,
	missingToolsNotice,
	NeovimTerraform,
	parseProbe,
	probeScript,
	type NeovimProbe,
	type TerraformShell,
} from "./neovimTerraform.js";
import { makeScratchDir } from "../../model/testScratch.js";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function scratch(prefix: string): string {
	const directory = makeScratchDir(prefix);
	directories.push(directory);
	return directory;
}

const SERVER = ".devhub-server";

/** A tarball of a stand-in Neovim whose `--version` answers, or fails. */
function fakeNeovimTarball(top: string, runs: boolean): Uint8Array {
	const root = scratch("fake-nvim");
	mkdirSync(join(root, top, "bin"), { recursive: true });
	mkdirSync(join(root, top, "share", "nvim", "runtime"), { recursive: true });
	const program = join(root, top, "bin", "nvim");
	writeFileSync(
		program,
		runs
			? '#!/bin/sh\necho "NVIM v0.12.6"\n'
			: '#!/bin/sh\necho "nvim: error while loading shared libraries: libnsl.so.1" >&2\nexit 127\n',
	);
	chmodSync(program, 0o755);
	execFileSync("tar", ["czf", join(root, "n.tar.gz"), "-C", root, top]);
	return new Uint8Array(readFileSync(join(root, "n.tar.gz")));
}

function fakeDelivery(runs = true): NeovimDelivery & { reads: number } {
	const bytes = fakeNeovimTarball("nvim-linux-x86_64", runs);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const statement: NeovimStatement = {
		version: "v0.12.6",
		targets: {
			"linux-x64": {
				file: "nvim-v0.12.6-linux-x64.tar.gz",
				sha256,
				topLevelDirectory: "nvim-linux-x86_64",
				glibc: "2.14",
			},
			"linux-arm64": {
				file: "nvim-v0.12.6-linux-arm64.tar.gz",
				sha256: "0".repeat(64),
				topLevelDirectory: "nvim-linux-arm64",
				glibc: "2.17",
			},
		},
	};
	const delivery = {
		reads: 0,
		statement: () => Promise.resolve(statement),
		tarball: () => {
			delivery.reads += 1;
			return Promise.resolve({
				version: "v0.12.6",
				bytes,
				sha256,
				topLevelDirectory: "nvim-linux-x86_64",
				glibc: "2.14",
			});
		},
	};
	return delivery;
}

interface Host extends TerraformShell {
	readonly home: string;
	readonly scripts: string[];
	/** Bytes that crossed on stdin, in total. */
	sent: number;
}

/**
 * This machine's `sh` as the host, under `home`. `probe` rewrites what the
 * probe answered, for the tests about a host that is not this one.
 */
function host(
	options: {
		readonly probe?: (answer: string) => string;
		readonly home?: string;
	} = {},
): Host {
	const home = options.home ?? scratch("host-home");
	const scripts: string[] = [];
	const shell: Host = {
		name: "build-box",
		home,
		scripts,
		sent: 0,
		sh(script, extra = {}) {
			scripts.push(script);
			shell.sent += extra.stdin?.byteLength ?? 0;
			const result = spawnSync("/bin/sh", ["-c", script], {
				env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
				input: extra.stdin === undefined ? "" : Buffer.from(extra.stdin),
			});
			let stdout = result.stdout;
			if (script.startsWith("printf 'home=") && options.probe) {
				stdout = Buffer.from(options.probe(stdout.toString("utf8")));
			}
			return Promise.resolve({
				code: result.status,
				stdout,
				stderr: result.stderr,
			});
		},
	};
	return shell;
}

/** A probe answer with the lines for `key` replaced. */
function answering(
	replacements: Readonly<Record<string, string | readonly string[]>>,
): (answer: string) => string {
	return (answer) => {
		const kept = answer
			.split("\n")
			.filter((line) => !(line.split("=")[0]! in replacements));
		for (const [key, value] of Object.entries(replacements)) {
			for (const one of typeof value === "string" ? [value] : value) {
				kept.push(`${key}=${one}`);
			}
		}
		return `${kept.join("\n")}\n`;
	};
}

/** This machine as the probe sees it, made to look like an x86_64 glibc host. */
const LIKE_A_GLIBC_HOST = {
	system: "Linux",
	machine: "x86_64",
	libc: "glibc",
	glibc: "2.31",
};

function config(directory: string): () => Promise<LocalNeovimConfig> {
	return () => readNeovimConfig(directory);
}

function wrapperDirectory(home: string): string {
	return join(home, ".devhub", "devhub-bin-test");
}

describe("terraforming a host for terminal mode", () => {
	it("installs the Neovim, the relay, the wrapper and the configuration copy, once", async () => {
		const machine = host({ probe: answering(LIKE_A_GLIBC_HOST) });
		const local = scratch("local-config");
		writeFileSync(join(local, "init.lua"), "vim.g.devhub = 1\n");
		const delivery = fakeDelivery();
		const terraform = new NeovimTerraform({
			shell: machine,
			delivery,
			serverDataFolderName: SERVER,
			wrapperDirectory,
			config: config(local),
		});
		const terraformed = await terraform.prepare();
		const install = join(
			machine.home,
			SERVER,
			"nvim",
			installDirectoryName(
				"v0.12.6",
				(await delivery.tarball("linux-x64")).sha256,
			),
		);
		delivery.reads -= 1;
		expect(terraformed.binary).toEqual({
			kind: "bundled",
			path: join(install, "bin", "nvim"),
			version: "v0.12.6",
		});
		expect(existsSync(join(install, "share", "nvim", "runtime"))).toBe(true);
		expect(
			existsSync(join(machine.home, SERVER, "nvim", relayFileName())),
		).toBe(true);
		expect(
			readFileSync(
				join(machine.home, SERVER, "xdg", "config", "nvim", "init.lua"),
				"utf8",
			),
		).toBe("vim.g.devhub = 1\n");
		// Under the home directory when the path fits a socket address — a
		// scratch home in a checkout may not, and then it is the short one.
		expect(terraformed.socketDirectory).toBe(
			socketDirectoryFor([
				join(machine.home, SERVER, "run", "nvim"),
				`/tmp/devhub-nvim-${String(process.getuid?.() ?? "user")}`,
			]),
		);
		// The wrapper runs that Neovim with the XDG directories under xdg/.
		expect(terraformed.nvim).toBe(join(wrapperDirectory(machine.home), "nvim"));
		const env = spawnSync(
			"/bin/sh",
			[
				"-c",
				`sed 's|^exec .*|exec env|' "$1" > "$1.env" && sh "$1.env"`,
				"sh",
				terraformed.nvim,
			],
			{ encoding: "utf8" },
		).stdout;
		expect(env).toContain(
			`XDG_CONFIG_HOME=${join(machine.home, SERVER, "xdg", "config")}`,
		);
		expect(env).toContain(
			`XDG_DATA_HOME=${join(machine.home, SERVER, "xdg", "data")}`,
		);
		expect(
			spawnSync(terraformed.nvim, ["--version"], { encoding: "utf8" }).stdout,
		).toBe("NVIM v0.12.6\n");
		expect(delivery.reads).toBe(1);

		// A second DevHub start: the version directory answers and the digest
		// matches, so neither the tarball nor the configuration crosses again.
		const again = host({
			home: machine.home,
			probe: answering(LIKE_A_GLIBC_HOST),
		});
		const second = new NeovimTerraform({
			shell: again,
			delivery,
			serverDataFolderName: SERVER,
			wrapperDirectory,
			config: config(local),
		});
		await second.prepare();
		expect(delivery.reads).toBe(1);
		const configBytes = (await readNeovimConfig(local)) as {
			tarball: Uint8Array;
		};
		expect(again.sent).toBeLessThan(configBytes.tarball.byteLength + 4096);
		expect(
			again.scripts.some((script) => script.includes("nvim.unpacking")),
		).toBe(false);

		// An edit on this Mac reaches the host at the next sync, and only then.
		writeFileSync(join(local, "init.lua"), "vim.g.devhub = 2\n");
		await second.syncConfig();
		expect(
			readFileSync(
				join(machine.home, SERVER, "xdg", "config", "nvim", "init.lua"),
				"utf8",
			),
		).toBe("vim.g.devhub = 2\n");
	});

	it("removes the copy when the configuration on this Mac is gone", async () => {
		const machine = host({ probe: answering(LIKE_A_GLIBC_HOST) });
		const local = scratch("local-config");
		writeFileSync(join(local, "init.lua"), "-- x\n");
		const terraform = new NeovimTerraform({
			shell: machine,
			delivery: fakeDelivery(),
			serverDataFolderName: SERVER,
			wrapperDirectory,
			config: config(local),
		});
		await terraform.prepare();
		rmSync(local, { recursive: true });
		await terraform.syncConfig();
		expect(
			existsSync(join(machine.home, SERVER, "xdg", "config", "nvim")),
		).toBe(false);
	});

	it("falls back to the host's own nvim on musl, and says so", async () => {
		const own = join(scratch("host-bin"), "nvim");
		writeFileSync(own, '#!/bin/sh\necho "NVIM v0.11.4"\n');
		chmodSync(own, 0o755);
		const machine = host({
			probe: answering({
				...LIKE_A_GLIBC_HOST,
				libc: "musl",
				glibc: "",
				hostnvim: own,
				hostnvimversion: "NVIM v0.11.4",
			}),
		});
		const delivery = fakeDelivery();
		const terraformed = await new NeovimTerraform({
			shell: machine,
			delivery,
			serverDataFolderName: SERVER,
			wrapperDirectory,
			config: config(scratch("empty")),
		}).prepare();
		expect(terraformed.binary).toMatchObject({ kind: "host", path: own });
		expect(delivery.reads).toBe(0);
		expect(terraformed.notices[0]).toMatch(
			/^Build-box runs musl .* glibc build\. Terminal mode uses build-box's own .*nvim instead/u,
		);
		expect(
			spawnSync(terraformed.nvim, ["--version"], { encoding: "utf8" }).stdout,
		).toBe("NVIM v0.11.4\n");
	});

	it("falls back when the Neovim it installed does not start there, and takes it away", async () => {
		const own = join(scratch("host-bin"), "nvim");
		writeFileSync(own, '#!/bin/sh\necho "NVIM v0.10.0"\n');
		chmodSync(own, 0o755);
		const machine = host({
			probe: answering({
				...LIKE_A_GLIBC_HOST,
				hostnvim: own,
				hostnvimversion: "NVIM v0.10.0",
			}),
		});
		const delivery = fakeDelivery(false);
		const terraformed = await new NeovimTerraform({
			shell: machine,
			delivery,
			serverDataFolderName: SERVER,
			wrapperDirectory,
			config: config(scratch("empty")),
		}).prepare();
		expect(terraformed.binary).toMatchObject({ kind: "host", path: own });
		expect(terraformed.notices[0]).toMatch(
			/does not start on build-box \(.*libnsl/u,
		);
		expect(
			existsSync(
				join(
					machine.home,
					SERVER,
					"nvim",
					installDirectoryName(
						"v0.12.6",
						(await delivery.tarball("linux-x64")).sha256,
					),
				),
			),
		).toBe(false);
	});

	it("refuses with every reason when there is no Neovim that can run", async () => {
		const machine = host({
			probe: answering({ ...LIKE_A_GLIBC_HOST, glibc: "2.12", hostnvim: [] }),
		});
		await expect(
			new NeovimTerraform({
				shell: machine,
				delivery: fakeDelivery(),
				serverDataFolderName: SERVER,
				wrapperDirectory,
				config: config(scratch("empty")),
			}).prepare(),
		).rejects.toThrow(
			/^Build-box has glibc 2\.12, and the Neovim DevHub carries needs 2\.14 or newer, and build-box has no nvim on its PATH either/u,
		);
	});

	it("says which tools a configuration will miss, when there is a configuration", async () => {
		const local = scratch("local-config");
		writeFileSync(join(local, "init.lua"), "-- lazy\n");
		const machine = host({
			probe: answering({ ...LIKE_A_GLIBC_HOST, tool: ["curl"] }),
		});
		const terraformed = await new NeovimTerraform({
			shell: machine,
			delivery: fakeDelivery(),
			serverDataFolderName: SERVER,
			wrapperDirectory,
			config: config(local),
		}).prepare();
		expect(terraformed.notices).toEqual([
			"build-box has no git and unzip, so lazy.nvim cannot install plugins, and mason cannot unpack most of them there. The editor area and Neovim work without them; install them on the host for plugins.",
		]);
	});
});

describe("what the probe reads", () => {
	it("is parsed line by line, repeated keys collected", () => {
		const probe = parseProbe(
			"home=/home/me\nsystem=Linux\nmachine=aarch64\nuid=1000\nlibc=glibc\nglibc=2.17\ntool=git\ntool=curl\ninstalled=linux-arm64\nconfigdigest=abc\n",
		);
		expect(probe).toMatchObject({
			home: "/home/me",
			machine: "aarch64",
			libc: "glibc",
			glibc: "2.17",
			configDigest: "abc",
		});
		expect([...probe.tools]).toEqual(["git", "curl"]);
		expect([...probe.installed]).toEqual(["linux-arm64"]);
	});

	it("answers on this machine, which is a glibc Linux", () => {
		const machine = scratch("probe-home");
		const out = spawnSync("/bin/sh", ["-c", probeScript(SERVER, undefined)], {
			env: { HOME: machine, PATH: process.env.PATH ?? "" },
			encoding: "utf8",
		});
		expect(out.status).toBe(0);
		const probe = parseProbe(out.stdout);
		expect(probe.home).toBe(machine);
		if (process.platform === "linux") {
			expect(probe.libc).not.toBe("unknown");
			if (probe.libc === "glibc") expect(probe.glibc).toMatch(/^2\.\d+$/u);
		}
	});
});

describe("which Neovim a host gets", () => {
	const statement: NeovimStatement = {
		version: "v0.12.6",
		targets: {
			"linux-x64": {
				file: "a",
				sha256: "1".repeat(64),
				topLevelDirectory: "nvim-linux-x86_64",
				glibc: "2.14",
			},
			"linux-arm64": {
				file: "b",
				sha256: "2".repeat(64),
				topLevelDirectory: "nvim-linux-arm64",
				glibc: "2.17",
			},
		},
	};
	const probe = (fields: Partial<NeovimProbe>): NeovimProbe => ({
		...parseProbe(
			"home=/h\nsystem=Linux\nmachine=x86_64\nlibc=glibc\nglibc=2.28\n",
		),
		...fields,
	});

	it("is the architecture's bundle on glibc new enough", () => {
		expect(chooseNeovimTarget(probe({}), statement, "h")).toEqual({
			target: "linux-x64",
		});
		expect(
			chooseNeovimTarget(
				probe({ machine: "aarch64", glibc: "2.17" }),
				statement,
				"h",
			),
		).toEqual({ target: "linux-arm64" });
	});

	it("is a reason on musl, old glibc, another architecture, another system", () => {
		const reason = (fields: Partial<NeovimProbe>) => {
			const chosen = chooseNeovimTarget(probe(fields), statement, "nas");
			return "reason" in chosen ? chosen.reason : "";
		};
		expect(reason({ libc: "musl" })).toMatch(/musl/u);
		expect(reason({ machine: "aarch64", glibc: "2.16" })).toMatch(
			/glibc 2\.16, .* needs 2\.17/u,
		);
		expect(reason({ machine: "armv7l" })).toMatch(/armv7l/u);
		expect(reason({ system: "Darwin" })).toMatch(/Darwin/u);
		expect(reason({ libc: "unknown" })).toMatch(/could not identify/u);
		expect(
			"reason" in chooseNeovimTarget(probe({}), "no bundle here", "nas"),
		).toBe(true);
	});

	it("tries an unreadable glibc rather than refusing it: running it is the test", () => {
		expect(chooseNeovimTarget(probe({ glibc: "" }), statement, "h")).toEqual({
			target: "linux-x64",
		});
	});

	it("takes a host Neovim only from 0.9, which the relay's -l needs", () => {
		expect(hostNeovimUsable("NVIM v0.9.5")).toBe(true);
		expect(hostNeovimUsable("NVIM v0.12.0")).toBe(true);
		expect(hostNeovimUsable("NVIM v0.8.3")).toBe(false);
		expect(hostNeovimUsable("")).toBe(false);
	});

	it("compares glibc versions as numbers", () => {
		expect(glibcAtLeast("2.17", "2.14")).toBe(true);
		expect(glibcAtLeast("2.9", "2.14")).toBe(false);
		expect(glibcAtLeast("2.14", "2.14")).toBe(true);
	});

	it("says nothing about tools a host has", () => {
		expect(
			missingToolsNotice(
				probe({ tools: new Set(["git", "wget", "unzip"]) }),
				"h",
			),
		).toBeUndefined();
	});
});

const BUNDLE = process.env.DEVHUB_TEST_NVIM_BUNDLE;

describe.skipIf(
	BUNDLE === undefined ||
		process.platform !== "linux" ||
		process.arch !== "x64",
)("terraforming with the real bundle", () => {
	it("installs the real Neovim, which starts with the copied configuration", async () => {
		const machine = host();
		const local = scratch("local-config");
		writeFileSync(join(local, "init.lua"), "vim.g.devhub_terraformed = 42\n");
		const terraformed = await new NeovimTerraform({
			shell: machine,
			delivery: new BundledNeovimDelivery({
				directory: BUNDLE as string,
				packaged: false,
			}),
			serverDataFolderName: SERVER,
			wrapperDirectory,
			config: config(local),
		}).prepare();
		expect(terraformed.binary.kind).toBe("bundled");
		const answer = spawnSync(
			terraformed.nvim,
			[
				"--headless",
				"-c",
				"lua io.stdout:write(vim.g.devhub_terraformed .. ' ' .. vim.fn.stdpath('data'))",
				"-c",
				"qa!",
			],
			{ encoding: "utf8", env: { HOME: machine.home, PATH: process.env.PATH } },
		);
		expect(answer.stdout).toBe(
			`42 ${join(machine.home, SERVER, "xdg", "data", "nvim")}`,
		);
	}, 60_000);
});
