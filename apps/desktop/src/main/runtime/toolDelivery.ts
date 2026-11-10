/**
 * The programs DevHub puts on a machine it reaches over SSH. Every one comes
 * from inside the app; none is downloaded at runtime (`docs/bundled-binaries.md`).
 *
 * - **tmux.** DevHub runs every terminal and every Agent inside tmux on the
 *   machine the Workspace lives on, and it runs *its own* tmux there — never
 *   one it found. tmux's control output differs between versions in ways that
 *   surface as an Agent whose output is subtly wrong rather than as an error
 *   (`docs/remote-ssh.md`, `scripts/build_tmux.py`).
 * - **bash**, the shell every Claude Agent on the host runs in
 *   (`CLAUDE_CODE_SHELL`), whatever bash or zsh the host has of its own
 *   (`scripts/build_bash.py`, `agentShell.ts`).
 * - **nvim**, the Neovim DevHub draws (`docs/neovim-editor.md`, "Which
 *   Neovim"): Neovim's own release archive, the same version this Mac runs.
 * - **node, rg, fd**, beside the carried Neovim: Node's official LTS archive
 *   (language servers run on it), and ripgrep's and fd's static musl builds.
 * - **devhub**, the `devhub` command (`cli/`, Go, `docs/devhub-cli.md`),
 *   built with the app (`bundledTool.ts`).
 *
 * **The app carries them; the host receives.** The app build
 * (`scripts/fetch-binaries.mjs`) downloads every pinned asset for every Linux
 * architecture, checks its sha256 against `product.json`, and leaves each
 * tool's tarball, still compressed, in `out/host-tools/<os>-<arch>/`, with
 * `out/host-tools/manifest.json` naming them. tmux and bash come from
 * DevHub's own tools release (`scripts/build_tools.py`), and the rest from
 * upstream. On a host, the tarball is sent as bytes over the connection that
 * is already open, to the stdin of a `tar`. Neither this Mac nor the host
 * reaches the internet for it. A NAS behind a firewall has no route to
 * github.com, and DevHub on a laptop with no network still connects to the
 * host on the next desk.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** What DevHub delivers. The name is the binary's. */
export type HostTool =
	| "tmux"
	| "bash"
	| "nvim"
	| "devhub"
	| "node"
	| "rg"
	| "fd";

/** Where one tool comes from, as far as a `Runtime` is concerned. */
export interface ToolDelivery {
	readonly tool: HostTool;
	/** The version DevHub installs, which is the directory it installs into. */
	readonly version: string;
	/**
	 * Where the version directories go, relative to the host's `$HOME`.
	 *
	 * `.devhub-server/<tool>` — under the `serverDataFolderName`, and
	 * versioned so that two DevHubs of different ages on one host each find
	 * their own and neither disturbs the other.
	 */
	readonly directory: string;
	/** The tarball for one `<os>-<arch>`, from inside the app. */
	tarball(platform: string): Promise<ToolTarball>;
}

export interface ToolTarball {
	readonly bytes: Uint8Array;
	/**
	 * Absent: a `.tar.gz` holding `topLevelDirectory`. `"binary"`: the
	 * program itself, one static file, which the install writes to
	 * `bin/<tool>` (the app's own `devhub`, `bundledTool.ts`).
	 */
	readonly format?: "binary";
	/**
	 * The single directory inside the archive, which the install moves into
	 * place: no `tar --strip-components`, which is not in every host's `tar`.
	 */
	readonly topLevelDirectory: string;
	/** The digest the bytes were checked against. */
	readonly verifiedSha256: string;
}

/**
 * Where a tool's version directories go on a machine, relative to its
 * `$HOME`. One statement of it: the runtime reads it off the delivery.
 */
export function toolInstallDirectory(
	serverDataFolderName: string,
	tool: HostTool,
): string {
	return `${serverDataFolderName}/${tool}`;
}

/**
 * Where the binary is inside its version directory: `bin/<tool>`, except
 * ripgrep's and fd's archives, which put it at the top. The app build
 * checks every bundled tarball has it there (`fetch-binaries.mjs`, the
 * manifest's `binary`).
 */
export function toolBinaryPath(tool: HostTool): string {
	return tool === "rg" || tool === "fd" ? tool : `bin/${tool}`;
}

/**
 * What the installed binary is asked, to prove it runs on that machine.
 *
 * Asked before an install (an answer means there is nothing to do) and after
 * one (no answer means what came out cannot run there).
 */
export function toolVersionArgument(tool: HostTool): string {
	switch (tool) {
		case "tmux":
			return "-V";
		// `devhub --version` asks the running DevHub over its socket, which a
		// host may not have yet; `--help` answers from the binary alone.
		case "devhub":
			return "--help";
		default:
			return "--version";
	}
}

/** `out/host-tools/manifest.json`, as `fetch-binaries.mjs` writes it. */
export interface HostToolsManifest {
	readonly tools: Readonly<
		Partial<
			Record<
				HostTool,
				{
					readonly version: string;
					readonly binary: string;
					readonly platforms: Readonly<
						Record<
							string,
							{
								readonly file: string;
								readonly sha256: string;
								readonly topLevelDirectory: string;
							}
						>
					>;
				}
			>
		>
	>;
}

/**
 * One tool from the app's `out/host-tools`.
 *
 * `root` is that directory. A build without it (no `manifest.json`) still
 * makes a delivery, whose every `tarball` names the build step: a runtime is
 * made for every host whether or not it ever asks.
 */
export class BundledArchiveDelivery implements ToolDelivery {
	readonly tool: HostTool;
	readonly version: string;
	readonly directory: string;
	readonly #root: string;
	readonly #entry: HostToolsManifest["tools"][HostTool];
	readonly #missing: string | undefined;

	constructor(tool: HostTool, directory: string, root: string) {
		this.tool = tool;
		this.directory = directory;
		this.#root = root;
		const path = join(root, "manifest.json");
		let manifest: HostToolsManifest | undefined;
		try {
			manifest = JSON.parse(readFileSync(path, "utf8")) as HostToolsManifest;
		} catch {
			manifest = undefined;
		}
		this.#entry = manifest?.tools[tool];
		this.version = this.#entry?.version ?? "";
		this.#missing =
			manifest === undefined
				? `${path} is not there, so no machine can be given DevHub's ${tool}. ` +
					"It is produced by `pnpm --filter @devhub/desktop build:binaries`."
				: this.#entry === undefined
					? `this build of DevHub bundles no ${tool} for SSH hosts (${path})`
					: undefined;
	}

	async tarball(platform: string): Promise<ToolTarball> {
		if (this.#missing !== undefined) throw new Error(this.#missing);
		const bundled = this.#entry?.platforms[platform];
		if (bundled === undefined) {
			throw new Error(
				`this build of DevHub bundles ${this.tool} for ` +
					`${Object.keys(this.#entry?.platforms ?? {}).join(", ")}, not ${platform}`,
			);
		}
		const path = join(this.#root, bundled.file);
		const bytes = new Uint8Array(await readFile(path));
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (digest !== bundled.sha256) {
			throw new Error(
				`${path} hashes to ${digest}, and the build pinned ${bundled.sha256}: ` +
					"the app's own copy is damaged",
			);
		}
		return {
			bytes,
			topLevelDirectory: bundled.topLevelDirectory,
			verifiedSha256: bundled.sha256,
		};
	}
}

/** For `setRuntimeProfile`: a tool from `out/host-tools`. */
export function bundledHostTool(
	tool: HostTool,
	directory: string,
	root: string,
): ToolDelivery {
	return new BundledArchiveDelivery(tool, directory, root);
}
