/**
 * A program DevHub builds with the app and puts on a host as one file, rather
 * than as a tarball (`toolDelivery.ts`): the `devhub` command (`cli/`,
 * `docs/devhub-cli.md`).
 *
 * The same `ToolDelivery` tmux, bash and nvim are carried by, so a host
 * installs it the same way — `~/<serverDataFolderName>/<tool>/<version>/bin/
 * <tool>`, asked before and after — and only where the bytes come from
 * differs. The app build leaves one static binary per platform in
 * `out/cli/<os>-<arch>/<tool>` and their digests in `out/cli/SHA256SUMS`
 * (`scripts/build-devhub-cli.mjs`); the packaged app carries `out/` whole.
 * Nothing is downloaded and nothing is published: unlike tmux and bash, the
 * command is one build with the app, and a host holds the command of the
 * DevHub that connects to it.
 *
 * **The version is the build's.** The first 12 hex digits of the digest of
 * `SHA256SUMS`: every binary's digest, so any change to any of them is a new
 * version directory beside the old one, and a rebuild of the same source —
 * the build is reproducible (`-trimpath`, no cgo) — installs nothing. The
 * command and the app it talks to are one build, and this is how a host
 * holds the command of the DevHub that connects to it.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostTool, ToolDelivery, ToolTarball } from "./toolDelivery.js";

export class BundledToolDelivery implements ToolDelivery {
	readonly tool: HostTool;
	readonly version: string;
	readonly directory: string;
	readonly #root: string;
	readonly #sums: ReadonlyMap<string, string>;
	readonly #missing: string | undefined;

	/**
	 * `root` is the build's `out/cli`. A build without it (`SHA256SUMS` not
	 * there) still makes a delivery, whose every `tarball` names the build
	 * step: a runtime is made for every host whether or not it ever asks.
	 */
	constructor(tool: HostTool, directory: string, root: string) {
		this.tool = tool;
		this.directory = directory;
		this.#root = root;
		const sumsPath = join(root, "SHA256SUMS");
		let text: string | undefined;
		try {
			text = readFileSync(sumsPath, "utf8");
		} catch {
			text = undefined;
		}
		this.#missing =
			text === undefined
				? `${sumsPath} is not there, so no machine can be given a '${tool}' ` +
					"command. It is produced by `pnpm --filter @devhub/desktop build` " +
					"(the build:devhub-cli step)."
				: undefined;
		this.version =
			text === undefined ? "" : sha256Of(Buffer.from(text)).slice(0, 12);
		this.#sums = parseSums(text ?? "");
	}

	async tarball(platform: string): Promise<ToolTarball> {
		if (this.#missing !== undefined) throw new Error(this.#missing);
		const name = `${platform}/${this.tool}`;
		const pinned = this.#sums.get(name);
		if (pinned === undefined) {
			throw new Error(
				`this build of DevHub has no ${this.tool} for ${platform} ` +
					`(${join(this.#root, "SHA256SUMS")} lists ${[...this.#sums.keys()].join(", ")})`,
			);
		}
		const path = join(this.#root, name);
		const bytes = new Uint8Array(await readFile(path));
		const digest = sha256Of(bytes);
		if (digest !== pinned) {
			throw new Error(
				`${path} hashes to ${digest}, and the build said ${pinned}: ` +
					"the app's own copy is damaged",
			);
		}
		return {
			bytes,
			format: "binary",
			topLevelDirectory: "",
			verifiedSha256: pinned,
		};
	}
}

/** `<sha256>  <platform>/<tool>` per line, as `sha256sum` writes it. */
function parseSums(text: string): ReadonlyMap<string, string> {
	const sums = new Map<string, string>();
	for (const line of text.split("\n")) {
		const match = /^([0-9a-f]{64}) {2}(\S+)$/u.exec(line.trim());
		if (match?.[1] !== undefined && match[2] !== undefined) {
			sums.set(match[2], match[1]);
		}
	}
	return sums;
}

function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** For `setRuntimeProfile`: the delivery of one bundled tool. */
export function bundledToolDelivery(
	tool: HostTool,
	directory: string,
	root: string,
): ToolDelivery {
	return new BundledToolDelivery(tool, directory, root);
}
