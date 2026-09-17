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
 * knows how to run POSIX `sh` on it, and already fetches payloads here and
 * delivers them there for tmux. So it does this too, and the extension shrinks
 * to the one thing only an extension can do: answer
 * `onResolveRemoteAuthority` with the port DevHub produced.
 *
 * **This Mac fetches; the machine receives.** The same rule as `tmuxDelivery.ts`
 * and for the same reasons, only more so: the REH tarball is a hundred
 * megabytes, the appliance this product exists for has no route to github.com,
 * half of them have no `curl` and the ones that do have a `curl` too old for a
 * modern TLS. The far end unpacks a stream from stdin, which is the one thing
 * every one of them can do.
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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { shellQuote } from "./quote.js";

/** Where a machine's remote extension host comes from, as far as a runtime
 * is concerned. Mirrors `TmuxDelivery`, deliberately. */
export interface RehDelivery {
	/** The VS Code commit this DevHub states, which names the install
	 * directory and is what the server checks the connecting client against.
	 * `undefined` in a source checkout — see `sourceBuildRefusal`. */
	readonly commit: string | undefined;
	/** `product.json`'s `serverDataFolderName`: `.devhub-server`. */
	readonly dataFolderName: string;
	/** `product.json`'s `serverApplicationName`: the script under `bin/`. */
	readonly applicationName: string;
	/** The tarball for one `<os>-<arch>`, from the cache or from the release. */
	tarball(platform: string): Promise<RehTarball>;
}

export interface RehTarball {
	readonly bytes: Uint8Array;
	/**
	 * The single directory inside the archive.
	 *
	 * `scripts/build_reh.py` names it after the platform and the commit is not
	 * in it, so the unpack can move that one directory into place rather than
	 * needing `tar --strip-components`, which is not in every machine's `tar`.
	 */
	readonly topLevelDirectory: string;
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
 * Why a source run cannot open a remote workbench, said once.
 *
 * `pnpm dev` has no `product.commit` and cannot be given one — VS Code reads it
 * as "this is a packaged build" and sends a source run looking for a
 * `node_modules.asar` a checkout does not have. But `commit` is also what names
 * the install directory and what the server checks the connecting client
 * against, so there is nothing to install and nothing that would accept a
 * connection. It is permanent for as long as this DevHub is running, which is
 * what makes it `NotAvailable` rather than something to retry.
 */
export function sourceBuildRefusal(machine: string): string {
	return (
		`This DevHub was built from a source checkout and states no commit, so ` +
		`there is no remote extension host it can install on ${machine} or ask ` +
		`for. SSH workspaces need a packaged build — see docs/remote-ssh.md.`
	);
}

/** The single directory inside the tarball for one platform. */
export function rehTopLevelDirectory(platform: string): string {
	return `devhub-reh-${platform}`;
}

/** The name a platform's tarball has, on the release and in the cache. */
export function rehTarballName(platform: string, commit: string): string {
	return `devhub-reh-${platform}-${commit}.tar.gz`;
}

/**
 * The six names `serverDownloadUrlTemplate` takes, substituted here and
 * nowhere else.
 *
 * DevHub's template uses three of them. `${quality}` and `${release}` are
 * deliberately absent from it — DevHub states neither key, and a template that
 * asked for one would be substituted with nothing at all rather than reported,
 * which is a URL that is wrong in a way no error message mentions.
 * `scripts/build_reh_test.py` fails if either appears.
 */
export function rehDownloadUrl(
	template: string,
	platform: string,
	commit: string,
	version: string,
): string {
	const [os = "", arch = ""] = platform.split("-");
	return template
		.replaceAll("${commit}", commit)
		.replaceAll("${version}", version)
		.replaceAll("${os}", os)
		.replaceAll("${arch}", arch);
}

export interface ReleaseRehDeliveryOptions {
	readonly commit: string | undefined;
	readonly version: string;
	readonly dataFolderName: string;
	readonly applicationName: string;
	/** `product.json`'s `serverDownloadUrlTemplate`. */
	readonly urlTemplate: string;
	/** Where fetched tarballs are kept, under this DevHub profile's own data. */
	readonly cacheDirectory: string;
	/** For tests: how the bytes are fetched. */
	readonly fetchBytes?: (url: string) => Promise<Uint8Array>;
}

export class ReleaseRehDelivery implements RehDelivery {
	readonly commit: string | undefined;
	readonly dataFolderName: string;
	readonly applicationName: string;
	readonly #options: ReleaseRehDeliveryOptions;
	readonly #fetching = new Map<string, Promise<RehTarball>>();

	constructor(options: ReleaseRehDeliveryOptions) {
		this.commit = options.commit;
		this.dataFolderName = options.dataFolderName;
		this.applicationName = options.applicationName;
		this.#options = options;
	}

	/**
	 * One download per platform per DevHub start, however many machines ask.
	 *
	 * The promise is cached and not the bytes, because two machines of the same
	 * platform coming up together must produce one download rather than two
	 * that race onto the same cache file.
	 */
	tarball(platform: string): Promise<RehTarball> {
		const existing = this.#fetching.get(platform);
		if (existing) return existing;
		const pending = this.#obtain(platform);
		pending.catch(() => {
			if (this.#fetching.get(platform) === pending) {
				this.#fetching.delete(platform);
			}
		});
		this.#fetching.set(platform, pending);
		return pending;
	}

	async #obtain(platform: string): Promise<RehTarball> {
		const commit = this.commit;
		if (commit === undefined) {
			throw permanent(new Error(sourceBuildRefusal("any machine")));
		}
		const cached = join(
			this.#options.cacheDirectory,
			rehTarballName(platform, commit),
		);
		const fromCache = await readFile(cached).catch(() => undefined);
		if (fromCache !== undefined) {
			return {
				bytes: new Uint8Array(fromCache),
				topLevelDirectory: rehTopLevelDirectory(platform),
			};
		}
		const url = rehDownloadUrl(
			this.#options.urlTemplate,
			platform,
			commit,
			this.#options.version,
		);
		const fetchBytes = this.#options.fetchBytes ?? downloadBytes;
		const bytes = await fetchBytes(url);
		// Written under a temporary name and renamed, so a download interrupted
		// half way through is not a cache entry the next start reads as whole.
		await mkdir(this.#options.cacheDirectory, { recursive: true, mode: 0o700 });
		const partial = `${cached}.part`;
		await writeFile(partial, bytes, { mode: 0o600 });
		await rename(partial, cached);
		return {
			// A plain `Uint8Array` whichever way it arrived: `readFile` gives a
			// `Buffer` and `fetch` does not, and a caller that could be handed
			// either is a caller that will one day be right about only one.
			bytes: new Uint8Array(bytes),
			topLevelDirectory: rehTopLevelDirectory(platform),
		};
	}
}

/**
 * The bytes of one release asset.
 *
 * A release asset URL on github.com answers with a redirect to object storage,
 * which `fetch` follows by default — the one behaviour this depends on, said
 * here so that a change to it is a change to a line rather than a mystery.
 * A 404 here is the published-target story in `docs/remote-ssh.md`: the name of
 * the missing asset is in the URL, so the sentence names the architecture
 * nobody built rather than leaving it to be guessed at.
 */
async function downloadBytes(url: string): Promise<Uint8Array> {
	const response = await fetch(url);
	if (!response.ok) {
		// Permanent: an HTTP answer is the release saying what it has, and what
		// it has does not change while a workbench waits. A 404 here is the
		// published-target story above — the architecture nobody built — and
		// retrying it four more times only delays the sentence that names it.
		// A *thrown* fetch is a different thing entirely and stays transient:
		// that is this Mac's network, which does come back.
		throw permanent(
			new Error(
				`${url} answered ${String(response.status)} ${response.statusText}`,
			),
		);
	}
	return new Uint8Array(await response.arrayBuffer());
}

/** Every path the remote extension host has on a machine. */
export interface RemoteServerPaths {
	/** `~/.devhub-server`. */
	readonly root: string;
	/** `~/.devhub-server/bin/<commit>`, the tarball's contents. */
	readonly install: string;
	/** `~/.devhub-server/bin/<commit>/bin/devhub-server`. */
	readonly server: string;
	/**
	 * The connection token, 0600.
	 *
	 * Under the root rather than under the install, so that a commit bump gets
	 * a token of its own: two servers of two commits on one machine are two
	 * handshakes, and one token file would make the older one's clients fail
	 * against the newer one's server with nothing that says why.
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
	readonly commit: string;
}): RemoteServerPaths {
	const root = posix.join(request.home, request.dataFolderName);
	const install = posix.join(root, "bin", request.commit);
	return {
		root,
		install,
		server: posix.join(install, "bin", request.applicationName),
		token: posix.join(root, `.${request.commit}.token`),
		socket: posix.join(root, `.${request.commit}.sock`),
		pid: posix.join(root, `.${request.commit}.pid`),
		log: posix.join(root, `.${request.commit}.log`),
	};
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
export function startServerScript(paths: RemoteServerPaths): string {
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
		`  nohup ${server} --start-server --host=127.0.0.1 \\`,
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

/** The unpack, the same shape and for the same reasons as tmux's. */
export function unpackServerScript(
	paths: RemoteServerPaths,
	topLevelDirectory: string,
): string {
	const staging = `${paths.install}.unpacking`;
	const unpacked = posix.join(staging, topLevelDirectory);
	return [
		`rm -rf -- ${shellQuote(staging)} ${shellQuote(paths.install)}`,
		`mkdir -p -- ${shellQuote(staging)} || exit 1`,
		`tar xzf - -C ${shellQuote(staging)} || exit 1`,
		`[ -d ${shellQuote(unpacked)} ] || { echo "no ${topLevelDirectory} in the tarball" >&2; exit 1; }`,
		`mkdir -p -- ${shellQuote(posix.dirname(paths.install))} || exit 1`,
		`mv -- ${shellQuote(unpacked)} ${shellQuote(paths.install)} || exit 1`,
		`exec rm -rf -- ${shellQuote(staging)}`,
	].join("\n");
}

/** A token nobody else can guess, made here because here is where the
 * randomness is trustworthy. */
export function newConnectionToken(): string {
	return createHash("sha256")
		.update(globalThis.crypto.getRandomValues(new Uint8Array(32)))
		.digest("hex");
}
