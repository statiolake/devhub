/**
 * The remote extension host DevHub puts on a machine, and the endpoint it
 * answers on.
 *
 * A workbench opened on `vscode-remote://ssh-remote+<host>/…` is a client with
 * nothing to talk to until somebody installs VS Code's server over there,
 * starts it, and produces a TCP port on *this* Mac that reaches it. That used
 * to be a vendored extension's job — it SSHed in with a JavaScript client of
 * its own, ran a generated bash script, scraped a port out of a log and opened
 * its own tunnel. DevHub already holds a connection to that machine, already
 * knows how to run POSIX `sh` on it, and already delivers payloads there for
 * tmux. So it does this too, and the extension shrinks to the one thing only
 * an extension can do: answer `onResolveRemoteAuthority` with the port DevHub
 * produced.
 *
 * **The server travels inside DevHub.** The app carries one REH tarball per
 * Linux platform it supports — glibc and musl, x64 and arm64 — built from the
 * same patched VS Code the app itself is built from, and copies the one the
 * machine needs over the connection it already has: the bytes go on the stdin
 * of a `tar` over there. Nothing on the far machine reaches the internet, and
 * nothing on this Mac does either. A dev container on a network with no route
 * out, an SSH host behind a firewall, an appliance whose `curl` is too old for
 * a modern TLS: DevHub reaches all of them already, so it can hand them a
 * server. And a server that came out of the app is a server built from the
 * app's own patches, which a server published separately and keyed only by
 * the VS Code commit never was.
 *
 * **A unix socket, not a port.** The server is started with `--socket-path` and
 * reached with `ssh -L <local port>:<remote socket>`, which OpenSSH has
 * supported since 6.7. A `--port=0` server would have to be asked which port it
 * picked, and the only place it says so is its own log — so the connection
 * would depend on scraping a line out of a file whose format is upstream's to
 * change. A socket path is a name DevHub chose, so there is nothing to discover
 * and nothing to parse.
 *
 * **The token file is the single source of truth.** A server that is already
 * running was started against whatever is in it, and a DevHub that generated a
 * fresh token for it would fail the handshake with a message that does not say
 * "wrong token" — `remoteAgentConnection.ts` just sees a connection that does
 * not come up. So the token is offered on stdin, written only if the file is
 * not there, and *read back out of the file* either way.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { shellQuote } from "./quote.js";

/** Where a machine's remote extension host comes from, as far as a runtime
 * is concerned. */
export interface RehDelivery {
	/**
	 * The directory the server is installed under on every machine:
	 * `<VS Code commit>-<server identity>` — see `rehInstallKey`.
	 *
	 * `undefined` only when this build states neither half, which is a build
	 * that can open no remote workbench at all — see `sourceBuildRefusal`.
	 */
	readonly installKey: string | undefined;
	/** `product.json`'s `serverDataFolderName`: `.devhub-server`. */
	readonly dataFolderName: string;
	/** `product.json`'s `serverApplicationName`: the script under `bin/`. */
	readonly applicationName: string;
	/**
	 * The tarball for one `RehTarget`, read out of the bundle and checked.
	 *
	 * Rejects — permanently, see `permanent` — when this DevHub carries no
	 * server for that target, or carries one that is not the one it states.
	 */
	tarball(target: RehTarget): Promise<RehTarball>;
}

export interface RehTarball {
	readonly bytes: Uint8Array;
	/**
	 * The single directory inside the archive.
	 *
	 * `scripts/build_reh.py` names it after the target, so the unpack can move
	 * that one directory into place rather than needing
	 * `tar --strip-components`, which is not in every machine's `tar`.
	 */
	readonly topLevelDirectory: string;
	/** What the bytes hash to — checked against the bundle's own statement. */
	readonly sha256: string;
}

/**
 * What one machine's endpoint is, once there is a server behind it.
 *
 * This is the whole of what the resolver extension is told, and deliberately:
 * a host name, an install directory and a socket path are DevHub's business,
 * and an extension that knew them would be an extension with a second opinion
 * about them.
 */
export interface RemoteServerEndpoint {
	/** On 127.0.0.1, on this Mac. */
	readonly port: number;
	readonly connectionToken: string;
	/**
	 * What the extension host over there needs in its environment.
	 *
	 * Only ever `SSH_AUTH_SOCK` today, and only when the person's own ssh
	 * config forwards an agent to that machine — DevHub does not open an agent
	 * channel of its own. `undefined` rather than an empty object when there is
	 * nothing to add, so "nothing to say" and "an environment with nothing in
	 * it" are not the same answer.
	 */
	readonly extensionHostEnv: Readonly<Record<string, string>> | undefined;
}

/** A machine DevHub can produce a local endpoint on. */
export interface RemoteServerHost {
	/**
	 * Install the server if it is not there, start it if it is not running,
	 * forward it here, and say where.
	 *
	 * Idempotent and cheap on the happy path, which is not an optimisation: VS
	 * Code calls `resolve()` again on *every* reconnect, so a lid closed and
	 * reopened would otherwise restart the extension host on the far machine
	 * every time. A server still answering on a forward that still stands
	 * re-answers with the same port and the same token.
	 */
	remoteServer(delivery: RehDelivery): Promise<RemoteServerEndpoint>;

	/**
	 * A window is opening on this machine — bring up whatever that needs.
	 *
	 * Optional, because most machines have nothing to bring up: an ssh host is
	 * either there or it is not, and DevHub does not start computers. A dev
	 * container does have something, and `devcontainer up` is expensive enough
	 * (it may build an image) and surprising enough (it undoes a `docker stop`
	 * the person just ran) that it must not sit on a path a timer can reach.
	 *
	 * So it is called on the *first* resolve of a window and never on a
	 * reconnect, which is the one place DevHub can tell "somebody opened this"
	 * from "this is trying to come back". `resolveAttempt` is that fact and it
	 * is already on the wire.
	 */
	prepare?(): Promise<void>;
}

/**
 * Whether asking again could get a different answer, carried on the failure.
 *
 * VS Code picks between two behaviours from the error class the resolver
 * throws: `TemporarilyNotAvailable` is retried by both of its loops,
 * `NotAvailable` makes it give up at once and show the message. So somebody has
 * to decide, and the only place that can is where the failure happened — a host
 * that is asleep will come back, a host running an architecture nobody has
 * built a server for will not.
 *
 * It is a mark on the error rather than a rule applied to its wording, because
 * a rule applied to wording is a rule that is wrong the first time somebody
 * rephrases a sentence, and wrong silently: the workbench either gives up on
 * something that would have worked or retries something that never will, and
 * neither says which happened.
 *
 * Transient is the default, and deliberately. The two mistakes are not equal: a
 * resolve that goes on retrying stops on VS Code's own attempt limit and says
 * so, and a resolve that wrongly gave up needs the window reopening by hand.
 * So only the failures DevHub is *sure* about are marked, and everything it has
 * no opinion on is tried again.
 */
const PERMANENT = Symbol.for("devhub.remoteRefusal.permanent");

/** Say that no amount of asking again will change this answer. */
export function permanent<E extends Error>(failure: E): E {
	Object.defineProperty(failure, PERMANENT, { value: true });
	return failure;
}

export function isPermanent(failure: unknown): boolean {
	return (
		typeof failure === "object" &&
		failure !== null &&
		(failure as Record<symbol, unknown>)[PERMANENT] === true
	);
}

/**
 * Which VS Code commit this DevHub's workbench and its servers are built from.
 *
 * A packaged build states it twice: `commit`, which VS Code reads, and
 * `serverCommit`, which only DevHub reads — the same forty characters, both
 * from `scripts/product_metadata.py`. A source run states only `serverCommit`.
 * It has no `commit` and cannot be given one — VS Code reads that field as
 * "this is a packaged build" and sends a source run looking for a
 * `node_modules.asar` a checkout does not have — but it is still built from
 * one VS Code commit, the submodule's. The server compares a client's commit
 * with its own only when the client states one
 * (`remoteExtensionHostAgentServer.ts`: `if (rendererCommit && myCommit)`), so
 * a source run's commit-less workbench is accepted by a server whose
 * `product.json` states the commit, and a packaged workbench is accepted by
 * the server bundled with it because both state the same one.
 */
export function rehCommit(product: {
	readonly commit?: string;
	readonly serverCommit?: string;
}): string | undefined {
	return product.commit ?? product.serverCommit;
}

/**
 * The directory a server is installed under on a far machine:
 * `<commit>-<identity>`.
 *
 * The commit alone is not enough, and that was a real failure rather than a
 * theoretical one: DevHub's servers are VS Code *plus DevHub's patches*, and a
 * patch that changed the server did not change the commit, so every machine
 * that had a server went on running the old one under the same name. The
 * identity is `scripts/product_metadata.py`'s `reh_identity()` — a hash of the
 * commit, every file in `patches/vscode/` and the server build's own revision
 * — stated by the app as `serverIdentity` and by every bundled server beside
 * its tarball. A DevHub whose patches changed names a directory no older
 * DevHub installed, so it installs a fresh server instead of adopting a stale
 * one, and two DevHubs of different patch sets on one machine each keep their
 * own.
 */
export function rehInstallKey(
	commit: string | undefined,
	identity: string | undefined,
): string | undefined {
	if (commit === undefined || identity === undefined) return undefined;
	if (commit.length === 0 || identity.length === 0) return undefined;
	return `${commit}-${identity}`;
}

/**
 * Why this DevHub cannot open a remote workbench, said once.
 *
 * Only a run that states no commit or no server identity gets here: a source
 * run started some other way than `apps/desktop/scripts/dev.sh`, which is
 * what writes both, or one whose `vscode/product.overrides.json` predates the
 * fields. There is then no install directory to name and no bundled server to
 * check, and asking again cannot change that while this DevHub runs, which is
 * what makes it `NotAvailable` rather than something to retry. It names no
 * kind of machine: a dev container and an SSH host refuse alike.
 */
export function sourceBuildRefusal(machine: string): string {
	return (
		`This DevHub states no commit or no server identity for the remote ` +
		`extension host — product.json's commit and serverIdentity in a ` +
		`packaged build, the serverCommit and serverIdentity ` +
		`apps/desktop/scripts/dev.sh writes for a source run — so there is no ` +
		`remote extension host it can install on ${machine}. Start a source run ` +
		`with apps/desktop/scripts/dev.sh — see ` +
		`docs/remote-ssh.md#a-source-run-uses-servers-built-in-the-checkout.`
	);
}

/**
 * The four servers DevHub carries, by the name it gives them.
 *
 * `<libc family>-<arch>`: `linux-*` is glibc, `alpine-*` is musl, which is
 * what upstream calls them too (`vscode/build/gulpfile.reh.ts` builds
 * `linux-x64`, `linux-arm64`, `alpine-arm64` and — its legacy spelling for
 * the fourth — `linux-alpine`). A glibc server does not start on musl: its
 * `node` is linked against `ld-linux`, which an Alpine image does not have,
 * and its native addons against glibc symbols. So the libc is part of the
 * platform, not a detail of it.
 */
export const REH_TARGETS = [
	"linux-x64",
	"linux-arm64",
	"alpine-x64",
	"alpine-arm64",
] as const;

export type RehTarget = (typeof REH_TARGETS)[number];

/**
 * Which C library a Linux machine runs its programs against, asked in `sh`.
 *
 * In this order, because each earlier answer is the more specific one:
 *
 * - `/etc/alpine-release` is Alpine, which is musl even with `gcompat`
 *   installed — `gcompat` puts an `ld-linux` beside musl's own loader, and a
 *   glibc `node` then starts and falls over on the first native addon.
 * - `getconf GNU_LIBC_VERSION` answers only on glibc; musl's `getconf`
 *   refuses the name. That puts a Debian that has the `musl` package
 *   installed (and so a `/lib/ld-musl-*.so.1`) on glibc, which is right.
 * - The loaders themselves, for a machine with neither of those — a
 *   distroless image has no `getconf`.
 *
 * Anything else is `unknown`, and an unknown libc is refused by name rather
 * than guessed at: a guess that is wrong installs a server that cannot start,
 * and the sentence that then reaches the person is about a socket.
 */
export const LIBC_PROBE = [
	`if [ -f /etc/alpine-release ]; then echo musl; exit 0; fi`,
	`if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then echo glibc; exit 0; fi`,
	`for f in /lib/ld-musl-*.so.1; do [ -e "$f" ] && { echo musl; exit 0; }; done`,
	`for f in /lib64/ld-linux-*.so.* /lib/ld-linux-*.so.* /lib/*/ld-linux-*.so.*; do [ -e "$f" ] && { echo glibc; exit 0; }; done`,
	`echo unknown`,
].join("\n");

export type Libc = "glibc" | "musl" | "unknown";

export function parseLibc(stdout: string): Libc {
	const answer = stdout.trim().split("\n").pop()?.trim();
	return answer === "glibc" || answer === "musl" ? answer : "unknown";
}

/** What a machine is, as far as choosing its server is concerned. */
export interface RehMachine {
	/** `uname -s`: `Linux`, `Darwin`. */
	readonly system: string;
	/** `uname -m`, folded: `x64`, `arm64`, or the machine's own word. */
	readonly architecture: string;
	/** Only asked of a Linux machine; `undefined` for anything else. */
	readonly libc: Libc | undefined;
}

/**
 * The server a machine needs, or `undefined` when DevHub has none for it.
 *
 * Linux only. macOS has a server upstream, but DevHub does not carry one: its
 * native addons have to be built on a Mac, and nobody SSHes from DevHub into
 * a Mac often enough to carry its weight in every download.
 */
export function rehTargetFor(machine: RehMachine): RehTarget | undefined {
	if (machine.system !== "Linux") return undefined;
	const family =
		machine.libc === "glibc"
			? "linux"
			: machine.libc === "musl"
				? "alpine"
				: undefined;
	if (family === undefined) return undefined;
	const target = `${family}-${machine.architecture}`;
	return (REH_TARGETS as readonly string[]).includes(target)
		? (target as RehTarget)
		: undefined;
}

/** A machine described the way a person would recognise it. */
export function describeRehMachine(machine: RehMachine): string {
	const libc =
		machine.libc === undefined
			? ""
			: machine.libc === "unknown"
				? ", with a C library DevHub could not identify"
				: machine.libc === "musl"
					? ", musl"
					: ", glibc";
	return `${machine.system} ${machine.architecture}${libc}`;
}

/** What a target is, in the words `describeRehMachine` uses. */
function describeTarget(target: string): string {
	const [family = "", arch = ""] = target.split("-");
	return `Linux ${arch}, ${family === "alpine" ? "musl" : "glibc"}`;
}

/**
 * The sentence for a machine DevHub carries no server for at all.
 *
 * Permanent where it is thrown: an architecture does not change while a
 * workbench waits.
 */
export function unsupportedServerPlatform(
	machine: string,
	description: RehMachine,
): string {
	return (
		`DevHub has no remote extension host for ${machine}, which is ` +
		`${describeRehMachine(description)}. It carries servers for Linux on ` +
		`x64 and arm64, with glibc or musl (${REH_TARGETS.join(", ")}), and ` +
		`nothing else.`
	);
}

/** The single directory inside the tarball for one target. */
export function rehTopLevelDirectory(target: string): string {
	return `devhub-reh-${target}`;
}

/** The name a target's tarball has in the bundle. */
export function rehTarballName(target: string): string {
	return `devhub-reh-${target}.tar.gz`;
}

/** The name of the statement beside it. */
export function rehStatementName(target: string): string {
	return `devhub-reh-${target}.json`;
}

/**
 * What `scripts/build_reh.py` writes beside each tarball, read back.
 *
 * It says which commit and which identity the server was built from, so a
 * bundle whose servers are older than the app around them — a checkout whose
 * patches moved since the last `build_reh.py`, or a packaging step handed the
 * wrong artifacts — is refused by name instead of installed under a key that
 * says something it is not.
 */
export interface RehStatement {
	readonly target: string;
	readonly commit: string;
	readonly identity: string;
	readonly file: string;
	readonly sha256: string;
	readonly topLevelDirectory: string;
}

export function parseRehStatement(text: string): RehStatement | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const fields = [
		"target",
		"commit",
		"identity",
		"file",
		"sha256",
		"topLevelDirectory",
	] as const;
	for (const field of fields) {
		if (typeof record[field] !== "string") return undefined;
	}
	return record as unknown as RehStatement;
}

export interface BundledRehDeliveryOptions {
	/** Where the tarballs and their statements are. */
	readonly directory: string;
	/** `rehCommit` of this build's product. */
	readonly commit: string | undefined;
	/** `serverIdentity` of this build's product. */
	readonly identity: string | undefined;
	readonly dataFolderName: string;
	readonly applicationName: string;
	/**
	 * Whether this is a packaged app, which decides what a missing server
	 * means: a packaging bug in one, a step not yet taken in the other — and
	 * so which sentence tells the person what to do.
	 */
	readonly packaged: boolean;
}

/**
 * The servers this DevHub carries.
 *
 * In a packaged app that is `Contents/Resources/reh/`, put there by
 * `scripts/package-nightly.py`; in a source run it is `dist/reh/` in the
 * checkout, where `scripts/build_reh.py` writes. Either way it is a directory
 * of `devhub-reh-<target>.tar.gz` with a `devhub-reh-<target>.json` beside
 * each — the same layout, so there is one reader.
 */
export class BundledRehDelivery implements RehDelivery {
	readonly installKey: string | undefined;
	readonly dataFolderName: string;
	readonly applicationName: string;
	readonly #options: BundledRehDeliveryOptions;
	readonly #reading = new Map<string, Promise<RehTarball>>();

	constructor(options: BundledRehDeliveryOptions) {
		this.installKey = rehInstallKey(options.commit, options.identity);
		this.dataFolderName = options.dataFolderName;
		this.applicationName = options.applicationName;
		this.#options = options;
	}

	/**
	 * One read per target per DevHub start, however many machines ask.
	 *
	 * The promise is kept rather than the bytes, so two machines of the same
	 * target coming up together share one read of a hundred megabytes.
	 */
	tarball(target: RehTarget): Promise<RehTarball> {
		const existing = this.#reading.get(target);
		if (existing) return existing;
		const pending = this.#read(target);
		pending.catch(() => {
			if (this.#reading.get(target) === pending) {
				this.#reading.delete(target);
			}
		});
		this.#reading.set(target, pending);
		return pending;
	}

	async #read(target: RehTarget): Promise<RehTarball> {
		const { directory, commit, identity } = this.#options;
		if (this.installKey === undefined) {
			throw permanent(new Error(sourceBuildRefusal("any machine")));
		}
		const statementText = await readFile(
			join(directory, rehStatementName(target)),
			"utf8",
		).catch(() => undefined);
		if (statementText === undefined) {
			throw permanent(
				new Error(await this.#missing(target, await this.#available())),
			);
		}
		const statement = parseRehStatement(statementText);
		if (statement === undefined || statement.target !== target) {
			throw permanent(
				new Error(
					`${join(directory, rehStatementName(target))} is not a statement ` +
						`of the ${target} remote extension host. ${this.#rebuild(target)}`,
				),
			);
		}
		if (statement.commit !== commit || statement.identity !== identity) {
			throw permanent(
				new Error(
					`The ${target} remote extension host in ${directory} was built ` +
						`from VS Code ${statement.commit.slice(0, 12)} with server ` +
						`identity ${statement.identity}, and this DevHub is ` +
						`${String(commit).slice(0, 12)} with ${String(identity)} — ` +
						`DevHub's patches or its VS Code moved since it was built. ` +
						this.#rebuild(target),
				),
			);
		}
		const bytes = await readFile(join(directory, statement.file)).catch(
			() => undefined,
		);
		if (bytes === undefined) {
			throw permanent(
				new Error(
					`${join(directory, statement.file)} is missing although ` +
						`${rehStatementName(target)} names it. ${this.#rebuild(target)}`,
				),
			);
		}
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		if (sha256 !== statement.sha256) {
			throw permanent(
				new Error(
					`${join(directory, statement.file)} hashes to ${sha256}, not the ` +
						`${statement.sha256} its statement says — it is not the server ` +
						`that was built. ${this.#rebuild(target)}`,
				),
			);
		}
		return {
			// A plain `Uint8Array`, not the `Buffer` `readFile` gives, so a caller
			// is never right about only one of the two.
			bytes: new Uint8Array(bytes),
			topLevelDirectory: statement.topLevelDirectory,
			sha256,
		};
	}

	async #available(): Promise<string[]> {
		const names: string[] = await readdir(this.#options.directory).catch(
			() => [],
		);
		return REH_TARGETS.filter((target) =>
			names.includes(rehStatementName(target)),
		);
	}

	async #missing(target: RehTarget, available: string[]): Promise<string> {
		const holds =
			available.length === 0
				? "holds no servers at all"
				: `holds ${available.join(", ")} only`;
		return (
			`This DevHub has no remote extension host for ${target} ` +
			`(${describeTarget(target)}): ${this.#options.directory} ${holds}. ` +
			this.#rebuild(target)
		);
	}

	#rebuild(target: RehTarget): string {
		return this.#options.packaged
			? `This DevHub was packaged without the server it needs; install a ` +
					`build that carries all four (see docs/remote-ssh.md#the-servers-` +
					`travel-inside-devhub).`
			: `Build it in this checkout with scripts/build_reh.py ${target} — ` +
					`see docs/remote-ssh.md#a-source-run-uses-servers-built-in-the-` +
					`checkout.`;
	}
}

/** Every path the remote extension host has on a machine. */
export interface RemoteServerPaths {
	/** `~/.devhub-server`. */
	readonly root: string;
	/** `~/.devhub-server/bin/<key>`, the tarball's contents. */
	readonly install: string;
	/** `~/.devhub-server/bin/<key>/bin/devhub-server`. */
	readonly server: string;
	/**
	 * The file an install writes last, once its `node` has run on this
	 * machine. A directory without it is an install that did not finish —
	 * interrupted, or unpacked by an older DevHub that did not check — and is
	 * replaced rather than started.
	 */
	readonly installed: string;
	/**
	 * The connection token, 0600.
	 *
	 * Under the root rather than under the install, and named by the key, so
	 * that a new server gets a token of its own: two servers on one machine
	 * are two handshakes, and one token file would make the older one's
	 * clients fail against the newer one's server with nothing that says why.
	 */
	readonly token: string;
	/** The unix socket the server listens on, and the `-L` forward's far end. */
	readonly socket: string;
	/** Where its pid is written, so an already-running server is adoptable. */
	readonly pid: string;
	/** Its own output, for when it started and then failed. */
	readonly log: string;
}

export function remoteServerPaths(request: {
	readonly home: string;
	readonly dataFolderName: string;
	readonly applicationName: string;
	readonly key: string;
}): RemoteServerPaths {
	const root = posix.join(request.home, request.dataFolderName);
	const install = posix.join(root, "bin", request.key);
	return {
		root,
		install,
		server: posix.join(install, "bin", request.applicationName),
		installed: posix.join(install, INSTALLED_MARKER),
		token: posix.join(root, `.${request.key}.token`),
		socket: posix.join(root, `.${request.key}.sock`),
		pid: posix.join(root, `.${request.key}.pid`),
		log: posix.join(root, `.${request.key}.log`),
	};
}

/** The name of `RemoteServerPaths.installed`. */
export const INSTALLED_MARKER = ".devhub-installed";

/** Whether the server under `paths` is a finished install. */
export function serverInstalledScript(paths: RemoteServerPaths): string {
	return `[ -f ${shellQuote(paths.installed)} ] && [ -x ${shellQuote(paths.server)} ]`;
}

/** How long the start script waits for the server to open its socket. */
const SOCKET_WAIT_SECONDS = 60;

/**
 * Start the server, or adopt the one that is already running, and say the
 * token either way.
 *
 * The offered token arrives on **stdin** and never in the script, because the
 * script is the far shell's argv and argv is world-readable in `ps` — a
 * connection token in `ps` is a connection token anyone on that machine can
 * use. It is consumed whether or not it is written, so the writing side is
 * never left with a pipe nobody read.
 *
 * `nohup … &` and not a bare `&`: the ssh channel closes the moment this
 * script returns, sshd sends the process group its `SIGHUP`, and a server that
 * died with the command that started it is a server every `resolve()` would
 * start again. The pid is written so the next `resolve()` can tell "still
 * running" from "the socket file is a leftover".
 *
 * `sleep 1` and not `sleep 0.5`: BusyBox's `sleep` takes whole seconds and
 * refuses a fraction, and the machine this exists for is the one with BusyBox
 * on it.
 */
export function startServerScript(
	paths: RemoteServerPaths,
	/**
	 * A directory to put in front of the server's `PATH`, when there is one:
	 * DevHub's `devhub` command in a dev container, which the terminals and
	 * tasks the server starts inherit. A server already running keeps the PATH
	 * it was started with, which is the same directory — it is per install key.
	 */
	pathPrefix?: string,
): string {
	const root = shellQuote(paths.root);
	const token = shellQuote(paths.token);
	const socket = shellQuote(paths.socket);
	const pid = shellQuote(paths.pid);
	const log = shellQuote(paths.log);
	const server = shellQuote(paths.server);
	return [
		`mkdir -p -- ${root} || exit 1`,
		`chmod 700 ${root} 2>/dev/null || :`,
		// The token file is the single source of truth. A server already running
		// was started against what is in it, and a fresh token would fail the
		// handshake with a message that does not say "wrong token".
		`if [ -f ${token} ]; then`,
		`  cat > /dev/null`,
		`else`,
		`  ( umask 077; cat > ${token} ) || exit 1`,
		`fi`,
		`chmod 600 ${token} 2>/dev/null || :`,
		`running=''`,
		`if [ -S ${socket} ] && [ -f ${pid} ]; then`,
		`  if kill -0 "$(cat ${pid})" 2>/dev/null; then running=yes; fi`,
		`fi`,
		`if [ -z "$running" ]; then`,
		// A socket file left by a server that is gone is a file, and the server
		// will not bind over one.
		`  rm -f -- ${socket}`,
		`  [ -x ${server} ] || { echo ${shellQuote(`${SERVER_MARKER} ${paths.server} is not there`)} >&2; exit 1; }`,
		`  ${pathPrefix === undefined ? "" : `PATH=${shellQuote(pathPrefix)}:"$PATH" `}nohup ${server} --start-server --host=127.0.0.1 \\`,
		`    --socket-path=${socket} --connection-token-file=${token} \\`,
		`    --telemetry-level off --accept-server-license-terms \\`,
		`    --enable-remote-auto-shutdown >> ${log} 2>&1 &`,
		`  echo $! > ${pid}`,
		`  waited=0`,
		`  while [ ! -S ${socket} ]; do`,
		`    waited=$((waited+1))`,
		`    if [ "$waited" -gt ${String(SOCKET_WAIT_SECONDS)} ]; then`,
		`      echo ${shellQuote(`${SERVER_MARKER} the server did not open ${paths.socket}; see ${paths.log}`)} >&2`,
		`      exit 1`,
		`    fi`,
		`    kill -0 "$(cat ${pid})" 2>/dev/null || {`,
		`      echo ${shellQuote(`${SERVER_MARKER} the server exited before opening ${paths.socket}; see ${paths.log}`)} >&2`,
		`      exit 1`,
		`    }`,
		`    sleep 1`,
		`  done`,
		`fi`,
		`printf 'socket=%s\\n' ${socket}`,
		// Read back out of the file, never echoed from what was offered: an
		// already-running server's token is whatever is on disk.
		`printf 'token=%s\\n' "$(cat ${token})"`,
	].join("\n");
}

/** What this script says when it refuses, so its words are distinguishable. */
export const SERVER_MARKER = "devhub-server:";

/** What `startServerScript` printed, read back. */
export interface StartedServer {
	readonly socket: string;
	readonly token: string;
}

/**
 * The two lines the start script prints, parsed.
 *
 * A line-oriented answer of DevHub's own shape rather than a scrape of the
 * server's log: both names are DevHub's, so there is nothing upstream can
 * rename underneath this.
 */
export function parseStartedServer(stdout: string): StartedServer | undefined {
	let socket: string | undefined;
	let token: string | undefined;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("socket="))
			socket = line.slice("socket=".length).trim();
		if (line.startsWith("token=")) token = line.slice("token=".length).trim();
	}
	if (socket === undefined || token === undefined) return undefined;
	if (socket.length === 0 || token.length === 0) return undefined;
	return { socket, token };
}

/**
 * Unpack the server from stdin, prove it runs here, and only then put it in
 * place.
 *
 * Into a staging directory beside the install and moved in whole, so the
 * install directory is either absent or complete — never the half a dropped
 * connection leaves behind. The proof is the server's own `node` running a
 * line of JavaScript on this machine: that is what a wrong platform fails —
 * a glibc `node` on musl is "not found" by its loader, an x64 one on arm64
 * is an exec format error — and it fails here, with the words of that
 * failure, rather than as a socket that never opens a minute later.
 *
 * The marker is written last, inside the staged tree, with the tarball's
 * hash in it, so `serverInstalledScript` can tell a finished install from
 * any other directory of that name.
 */
export function unpackServerScript(
	paths: RemoteServerPaths,
	topLevelDirectory: string,
	sha256: string,
): string {
	const staging = shellQuote(`${paths.install}.unpacking`);
	const unpacked = shellQuote(
		posix.join(`${paths.install}.unpacking`, topLevelDirectory),
	);
	const node = shellQuote(
		posix.join(`${paths.install}.unpacking`, topLevelDirectory, "node"),
	);
	const launcher = shellQuote(
		posix.join(
			`${paths.install}.unpacking`,
			topLevelDirectory,
			posix.relative(paths.install, paths.server),
		),
	);
	const install = shellQuote(paths.install);
	const fail = (sentence: string): string =>
		`{ echo ${shellQuote(`${SERVER_MARKER} ${sentence}`)} >&2; rm -rf -- ${staging}; exit 1; }`;
	return [
		`rm -rf -- ${staging}`,
		`mkdir -p -- ${staging} || exit 1`,
		`tar xzf - -C ${staging} || ${fail("the server tarball did not unpack")}`,
		`[ -d ${unpacked} ] || ${fail(`there is no ${topLevelDirectory} in the server tarball`)}`,
		`[ -x ${launcher} ] || ${fail(`the server tarball has no ${posix.relative(paths.install, paths.server)}`)}`,
		`ran="$(${node} -e 'process.stdout.write(process.platform + "-" + process.arch)' 2>&1)" || {`,
		// The loader's first two lines name what is missing; a musl loader
		// facing a glibc binary goes on for hundreds more.
		`  echo ${shellQuote(`${SERVER_MARKER} the server's node does not run on this machine:`)} "$(printf '%s\\n' "$ran" | head -n 2 | tr '\\n' ' ')" >&2`,
		`  rm -rf -- ${staging}`,
		`  exit 1`,
		`}`,
		`printf '%s\\n' ${shellQuote(sha256)} > ${shellQuote(posix.join(`${paths.install}.unpacking`, topLevelDirectory, INSTALLED_MARKER))} || ${fail("could not write the install marker")}`,
		`rm -rf -- ${install}`,
		`mkdir -p -- ${shellQuote(posix.dirname(paths.install))} || exit 1`,
		`mv -- ${unpacked} ${install} || ${fail(`could not move the server into ${paths.install}`)}`,
		`exec rm -rf -- ${staging}`,
	].join("\n");
}

/** A token nobody else can guess, made here because here is where the
 * randomness is trustworthy. */
export function newConnectionToken(): string {
	return createHash("sha256")
		.update(globalThis.crypto.getRandomValues(new Uint8Array(32)))
		.digest("hex");
}
