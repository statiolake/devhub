/**
 * The programs DevHub puts on a machine, fetched here and never there.
 *
 * Two of them, by one mechanism:
 *
 * - **tmux.** DevHub runs every terminal and every Agent inside tmux on the
 *   machine the Workspace lives on, and it runs *its own* tmux there — never
 *   one it found. tmux's control output differs between versions in ways that
 *   surface as an Agent whose output is subtly wrong rather than as an error
 *   (`docs/remote-ssh.md`, `scripts/build_tmux.py`).
 * - **bash**, for Claude Code only, and only where the host has neither bash
 *   nor zsh. Claude Code refuses to start without one of the two — busybox `sh`
 *   is not accepted — and the host this exists for, a Synology NAS with no
 *   package manager and no sudo, has neither (`scripts/build_bash.py`,
 *   `agentShell.ts`).
 *
 * "Install it" is not an instruction the owner of such a host can follow, so
 * DevHub publishes each as one static tarball per platform on a release of
 * this repository and installs it the same way.
 *
 * **This Mac fetches; the host receives.** The tarball is downloaded here, over
 * this DevHub's own network, and handed to the host as bytes on the stdin of a
 * `tar`. Nothing on the host reaches the internet: a NAS behind a firewall has
 * no route to github.com, half the appliances that need this have no `curl` and
 * the ones that do have a `curl` too old for a modern TLS — and a design where
 * the far end downloads would have to be right about all three. The far end
 * unpacks a stream, which is the one thing every one of them can do.
 *
 * The cache is per-DevHub-profile and keyed on the exact tarball name — which
 * names the tool, the platform and the version — so a second host of the same
 * platform costs no second download, and a version bump fetches beside the old
 * one rather than over it.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** What DevHub delivers. The name is the binary's and the tarball's. */
export type HostTool = "tmux" | "bash";

/** Where one tool comes from, as far as a `Runtime` is concerned. */
export interface ToolDelivery {
	readonly tool: HostTool;
	/** The version DevHub installs, which is the directory it installs into. */
	readonly version: string;
	/**
	 * Where the version directories go, relative to the host's `$HOME`.
	 *
	 * `.devhub-server/<tool>` — beside the remote extension host, under the
	 * same `serverDataFolderName`, and versioned for the same reason the server
	 * is keyed on a commit: two DevHubs of different ages on one host each find
	 * their own and neither disturbs the other.
	 */
	readonly directory: string;
	/** The tarball for one `<os>-<arch>`, from the cache or from the release. */
	tarball(platform: string): Promise<ToolTarball>;
}

export interface ToolTarball {
	readonly bytes: Uint8Array;
	/**
	 * The single directory inside the archive.
	 *
	 * The build names it after the tool and the platform and nothing else, so
	 * the unpack can move that one directory into place rather than needing
	 * `tar --strip-components`, which is not in every host's `tar`.
	 */
	readonly topLevelDirectory: string;
	/** `undefined` when this build states no digest for this platform. */
	readonly verifiedSha256: string | undefined;
}

export interface ReleaseToolDeliveryOptions {
	readonly tool: HostTool;
	readonly version: string;
	/** `toolInstallDirectory(serverDataFolderName, tool)`. */
	readonly directory: string;
	/** `product.json`'s `<tool>DownloadUrlTemplate`. */
	readonly urlTemplate: string;
	/**
	 * The digest of each platform's tarball, by `<os>-<arch>`
	 * (`product.json`'s `<tool>DownloadSha256`).
	 *
	 * A platform named here is a platform whose bytes must match, and a download
	 * that does not is thrown away rather than installed. A platform *not* named
	 * here is fetched over HTTPS from a release tag that never moves, and the
	 * fact that it was taken unpinned is carried on the tarball and said in the
	 * log — the release lane fills this in, and until it has, "no digest was
	 * stated" is a thing to be able to read rather than a thing to guess about.
	 */
	readonly sha256: Readonly<Record<string, string>>;
	/** Where fetched tarballs are kept, under this DevHub profile's own data. */
	readonly cacheDirectory: string;
	/** For tests: how the bytes are fetched. */
	readonly fetchBytes?: (url: string) => Promise<Uint8Array>;
}

/**
 * The three names a URL template takes, substituted here and nowhere else:
 * `${<tool>Version}` (`${tmuxVersion}`, `${bashVersion}`), `${os}`, `${arch}`.
 *
 * `${version}` and `${commit}` mean VS Code's version and commit in VS Code's
 * own `serverDownloadUrlTemplate`, so these templates deliberately do not
 * reuse them: one name, one meaning, across one `product.json`.
 */
export function toolDownloadUrl(
	template: string,
	tool: HostTool,
	platform: string,
	version: string,
): string {
	const [os = "", arch = ""] = platform.split("-");
	return template
		.replaceAll(`\${${tool}Version}`, version)
		.replaceAll("${os}", os)
		.replaceAll("${arch}", arch);
}

/**
 * Where a tool's version directories go on a machine, relative to its
 * `$HOME`.
 *
 * Beside the remote extension host, under the same `serverDataFolderName`, and
 * one statement of it: the runtime reads it off the delivery it was given
 * rather than knowing it, so there is no second copy to be right about when
 * `product.json` says something else.
 */
export function toolInstallDirectory(
	serverDataFolderName: string,
	tool: HostTool,
): string {
	return `${serverDataFolderName}/${tool}`;
}

/** The single directory inside a tool's tarball for one platform. */
export function toolTopLevelDirectory(
	tool: HostTool,
	platform: string,
): string {
	return `devhub-${tool}-${platform}`;
}

/** The name a platform's tarball has, on the release and in the cache. */
export function toolTarballName(
	tool: HostTool,
	platform: string,
	version: string,
): string {
	return `devhub-${tool}-${platform}-${version}.tar.gz`;
}

/**
 * What the installed binary is asked, to prove it runs on that machine.
 *
 * Asked before an install (an answer means there is nothing to do) and after
 * one (no answer means what came out cannot run there).
 */
export function toolVersionArgument(tool: HostTool): string {
	return tool === "tmux" ? "-V" : "--version";
}

export class ReleaseToolDelivery implements ToolDelivery {
	readonly tool: HostTool;
	readonly version: string;
	readonly directory: string;
	readonly #options: ReleaseToolDeliveryOptions;
	readonly #fetching = new Map<string, Promise<ToolTarball>>();

	constructor(options: ReleaseToolDeliveryOptions) {
		this.tool = options.tool;
		this.version = options.version;
		this.directory = options.directory;
		this.#options = options;
	}

	/**
	 * One download per platform per DevHub start, however many hosts ask.
	 *
	 * The promise is cached and not the bytes, because two hosts of the same
	 * platform coming up together must produce one download rather than two
	 * that race onto the same cache file.
	 */
	tarball(platform: string): Promise<ToolTarball> {
		const existing = this.#fetching.get(platform);
		if (existing) return existing;
		const pending = this.#obtain(platform);
		// A download that failed must be tried again by the next host to ask:
		// a rejected promise left here would answer every later ask with the
		// failure of the first one.
		pending.catch(() => {
			if (this.#fetching.get(platform) === pending) {
				this.#fetching.delete(platform);
			}
		});
		this.#fetching.set(platform, pending);
		return pending;
	}

	async #obtain(platform: string): Promise<ToolTarball> {
		if (this.version === "" || this.#options.urlTemplate === "") {
			// A build whose `product.json` states nothing for this tool: there is
			// no URL to fetch, and a request for `devhub--linux-x64-.tar.gz` would
			// arrive as a 404 that says nothing about why.
			throw new Error(
				`this build of DevHub states no ${this.tool} release to install ` +
					`(product.json has no ${this.tool}Version or ` +
					`${this.tool}DownloadUrlTemplate)`,
			);
		}
		const pinned = this.#options.sha256[platform];
		const cached = join(
			this.#options.cacheDirectory,
			toolTarballName(this.tool, platform, this.version),
		);
		const fromCache = await readFile(cached).catch(() => undefined);
		if (fromCache !== undefined && matches(fromCache, pinned)) {
			return this.#tarballOf(platform, fromCache, pinned);
		}
		const url = toolDownloadUrl(
			this.#options.urlTemplate,
			this.tool,
			platform,
			this.version,
		);
		const fetchBytes = this.#options.fetchBytes ?? downloadBytes;
		const bytes = await fetchBytes(url);
		if (!matches(bytes, pinned)) {
			throw new Error(
				`the ${this.tool} ${this.version} tarball for ${platform} downloaded ` +
					`from ${url} is not what this build of DevHub is pinned to: it ` +
					`hashes to ${sha256Of(bytes)} and the pin says ${String(pinned)}`,
			);
		}
		// Written under a temporary name and renamed, so a download interrupted
		// half way through is not a cache entry the next start reads as whole.
		await mkdir(this.#options.cacheDirectory, { recursive: true, mode: 0o700 });
		const partial = `${cached}.part`;
		await writeFile(partial, bytes, { mode: 0o600 });
		await rename(partial, cached);
		return this.#tarballOf(platform, bytes, pinned);
	}

	#tarballOf(
		platform: string,
		bytes: Uint8Array,
		pinned: string | undefined,
	): ToolTarball {
		return {
			// A plain `Uint8Array` whichever way it arrived: `readFile` gives a
			// `Buffer` and `fetch` does not, and a caller that could be handed
			// either is a caller that will one day be right about only one.
			bytes: new Uint8Array(bytes),
			topLevelDirectory: toolTopLevelDirectory(this.tool, platform),
			verifiedSha256: pinned,
		};
	}
}

function matches(bytes: Uint8Array, pinned: string | undefined): boolean {
	return pinned === undefined || sha256Of(bytes) === pinned;
}

function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The bytes of one release asset.
 *
 * A release asset URL on github.com answers with a redirect to object storage,
 * which `fetch` follows by default — the one behaviour this depends on, said
 * here so that a change to it is a change to a line rather than a mystery.
 */
async function downloadBytes(url: string): Promise<Uint8Array> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`${url} answered ${String(response.status)} ${response.statusText}`,
		);
	}
	return new Uint8Array(await response.arrayBuffer());
}
