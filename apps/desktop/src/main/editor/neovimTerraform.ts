/**
 * Terraforming: everything terminal mode's editor area needs, put on a host.
 *
 * An SSH Workspace's editor area is the host's own `ws-` session, and its
 * file jumps go to a Neovim DevHub manages there (`managedNeovim.ts`). The
 * host is not asked to have any of it. DevHub already brings its tmux
 * (`RemoteShellRuntime.tmuxProgram`); this brings the rest, over the same
 * connection, and only what is missing:
 *
 *     ~/.devhub-server/                      (`serverDataFolderName`)
 *       nvim/<version>-<sha12>/              the Neovim this DevHub carries,
 *         bin/nvim  share/nvim/runtime/…     for this host's architecture
 *       nvim/devhub-relay-<sha12>.lua        the RPC relay (`neovimRelay.ts`)
 *       xdg/config/nvim/                     a copy of the person's
 *       xdg/config/nvim.devhub-digest        ~/.config/nvim, and which one
 *       xdg/data/  xdg/state/  xdg/cache/    where Neovim keeps the rest:
 *                                            lazy.nvim's plugins, mason's
 *                                            servers, shada, undo, logs
 *       run/nvim/<digest>.sock               one managed Neovim per Workspace
 *     ~/.devhub/devhub-bin-<tag>/nvim        a wrapper on the PATH of every
 *                                            DevHub pane on the host
 *
 * The version directory is named by the tarball's hash, so an install is
 * idempotent by its name and never re-sent; the configuration is compared by
 * digest (`neovimConfig.ts`) and re-sent only when it changed.
 *
 * Neovim runs with `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and
 * `XDG_CACHE_HOME` under `xdg/`, set by the wrapper — so nothing of the host's
 * own `~/.config/nvim` or `~/.local/share/nvim` is read or written, and the
 * person's own login there is untouched. Plugins and language servers are the
 * configuration's business, on the host: lazy.nvim bootstraps with `git`,
 * mason downloads with `curl` or `wget` and unpacks with `unzip`. A host
 * without those still has an editor area and a Neovim; what is missing is
 * said once, as a notice, and nothing is blocked on it.
 *
 * ## When the Neovim DevHub carries cannot run there
 *
 * It is a glibc build (glibc 2.14 on x86_64, 2.17 on aarch64 — see
 * `scripts/build_nvim.py`). A musl host (Alpine), a glibc older than that, an
 * architecture DevHub carries nothing for, or a binary that would not start
 * once unpacked (a missing `libnsl.so.1`, say) is detected — by `ldd`/
 * `getconf`, `/lib/ld-musl-*`, and finally by running it — and said, and the
 * host's own `nvim` is used instead if it has one, with the same
 * configuration copy. With neither, a jump there is refused with all of it in
 * the sentence. The editor area itself never depends on Neovim: it is tmux.
 */

import { posix } from "node:path";
import { LIBC_PROBE, parseLibc, type Libc } from "../runtime/remoteServer.js";
import { shellQuote } from "../runtime/quote.js";
import { socketDirectoryFor } from "./managedNeovim.js";
import type { LocalNeovimConfig } from "./neovimConfig.js";
import {
	glibcAtLeast,
	NEOVIM_TARGETS,
	type NeovimDelivery,
	type NeovimStatement,
	type NeovimTarget,
} from "./neovimDelivery.js";
import { NEOVIM_RELAY_LUA, relayFileName } from "./neovimRelay.js";

/** What terraforming needs of a machine: a POSIX shell over there. */
export interface TerraformShell {
	/** For a sentence: `build-box`. */
	readonly name: string;
	sh(
		script: string,
		options?: { readonly stdin?: Uint8Array; readonly timeoutMs?: number },
	): Promise<{
		readonly code: number | null;
		readonly stdout: Uint8Array;
		readonly stderr: Uint8Array;
	}>;
}

export interface NeovimTerraformOptions {
	readonly shell: TerraformShell;
	readonly delivery: NeovimDelivery;
	/** `product.json`'s `serverDataFolderName`: `.devhub-server`. */
	readonly serverDataFolderName: string;
	/** The directory on every DevHub pane's PATH there, from its `$HOME`. */
	readonly wrapperDirectory: (home: string) => string;
	/** The person's configuration on this Mac, read now. */
	readonly config: () => Promise<LocalNeovimConfig>;
}

/** Which Neovim runs on the machine, and why that one. */
export type NeovimBinary =
	| {
			readonly kind: "bundled";
			readonly path: string;
			readonly version: string;
	  }
	| {
			readonly kind: "host";
			readonly path: string;
			/** Why the bundled one is not used. */
			readonly reason: string;
	  };

/** A terraformed machine, as the managed Neovim needs it. */
export interface TerraformedNeovim {
	readonly home: string;
	/** The wrapper: what a managed Neovim is started as. */
	readonly nvim: string;
	readonly binary: NeovimBinary;
	readonly relayPath: string;
	readonly socketDirectory: string;
	/**
	 * What the person should know, as sentences: the fallback, the tools a
	 * configuration will miss, the files that were not copied. Empty when
	 * nothing needs saying.
	 */
	readonly notices: readonly string[];
}

/** The answers of the one probe that starts every terraform. */
export interface NeovimProbe {
	readonly home: string;
	readonly system: string;
	readonly machine: string;
	readonly uid: string;
	readonly libc: Libc;
	/** `2.31`, or empty when the host would not say. */
	readonly glibc: string;
	readonly tools: ReadonlySet<string>;
	/** Absolute, or empty. */
	readonly hostNvim: string;
	/** Its `--version` first line, or empty. */
	readonly hostNvimVersion: string;
	/** Targets whose version directory already answers `--version`. */
	readonly installed: ReadonlySet<string>;
	/** The digest the host's configuration copy was made from, or empty. */
	readonly configDigest: string;
}

/** The tools a configuration usually needs on the host, and what for. */
export const CONFIG_TOOLS = ["git", "curl", "wget", "unzip"] as const;

/** `v0.12.6`, `x64`: a version directory's name. */
export function installDirectoryName(version: string, sha256: string): string {
	return `${version}-${sha256.slice(0, 12)}`;
}

/** The layout above, from a home directory. */
export function terraformPaths(home: string, serverDataFolderName: string) {
	const root = posix.join(home, serverDataFolderName);
	const xdg = posix.join(root, "xdg");
	return {
		root,
		nvim: posix.join(root, "nvim"),
		relay: posix.join(root, "nvim", relayFileName()),
		xdg: {
			config: posix.join(xdg, "config"),
			data: posix.join(xdg, "data"),
			state: posix.join(xdg, "state"),
			cache: posix.join(xdg, "cache"),
		},
		configCopy: posix.join(xdg, "config", "nvim"),
		configDigest: posix.join(xdg, "config", "nvim.devhub-digest"),
		sockets: posix.join(root, "run", "nvim"),
	};
}

/** The probe, as one script; every line `key=value`. */
export function probeScript(
	serverDataFolderName: string,
	statement: NeovimStatement | undefined,
): string {
	const lines = [
		`printf 'home=%s\\n' "$HOME"`,
		`printf 'system=%s\\n' "$(uname -s)"`,
		`printf 'machine=%s\\n' "$(uname -m)"`,
		`printf 'uid=%s\\n' "$(id -u)"`,
		`printf 'libc=%s\\n' "$( { ${LIBC_PROBE.split("\n").join("; ")}; } 2>/dev/null | tail -n 1)"`,
		// `getconf` answers on glibc only; `ldd --version`'s first line ends in
		// the version on every glibc distribution and is musl's usage text.
		`g=$(getconf GNU_LIBC_VERSION 2>/dev/null | sed -n 's/^glibc //p')`,
		`[ -n "$g" ] || g=$(ldd --version 2>/dev/null | sed -n '1s/.* \\([0-9][0-9]*\\.[0-9][0-9]*\\)$/\\1/p')`,
		`printf 'glibc=%s\\n' "$g"`,
		...CONFIG_TOOLS.map(
			(tool) =>
				`command -v ${tool} >/dev/null 2>&1 && printf 'tool=%s\\n' ${tool}`,
		),
		`n=$(command -v nvim 2>/dev/null) || n=`,
		`case "$n" in /*) printf 'hostnvim=%s\\n' "$n"; printf 'hostnvimversion=%s\\n' "$("$n" --version 2>/dev/null | head -n 1)";; esac`,
		`printf 'configdigest=%s\\n' "$(cat "$HOME"/${shellQuote(`${serverDataFolderName}/xdg/config/nvim.devhub-digest`)} 2>/dev/null)"`,
	];
	for (const target of NEOVIM_TARGETS) {
		const entry = statement?.targets[target];
		if (entry === undefined || statement === undefined) continue;
		const directory = `${serverDataFolderName}/nvim/${installDirectoryName(statement.version, entry.sha256)}`;
		lines.push(
			`"$HOME"/${shellQuote(`${directory}/bin/nvim`)} --version >/dev/null 2>&1 && printf 'installed=%s\\n' ${target}`,
		);
	}
	lines.push("exit 0");
	return lines.join("\n");
}

export function parseProbe(stdout: string): NeovimProbe {
	const values = new Map<string, string>();
	const tools = new Set<string>();
	const installed = new Set<string>();
	for (const line of stdout.split("\n")) {
		const equals = line.indexOf("=");
		if (equals <= 0) continue;
		const key = line.slice(0, equals);
		const value = line.slice(equals + 1).trim();
		if (key === "tool") tools.add(value);
		else if (key === "installed") installed.add(value);
		else values.set(key, value);
	}
	const get = (key: string): string => values.get(key) ?? "";
	return {
		home: get("home"),
		system: get("system"),
		machine: get("machine"),
		uid: get("uid"),
		libc: parseLibc(get("libc")),
		glibc: get("glibc"),
		tools,
		hostNvim: get("hostnvim"),
		hostNvimVersion: get("hostnvimversion"),
		installed,
		configDigest: get("configdigest"),
	};
}

/** `uname -m` as the bundle names architectures. */
function architectureOf(machine: string): string {
	if (machine === "x86_64" || machine === "amd64") return "x64";
	if (machine === "aarch64" || machine === "arm64") return "arm64";
	return machine;
}

/**
 * The target this host needs, or why DevHub's Neovim cannot run there. The
 * glibc floor is the statement's, read off the binary at build time.
 */
export function chooseNeovimTarget(
	probe: NeovimProbe,
	statement: NeovimStatement | string,
	host: string,
): { readonly target: NeovimTarget } | { readonly reason: string } {
	if (probe.system !== "Linux") {
		return {
			reason: `${host} is ${probe.system || "not Linux"}, and the Neovim DevHub carries is for Linux`,
		};
	}
	if (probe.libc === "musl") {
		return {
			reason: `${host} runs musl (Alpine or similar), and the Neovim DevHub carries is a glibc build`,
		};
	}
	if (probe.libc === "unknown") {
		return {
			reason: `DevHub could not identify the C library on ${host}, so it does not install its glibc Neovim there`,
		};
	}
	const architecture = architectureOf(probe.machine);
	const target = `linux-${architecture}`;
	if (!(NEOVIM_TARGETS as readonly string[]).includes(target)) {
		return {
			reason: `${host} is ${probe.machine}, and DevHub carries Neovim for x86_64 and aarch64 only`,
		};
	}
	if (typeof statement === "string") return { reason: statement };
	const entry = statement.targets[target as NeovimTarget];
	if (entry === undefined) {
		return { reason: `this DevHub carries no Neovim for ${target}` };
	}
	if (probe.glibc !== "" && !glibcAtLeast(probe.glibc, entry.glibc)) {
		return {
			reason: `${host} has glibc ${probe.glibc}, and the Neovim DevHub carries needs ${entry.glibc} or newer`,
		};
	}
	return { target: target as NeovimTarget };
}

/** `NVIM v0.9.5` → `[0, 9]`. */
export function neovimVersionOf(
	line: string,
): readonly [number, number] | undefined {
	const match = /v?(\d+)\.(\d+)/.exec(line);
	if (match?.[1] === undefined || match[2] === undefined) return undefined;
	return [Number(match[1]), Number(match[2])];
}

/** The relay runs `nvim -l`, which is 0.9 and later. */
export function hostNeovimUsable(versionLine: string): boolean {
	const version = neovimVersionOf(versionLine);
	if (version === undefined) return false;
	return version[0] > 0 || version[1] >= 9;
}

/** What is missing on the host for the usual configuration, said once. */
export function missingToolsNotice(
	probe: NeovimProbe,
	host: string,
): string | undefined {
	const missing: string[] = [];
	const effects: string[] = [];
	if (!probe.tools.has("git")) {
		missing.push("git");
		effects.push("lazy.nvim cannot install plugins");
	}
	if (!probe.tools.has("curl") && !probe.tools.has("wget")) {
		missing.push("curl (or wget)");
		effects.push("mason cannot download language servers");
	}
	if (!probe.tools.has("unzip")) {
		missing.push("unzip");
		effects.push("mason cannot unpack most of them");
	}
	if (missing.length === 0) return undefined;
	const list =
		missing.length === 1
			? (missing[0] as string)
			: `${missing.slice(0, -1).join(", ")} and ${missing.at(-1) as string}`;
	return `${host} has no ${list}, so ${effects.join(", and ")} there. The editor area and Neovim work without ${missing.length === 1 ? "it" : "them"}; install ${missing.length === 1 ? "it" : "them"} on the host for plugins.`;
}

/** The wrapper every DevHub pane on the host finds as `nvim`. */
export function wrapperScript(
	binary: string,
	xdg: { config: string; data: string; state: string; cache: string },
): string {
	return [
		"#!/bin/sh",
		"# DevHub's Neovim on this machine, with the configuration DevHub copied",
		"# here from the Mac it runs on (docs/terminal-mode.md, Terraforming).",
		"# Written by DevHub; it is rewritten whenever DevHub terraforms this host.",
		`XDG_CONFIG_HOME=${shellQuote(xdg.config)}`,
		`XDG_DATA_HOME=${shellQuote(xdg.data)}`,
		`XDG_STATE_HOME=${shellQuote(xdg.state)}`,
		`XDG_CACHE_HOME=${shellQuote(xdg.cache)}`,
		"export XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME",
		`exec ${shellQuote(binary)} "$@"`,
		"",
	].join("\n");
}

/** Unpack a tarball from stdin into `directory`, all or nothing (as tmux's is). */
export function unpackNeovimScript(
	directory: string,
	topLevelDirectory: string,
): string {
	const staging = `${directory}.unpacking`;
	const unpacked = posix.join(staging, topLevelDirectory);
	return [
		`rm -rf -- ${shellQuote(staging)} ${shellQuote(directory)}`,
		`mkdir -p -- ${shellQuote(staging)} || exit 1`,
		`tar xzf - -C ${shellQuote(staging)} || exit 1`,
		`[ -d ${shellQuote(unpacked)} ] || { echo "no ${topLevelDirectory} in the tarball" >&2; exit 1; }`,
		`mv -- ${shellQuote(unpacked)} ${shellQuote(directory)} || exit 1`,
		`exec rm -rf -- ${shellQuote(staging)}`,
	].join("\n");
}

/** Replace the configuration copy from a tarball on stdin, then record its digest. */
export function unpackConfigScript(
	copy: string,
	digestFile: string,
	digest: string,
): string {
	const staging = `${copy}.unpacking`;
	return [
		`rm -rf -- ${shellQuote(staging)}`,
		`mkdir -p -- ${shellQuote(staging)} || exit 1`,
		`tar xzf - -C ${shellQuote(staging)} || exit 1`,
		`rm -rf -- ${shellQuote(copy)} || exit 1`,
		`mv -- ${shellQuote(staging)} ${shellQuote(copy)} || exit 1`,
		`printf '%s\\n' ${shellQuote(digest)} > ${shellQuote(digestFile)}`,
	].join("\n");
}

/** A file written through stdin, its mode set before its content arrives. */
function writeFileScript(path: string, mode: number): string {
	const quoted = shellQuote(path);
	return `mkdir -p -- ${shellQuote(posix.dirname(path))} && : > ${quoted} && chmod ${mode.toString(8)} ${quoted} && exec cat > ${quoted}`;
}

function lastLine(bytes: Uint8Array): string {
	const lines = Buffer.from(bytes)
		.toString("utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return lines.at(-1) ?? "";
}

/** How long one payload may take to cross: an 11 MB tarball on a slow link. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;

/** Terraforming for one machine; one per machine per DevHub start. */
export class NeovimTerraform {
	readonly #options: NeovimTerraformOptions;
	#prepared: Promise<TerraformedNeovim> | undefined;

	constructor(options: NeovimTerraformOptions) {
		this.#options = options;
	}

	/**
	 * The machine, terraformed: its Neovim installed (or the host's chosen,
	 * and why), the relay and the wrapper written, the configuration copy
	 * current. Once per DevHub start; a failure is tried again by the next ask.
	 */
	prepare(): Promise<TerraformedNeovim> {
		if (this.#prepared) return this.#prepared;
		const pending = this.#prepare();
		pending.catch(() => {
			if (this.#prepared === pending) this.#prepared = undefined;
		});
		this.#prepared = pending;
		return pending;
	}

	/**
	 * Bring the configuration copy up to date with this Mac's, if it is not:
	 * before each new managed Neovim, so an edit made while DevHub runs is the
	 * configuration the next one starts with. Answers what was skipped.
	 */
	async syncConfig(): Promise<readonly string[]> {
		const prepared = await this.prepare();
		const current = await this.#remoteConfigDigest(prepared.home);
		return this.#sendConfig(
			prepared.home,
			current,
			await this.#options.config(),
		);
	}

	async #remoteConfigDigest(home: string): Promise<string> {
		const paths = terraformPaths(home, this.#options.serverDataFolderName);
		const result = await this.#options.shell.sh(
			`cat ${shellQuote(paths.configDigest)} 2>/dev/null; exit 0`,
		);
		return Buffer.from(result.stdout).toString("utf8").trim();
	}

	async #prepare(): Promise<TerraformedNeovim> {
		const { shell, delivery, serverDataFolderName } = this.#options;
		const statement = await delivery.statement();
		const probed = await shell.sh(
			probeScript(
				serverDataFolderName,
				typeof statement === "string" ? undefined : statement,
			),
		);
		if (probed.code !== 0) {
			throw new Error(
				`DevHub could not look at ${shell.name} for Neovim: ${lastLine(probed.stderr) || `the probe exited ${String(probed.code)}`}`,
			);
		}
		const probe = parseProbe(Buffer.from(probed.stdout).toString("utf8"));
		if (!probe.home.startsWith("/")) {
			throw new Error(`${shell.name} did not say what its home directory is`);
		}
		const paths = terraformPaths(probe.home, serverDataFolderName);
		const notices: string[] = [];
		const binary = await this.#binary(probe, statement, paths.nvim);
		if (binary.kind === "host") {
			notices.push(
				`${capitalised(binary.reason)}. Terminal mode uses ${shell.name}'s own ${binary.path} instead, with your configuration.`,
			);
		}
		// Small files, written each start: they are DevHub's, and a host that
		// lost one (a home directory restored, a person tidying up) gets it back.
		const relay = await shell.sh(writeFileScript(paths.relay, 0o644), {
			stdin: Buffer.from(NEOVIM_RELAY_LUA, "utf8"),
		});
		if (relay.code !== 0) {
			throw new Error(
				`DevHub could not write ${paths.relay} on ${shell.name}: ${lastLine(relay.stderr)}`,
			);
		}
		const wrapper = posix.join(
			this.#options.wrapperDirectory(probe.home),
			"nvim",
		);
		const madeXdg = await shell.sh(
			`mkdir -p -- ${[paths.xdg.config, paths.xdg.data, paths.xdg.state, paths.xdg.cache].map(shellQuote).join(" ")} && chmod 700 ${shellQuote(posix.dirname(paths.xdg.config))}`,
		);
		if (madeXdg.code !== 0) {
			throw new Error(
				`DevHub could not make ${posix.dirname(paths.xdg.config)} on ${shell.name}: ${lastLine(madeXdg.stderr)}`,
			);
		}
		const wrote = await shell.sh(writeFileScript(wrapper, 0o755), {
			stdin: Buffer.from(wrapperScript(binary.path, paths.xdg), "utf8"),
		});
		if (wrote.code !== 0) {
			throw new Error(
				`DevHub could not write ${wrapper} on ${shell.name}: ${lastLine(wrote.stderr)}`,
			);
		}
		const config = await this.#options.config();
		const skipped = await this.#sendConfig(
			probe.home,
			probe.configDigest,
			config,
		);
		if (skipped.length > 0) {
			notices.push(
				`Not copied to ${shell.name} with your Neovim configuration: ${skipped.join(", ")}.`,
			);
		}
		if (config.kind === "config") {
			const tools = missingToolsNotice(probe, shell.name);
			if (tools !== undefined) notices.push(tools);
		}
		return {
			home: probe.home,
			nvim: wrapper,
			binary,
			relayPath: paths.relay,
			socketDirectory: socketDirectoryFor([
				paths.sockets,
				`/tmp/devhub-nvim-${probe.uid || "user"}`,
			]),
			notices,
		};
	}

	/** The bundled Neovim, installed if need be — or the host's, and why. */
	async #binary(
		probe: NeovimProbe,
		statement: NeovimStatement | string,
		nvimDirectory: string,
	): Promise<NeovimBinary> {
		const { shell } = this.#options;
		const chosen = chooseNeovimTarget(probe, statement, shell.name);
		let reason: string;
		if ("target" in chosen && typeof statement !== "string") {
			const entry = statement.targets[chosen.target];
			if (entry === undefined) throw new Error("unreachable: no entry");
			const directory = posix.join(
				nvimDirectory,
				installDirectoryName(statement.version, entry.sha256),
			);
			const program = posix.join(directory, "bin", "nvim");
			if (probe.installed.has(chosen.target)) {
				return { kind: "bundled", path: program, version: statement.version };
			}
			const failure = await this.#install(chosen.target, directory).catch(
				(error: unknown) =>
					error instanceof Error ? error.message : String(error),
			);
			if (failure === undefined) {
				const ran = await shell.sh(`exec ${shellQuote(program)} --version`);
				if (ran.code === 0) {
					return {
						kind: "bundled",
						path: program,
						version: statement.version,
					};
				}
				reason = `the Neovim DevHub installed in ${directory} does not start on ${shell.name} (${lastLine(ran.stderr) || `exit ${String(ran.code)}`})`;
				// Left in place would make the next probe call it installed.
				await shell.sh(`rm -rf -- ${shellQuote(directory)}`);
			} else {
				reason = failure;
			}
		} else {
			reason = "reason" in chosen ? chosen.reason : String(statement);
		}
		if (probe.hostNvim === "") {
			throw new Error(
				`${capitalised(reason)}, and ${shell.name} has no nvim on its PATH either, so terminal mode has no Neovim to open files in there. Install Neovim on the host; the editor area itself works without it.`,
			);
		}
		if (!hostNeovimUsable(probe.hostNvimVersion)) {
			throw new Error(
				`${capitalised(reason)}, and ${shell.name}'s own ${probe.hostNvim} is ${probe.hostNvimVersion || "a version DevHub could not read"} — DevHub needs Neovim 0.9 or newer to reach it.`,
			);
		}
		return { kind: "host", path: probe.hostNvim, reason };
	}

	async #install(target: NeovimTarget, directory: string): Promise<void> {
		const { shell, delivery } = this.#options;
		const tarball = await delivery.tarball(target);
		const unpack = await shell.sh(
			unpackNeovimScript(directory, tarball.topLevelDirectory),
			{ stdin: tarball.bytes, timeoutMs: INSTALL_TIMEOUT_MS },
		);
		if (unpack.code !== 0) {
			throw new Error(
				`DevHub could not unpack Neovim ${tarball.version} into ${directory} on ${shell.name}: ${lastLine(unpack.stderr)}`,
			);
		}
	}

	/** Send the configuration if the host's copy is not this one. */
	async #sendConfig(
		home: string,
		current: string,
		config: LocalNeovimConfig,
	): Promise<readonly string[]> {
		const { shell } = this.#options;
		const paths = terraformPaths(home, this.#options.serverDataFolderName);
		if (config.digest === current) {
			return config.kind === "config" ? config.skipped : [];
		}
		if (config.kind === "none") {
			// None here now means none there: a copy of a configuration the
			// person deleted is not their configuration any more.
			const removed = await shell.sh(
				`rm -rf -- ${shellQuote(paths.configCopy)} && printf 'none\\n' > ${shellQuote(paths.configDigest)}`,
			);
			if (removed.code !== 0) {
				throw new Error(
					`DevHub could not remove ${paths.configCopy} on ${shell.name}: ${lastLine(removed.stderr)}`,
				);
			}
			return [];
		}
		const unpack = await shell.sh(
			unpackConfigScript(paths.configCopy, paths.configDigest, config.digest),
			{ stdin: config.tarball, timeoutMs: INSTALL_TIMEOUT_MS },
		);
		if (unpack.code !== 0) {
			throw new Error(
				`DevHub could not copy your Neovim configuration to ${paths.configCopy} on ${shell.name}: ${lastLine(unpack.stderr)}`,
			);
		}
		return config.skipped;
	}
}

function capitalised(sentence: string): string {
	return sentence.length === 0
		? sentence
		: `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}
