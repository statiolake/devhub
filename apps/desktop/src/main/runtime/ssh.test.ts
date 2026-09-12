/**
 * The remote runtime, run against an ssh that is not one.
 *
 * The contract suite is the point of this file: `describeRuntimeContract` is
 * the definition of `Runtime`, and running it against `SshRuntime` is the only
 * way the seam's promise — *a feature that works on one machine works on the
 * other* — is checked rather than asserted. The ssh it runs against is a
 * fifteen-line shell script that interprets `ssh [-o …] host -- <command>` by
 * running the command here, so the whole contract runs on a laptop with no
 * sshd, no key and no network, and it exercises the part that is actually
 * DevHub's: the composition of the remote command line. What it deliberately
 * does not exercise is OpenSSH's own behaviour, which is why the option set,
 * the control-path arithmetic and the failure sentences are asserted directly
 * below rather than through it.
 */

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { TypedFailure } from "../../model/wire.js";
import { OperationDeadline } from "../terminal/command.js";
import { CancellationToken } from "../terminal/ports.js";
import type { Pty, PtyLaunch } from "../terminal/pty.js";
import { describeRuntimeContract } from "./runtime.contract.test.js";
import type { TerminalLauncherSpec } from "./runtime.js";
import {
	chooseControlDirectory,
	CONTROL_PATH_LIMIT,
	controlPathOf,
	errnoFromMessage,
	hostKeyFailure,
	parseLoginEnvironment,
	remoteScript,
	SshRuntime,
	sshOptionArgv,
	unauthenticatedFailure,
	unreachableFailure,
} from "./ssh.js";
import { tmuxTopLevelDirectory, type TmuxDelivery } from "./tmuxDelivery.js";

/**
 * An `ssh` that never leaves this machine.
 *
 * It reads the argv DevHub composes — the `-o` pairs, the host, the `--`, and
 * the one word that is the remote command line — and runs that word with
 * `/bin/sh -c`, which is exactly what a real sshd's login shell does with it.
 * `-tt` is accepted and ignored, because there is no tty to force here.
 * `-O check` and `-O exit` touch and remove a file named after the control
 * path, so the master's lifecycle is observable without a master.
 */
const FAKE_SSH = `#!/bin/sh
[ -z "$DEVHUB_FAKE_SSH_LOG" ] || printf '%s\\n' "$*" >> "$DEVHUB_FAKE_SSH_LOG"
control=''
operation=''
forward=''
host=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) case "$2" in ControlPath=*) control="\${2#ControlPath=}";; esac; shift 2;;
    -O) operation="$2"; shift 2;;
    -R) forward="$2"; shift 2;;
    -tt|-T|-q) shift;;
    --) shift; break;;
    *) host="$1"; shift;;
  esac
done
marker="\${control%/*}/fake-master"
case "$operation" in
  check) [ -f "$marker" ] || { echo 'No ControlPath specified' >&2; exit 255; }
         echo "Master running (pid=4242)"; exit 0;;
  exit)  rm -f "$marker"; echo 'Exit request sent.'; exit 0;;
  forward)
    case "\${DEVHUB_FAKE_FORWARD:-bind}" in
      refuse) echo 'unix_listener: cannot bind: Address already in use' >&2; exit 255;;
      silent) exit 0;;
      *) exec python3 -c 'import socket,sys
sock = socket.socket(socket.AF_UNIX)
sock.bind(sys.argv[1].split(":", 1)[0])
sock.listen(1)' "$forward";;
    esac;;
esac
[ -n "$host" ] || { echo 'fake ssh: no host' >&2; exit 255; }
mkdir -p "\${control%/*}" && : > "$marker"
if [ -n "\${DEVHUB_FAKE_NO_ENV:-}" ]; then
  case "$1" in *env*) echo 'sh: env: not found' >&2; exit 127;; esac
fi
exec /bin/sh -c "$1"
`;

/** An `ssh` that only ever refuses, in the words OpenSSH refuses in. */
const REFUSING_SSH = (stderr: string) => `#!/bin/sh
echo ${JSON.stringify(stderr)} >&2
exit 255
`;

let bin: string;
/**
 * Short on purpose, and not under `TMPDIR`.
 *
 * A control socket's path has to fit in 104 bytes, and macOS puts `TMPDIR`
 * fifty characters deep — so a test that put the socket there would be
 * testing the limit rather than the runtime. This is the same reason
 * `chooseControlDirectory` has a fallback at all.
 */
let control: string;

beforeAll(async () => {
	bin = await mkdtemp(join(tmpdir(), "devhub-fake-ssh-"));
	control = join(await mkdtemp("/tmp/devhub-ssh-"), "c");
	await writeFile(join(bin, "ssh"), FAKE_SSH, { mode: 0o700 });
	await chmod(join(bin, "ssh"), 0o700);
});
afterAll(async () => {
	await rm(bin, { recursive: true, force: true });
	await rm(control, { recursive: true, force: true });
});

/**
 * The environment the fake ssh inherits, with the login shell pinned.
 *
 * The runtime reads `$SHELL` on the far machine and runs `$SHELL -lc env` in
 * it, and the far machine here is this one — so without this the suite would
 * source whoever is running it's own `.zshrc`, which is neither reproducible
 * nor theirs to spend. `/bin/sh` is on every machine a test runs on and its
 * `-lc` is the path the runtime actually has to work with.
 */
const FAKE_ENVIRONMENT: Readonly<Record<string, string | undefined>> = {
	...process.env,
	SHELL: "/bin/sh",
};

/**
 * The tmux every runtime here is told about, and none of these ask for.
 *
 * `runtimeFor` always passes one, so a runtime in a test has one too — the
 * suite that leaves it out is the one below that is about leaving it out. The
 * tarball refuses because nothing in these cases installs a tmux, and a test
 * that started to should say so rather than quietly build one.
 */
const FAKE_TMUX: TmuxDelivery = {
	version: "3.7c",
	directory: ".devhub-server/tmux",
	tarball: () => Promise.reject(new Error("no tmux is installed in this test")),
};

function fakeRuntime(): SshRuntime {
	return new SshRuntime({
		host: "build-box.example.com",
		controlDirectory: control,
		sshPath: join(bin, "ssh"),
		localEnvironment: FAKE_ENVIRONMENT,
		tmux: FAKE_TMUX,
	});
}

describeRuntimeContract("ssh", fakeRuntime);

async function refusing(stderr: string): Promise<SshRuntime> {
	const name = `ssh-refuse-${String(Math.random()).slice(2)}`;
	await writeFile(join(bin, name), REFUSING_SSH(stderr), { mode: 0o700 });
	await chmod(join(bin, name), 0o700);
	return new SshRuntime({
		host: "build-box.example.com",
		controlDirectory: control,
		sshPath: join(bin, name),
		localEnvironment: FAKE_ENVIRONMENT,
		tmux: FAKE_TMUX,
	});
}

function run(runtime: SshRuntime, argv: readonly string[]) {
	return runtime.exec({
		argv,
		deadline: OperationDeadline.in(10_000),
		cancel: new CancellationToken(),
		limits: {
			stdoutBytes: 4096,
			stderrBytes: 4096,
			overflow: { kind: "truncate" },
		},
	});
}

describe("the ssh DevHub runs", () => {
	it("multiplexes, refuses to prompt, and leaves host checking to the user", () => {
		const options = sshOptionArgv("/tmp/devhub/ssh").join(" ");
		// Each of these is load-bearing, and the one that is absent is the most
		// load-bearing of all: DevHub never decides a person's host-key policy
		// for them, and never passes `-F`, because the host is usually an alias
		// that only their own config knows.
		expect(options).toContain("-o BatchMode=yes");
		expect(options).toContain("-o ControlMaster=auto");
		expect(options).toContain("-o ControlPath=/tmp/devhub/ssh/%C");
		expect(options).toContain("-o ControlPersist=10m");
		expect(options).toContain("-o ConnectTimeout=10");
		expect(options).toContain("-o ServerAliveInterval=15");
		expect(options).not.toContain("StrictHostKeyChecking");
		expect(options).not.toContain("-F");
	});

	it("counts the socket path before binding it, not after", () => {
		// `%C` is forty hex characters, so the length of the path is known
		// before any host is contacted — and `unix_listener: path too long`
		// per command is a much worse way to find out.
		const short = chooseControlDirectory("/data/devhub", "/home/dev");
		expect(short).toBe("/data/devhub/ssh");
		expect(controlPathOf(short).length).toBeLessThanOrEqual(CONTROL_PATH_LIMIT);
	});

	it("falls back to the short path when the profile's is too long", () => {
		const long = `/Users/example/Library/Application Support/DevHub-${"x".repeat(30)}`;
		expect(chooseControlDirectory(long, "/home/dev")).toBe(
			"/home/dev/.devhub/ssh",
		);
	});

	it("refuses when even the short path does not fit", () => {
		// Both numbers in the sentence, because the alternative is `ssh`
		// failing on every single command with `unix_listener: path too long`.
		expect(() =>
			chooseControlDirectory(
				`/data/${"p".repeat(90)}`,
				`/home/${"d".repeat(90)}`,
			),
		).toThrow(/longer than 100/u);
	});

	it("refuses a control directory of its own that cannot hold a socket", () => {
		expect(
			() =>
				new SshRuntime({
					host: "h.example.com",
					controlDirectory: `/${"d".repeat(80)}`,
				}),
		).toThrow(/unix socket/u);
	});
});

describe("the command line ssh delivers", () => {
	it("makes every argument one word, whatever is in it", () => {
		expect(
			remoteScript({ argv: ["git", "commit", "-m", "it's a; message"] }),
		).toContain(`exec 'git' 'commit' '-m' 'it'\\''s a; message'`);
	});

	it("changes directory on the far side, not on this one", () => {
		expect(remoteScript({ argv: ["git"], cwd: "/srv/my app" })).toContain(
			`cd -P -- '/srv/my app'`,
		);
	});

	it("exports the environment rather than trusting SendEnv", () => {
		// `SendEnv` needs the far end's `AcceptEnv`, and a variable that
		// silently does not arrive is worse than one that cannot.
		const script = remoteScript({ argv: ["env"], env: { GIT_DIR: "/a b" } });
		expect(script).toContain(`export GIT_DIR='/a b'`);
		expect(script).not.toContain("SendEnv");
	});

	it("drops a variable with no value rather than exporting an empty one", () => {
		expect(
			remoteScript({ argv: ["env"], env: { GONE: undefined } }),
		).not.toContain("GONE");
	});

	it("refuses a name a shell cannot export", () => {
		expect(() => remoteScript({ argv: ["env"], env: { "a-b": "x" } })).toThrow(
			/not a name/u,
		);
	});

	it("never puts what came in on stdin into the command line", async () => {
		// The whole reason `ExecRequest` has a `stdin`: argv is world-readable
		// in `ps` on the remote as much as on this Mac.
		const runtime = fakeRuntime();
		const result = await runtime.exec({
			argv: ["/bin/cat"],
			stdin: Buffer.from("hunter2", "utf8"),
			deadline: OperationDeadline.in(10_000),
			cancel: new CancellationToken(),
			limits: {
				stdoutBytes: 1024,
				stderrBytes: 1024,
				overflow: { kind: "truncate" },
			},
		});
		expect(result.stdout.toString("utf8")).toBe("hunter2");
		expect(remoteScript({ argv: ["/bin/cat"] })).not.toContain("hunter2");
	});
});

describe("what a tool's complaint meant", () => {
	// GNU says `stat: cannot stat 'p': No such file or directory` and BSD says
	// `stat: p: No such file or directory`. The half that differs is the half
	// this does not read, which is why there is one table and not two.
	it.each([
		["stat: cannot stat '/a': No such file or directory", "ENOENT"],
		["stat: /a: No such file or directory", "ENOENT"],
		["ls: cannot open directory '/a': Permission denied", "EACCES"],
		["ls: /a: Permission denied", "EACCES"],
		["head: cannot open '/a/b' for reading: Not a directory", "ENOTDIR"],
		["head: /a/b: Not a directory", "ENOTDIR"],
		["head: error reading '/a': Is a directory", "EISDIR"],
		["rm: cannot remove '/a': Directory not empty", "ENOTEMPTY"],
		["mkdir: /a: File exists", "EEXIST"],
		["cat: /a: Too many levels of symbolic links", "ELOOP"],
		["cp: /a: No space left on device", "ENOSPC"],
	])("reads %s as %s", (message, code) => {
		expect(errnoFromMessage(message)).toBe(code);
	});

	it("keeps a message it does not recognise in its own words", () => {
		expect(errnoFromMessage("ls: something nobody has seen")).toBeUndefined();
	});

	it("hands the errno on, so a caller reads the same word on both machines", async () => {
		const runtime = fakeRuntime();
		await expect(
			runtime.readTextFile("/no/such/path/at/all", 16),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("a host DevHub cannot log into", () => {
	it("says so in one sentence, and says the editor is not the problem", async () => {
		const runtime = await refusing("dev@host: Permission denied (publickey).");
		const failure = await run(runtime, ["/bin/true"]).catch(
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(TypedFailure);
		expect((failure as TypedFailure).wire.summary).toBe(
			unauthenticatedFailure("build-box.example.com").message,
		);
		expect((failure as TypedFailure).message).toContain("ssh-copy-id");
		expect((failure as TypedFailure).message).toContain(
			"build-box.example.com",
		);
	});

	it("tells an unknown host key apart, because it is a different fix", async () => {
		const runtime = await refusing("Host key verification failed.");
		const failure = await run(runtime, ["/bin/true"]).catch(
			(error: unknown) => error,
		);
		expect((failure as TypedFailure).wire.summary).toBe(
			hostKeyFailure("build-box.example.com").message,
		);
	});

	it("passes ssh's own last line through for everything else", async () => {
		const runtime = await refusing(
			"ssh: connect to host build-box.example.com port 22: Connection refused",
		);
		const failure = await run(runtime, ["/bin/true"]).catch(
			(error: unknown) => error,
		);
		expect((failure as TypedFailure).wire.summary).toBe(
			unreachableFailure(
				"build-box.example.com",
				"ssh: connect to host build-box.example.com port 22: Connection refused",
			).message,
		);
		expect((failure as TypedFailure).message).toContain("Connection refused");
	});

	it("reads as disconnected afterwards, and says what went wrong", async () => {
		const runtime = await refusing("dev@host: Permission denied (publickey).");
		await run(runtime, ["/bin/true"]).catch(() => undefined);
		const reading = runtime.reading();
		expect(reading.id).toBe("ssh:build-box.example.com");
		expect(reading.connected).toBe(false);
		expect(reading.lastFailure).toContain("without a password");
	});
});

describe("the connection", () => {
	it("reads as connected once something has run on it", async () => {
		const runtime = fakeRuntime();
		await run(runtime, ["/bin/echo", "hi"]);
		expect(runtime.reading().connected).toBe(true);
	});

	it("is let go of, rather than left to time out", async () => {
		const runtime = fakeRuntime();
		await run(runtime, ["/bin/echo", "hi"]);
		await runtime.dispose();
		expect(runtime.reading().connected).toBe(false);
	});

	it("keeps a reconcile cadence between its floor and its ceiling", () => {
		const runtime = fakeRuntime();
		const { reconcileIntervalMs, headWatchPollMs } = runtime.cadence;
		// The bound is the property worth having, not the number: a duty cycle
		// of one eighth, whatever the link does.
		expect(reconcileIntervalMs).toBeGreaterThanOrEqual(500);
		expect(reconcileIntervalMs).toBeLessThanOrEqual(3000);
		// Not `undefined`: there is no inotify across a network, and pretending
		// otherwise is the one thing `watchGitDirectory` exists to refuse.
		expect(headWatchPollMs).toBeGreaterThan(0);
	});
});

describe("a pseudo-terminal on the other machine", () => {
	it("forces a tty and wraps the argv the local one would have run", async () => {
		let launched: PtyLaunch | undefined;
		const runtime = new SshRuntime({
			host: "build-box.example.com",
			controlDirectory: control,
			sshPath: join(bin, "ssh"),
			localEnvironment: FAKE_ENVIRONMENT,
			tmux: FAKE_TMUX,
			ptyFactory: (launch) => {
				launched = launch;
				return {} as Pty;
			},
		});
		// The machine is reached before a pane is opened on it, always: the
		// adapter that opens one is built out of its `$HOME` and its resolved
		// programs. Saying so here rather than letting `spawnPty` invent an
		// environment is the same rule as the throw it would otherwise hit.
		await runtime.home();
		runtime.spawnPty({
			file: "/usr/bin/tmux",
			args: ["-L", "devhub", "attach"],
			cwd: "/srv/app",
			cols: 80,
			rows: 24,
			pixelWidth: 0,
			pixelHeight: 0,
			env: { TERM: "xterm-256color" },
		});
		expect(launched?.file).toBe(join(bin, "ssh"));
		// Without `-tt` a non-interactive remote command gets no pty and tmux
		// refuses to attach.
		expect(launched?.args).toContain("-tt");
		const script = launched?.args.at(-1) ?? "";
		expect(script).toContain(`exec '/usr/bin/tmux' '-L' 'devhub' 'attach'`);
		expect(script).toContain(`cd -P -- '/srv/app'`);
		expect(script).toContain(`export TERM='xterm-256color'`);
	});
});

/**
 * The launcher a workbench *on the host* runs, installed over the same ssh.
 *
 * The fake ssh runs the commands here, so the "host" is a scratch `$HOME` and
 * the files DevHub writes are files this test can read. What that leaves
 * unexercised is OpenSSH's own `-O forward`, which is why the argv is asserted
 * from the fake's log rather than inferred from the socket appearing: the
 * composition is DevHub's, and the binding is OpenSSH's.
 */
describe("the terminal launcher on the host", () => {
	let remoteHome: string;
	let log: string;

	beforeEach(async () => {
		remoteHome = await mkdtemp("/tmp/devhub-remote-home-");
		log = join(remoteHome, "ssh.log");
	});
	afterEach(async () => {
		await rm(remoteHome, { recursive: true, force: true });
	});

	function runtimeWith(
		forward: "bind" | "refuse" | "silent" = "bind",
	): SshRuntime {
		return new SshRuntime({
			host: "build-box.example.com",
			controlDirectory: control,
			sshPath: join(bin, "ssh"),
			localEnvironment: {
				...FAKE_ENVIRONMENT,
				HOME: remoteHome,
				DEVHUB_FAKE_SSH_LOG: log,
				DEVHUB_FAKE_FORWARD: forward,
			},
			tmux: FAKE_TMUX,
		});
	}

	const spec: TerminalLauncherSpec = {
		localLauncherPath: "/data/devhub/devhub/devhub-terminal",
		controlSocketPath: "/data/devhub/devhub/control.sock",
		entryText:
			'import { connect } from "node:net";\nexport const e = connect;\n',
		entryName: "devhub-terminal.bundle.js",
		serverDataFolderName: ".devhub-server",
		serverCommit: "c0ffee",
	};

	it("writes the asking program, one file, and a launcher that names it", async () => {
		const launcher = await runtimeWith().terminalLauncher(spec);
		expect(launcher.unreachable).toBeUndefined();
		const script = await readFile(launcher.path, "utf8");
		// The REH's own Node, at the commit this DevHub states: the one Node a
		// host with a workbench on it is certain to have.
		expect(script).toContain(`${remoteHome}/.devhub-server/bin/c0ffee/node`);
		expect(script).toContain(
			`${remoteHome}/.devhub/terminal/js/devhub-terminal.bundle.js`,
		);
		// The machine, so that `/srv/app` here is not `/srv/app` there.
		expect(script).toContain(
			"DEVHUB_TERMINAL_MACHINE='ssh:build-box.example.com'",
		);
		expect((await stat(launcher.path)).mode & 0o777).toBe(0o755);
		const entryRoot = join(remoteHome, ".devhub", "terminal", "js");
		expect(
			await readFile(join(entryRoot, "devhub-terminal.bundle.js"), "utf8"),
		).toBe(spec.entryText);
		// Without this Node reads the bundled ES module as CommonJS and the
		// first `import` is a syntax error.
		expect(
			JSON.parse(await readFile(join(entryRoot, "package.json"), "utf8")),
		).toEqual({ type: "module" });
	});

	it("forwards DevHub's own control socket onto the host", async () => {
		const launcher = await runtimeWith().terminalLauncher(spec);
		const remoteSocket = `${remoteHome}/.devhub/terminal/${
			launcher.path.split("/").pop()?.replace("devhub-terminal-", "control-") ??
			""
		}.sock`;
		const lines = (await readFile(log, "utf8")).split("\n");
		const forward = lines.find((line) => line.includes("-O forward"));
		expect(forward).toContain(
			`-R ${remoteSocket}:/data/devhub/devhub/control.sock`,
		);
		expect(forward).toContain("build-box.example.com");
		// The launcher talks to the forwarded socket, not to a path on this Mac.
		expect(await readFile(launcher.path, "utf8")).toContain(remoteSocket);
	});

	// A unix socket left by a previous DevHub is a file, and sshd will not bind
	// over one unless the host was configured to — which is the host's business.
	// Removing it from this side needs no such configuration.
	it("clears its own stale socket before asking for the forward", async () => {
		await runtimeWith().terminalLauncher(spec);
		const lines = (await readFile(log, "utf8")).split("\n");
		const removed = lines.findIndex((line) => line.includes("rm -f --"));
		const forwarded = lines.findIndex((line) => line.includes("-O forward"));
		expect(removed).toBeGreaterThanOrEqual(0);
		expect(removed).toBeLessThan(forwarded);
	});

	it("says so when ssh refuses the forward, and installs the launcher anyway", async () => {
		const launcher = await runtimeWith("refuse").terminalLauncher(spec);
		expect(launcher.unreachable).toContain("build-box.example.com");
		expect(launcher.unreachable).toContain("cannot bind");
		// Still written: run from the host it says the socket is not answering,
		// which is the same fact where a person is actually looking.
		expect(await readFile(launcher.path, "utf8")).toContain("devhub_argv");
	});

	// `-O forward` can report success and leave nothing bound. A launcher
	// pointed at a socket that is not there is the silent failure this whole
	// arrangement exists to prevent, so the forward is checked and not trusted.
	it("says so when ssh reports a forward that bound nothing", async () => {
		const launcher = await runtimeWith("silent").terminalLauncher(spec);
		expect(launcher.unreachable).toContain("nothing is listening");
	});

	it("installs once per host per DevHub start", async () => {
		const runtime = runtimeWith();
		const first = await runtime.terminalLauncher(spec);
		const before = (await readFile(log, "utf8")).split("\n").length;
		const second = await runtime.terminalLauncher(spec);
		expect(second).toEqual(first);
		expect((await readFile(log, "utf8")).split("\n")).toHaveLength(before);
	});

	// A DevHub with no commit is a DevHub that can open no workbench there
	// either, so it is one fact and one sentence rather than a guessed path.
	it("refuses when this DevHub states no commit to find the Node under", async () => {
		await expect(
			runtimeWith().terminalLauncher({ ...spec, serverCommit: undefined }),
		).rejects.toThrow(/source checkout/u);
	});
});

/**
 * The environment a command on the host actually runs in.
 *
 * `ssh host -- cmd` gets a *non-login, non-interactive* shell: `~/.profile`
 * has not run and `PATH` is sshd's default, which has nothing a person added
 * to theirs. Every "it works when I type it, not when DevHub runs it" report
 * about a remote host is that one fact, so the login shell is asked once and
 * every command is given the answer. The far machine here is this one, so the
 * login shell is a five-line script the test writes and can therefore make
 * answer — or refuse — exactly the way a real one on a real host does.
 */
describe("the login environment on the host", () => {
	let shells: string;

	/** A `$SHELL` that answers `-lc` with a fixed listing, or refuses to. */
	async function loginShell(name: string, body: string): Promise<string> {
		const path = join(shells, name);
		await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
		await chmod(path, 0o700);
		return path;
	}

	function runtimeWithShell(
		shell: string,
		extra: Readonly<Record<string, string>> = {},
	): SshRuntime {
		return new SshRuntime({
			host: "build-box.example.com",
			controlDirectory: control,
			sshPath: join(bin, "ssh"),
			localEnvironment: { ...FAKE_ENVIRONMENT, SHELL: shell, ...extra },
			tmux: FAKE_TMUX,
		});
	}

	beforeEach(async () => {
		shells = await mkdtemp("/tmp/devhub-login-shell-");
	});
	afterEach(async () => {
		await rm(shells, { recursive: true, force: true });
	});

	const ANSWERS = [
		`case "$2" in`,
		`  'env -0') printf 'PATH=/opt/devhub/bin:/usr/bin\\0LANG=en_US.UTF-8\\0SSH_TTY=/dev/pts/9\\0TERM=vt100\\0'; exit 0;;`,
		`esac`,
		`exit 1`,
	].join("\n");

	it("puts the login shell's own PATH on every command DevHub runs there", async () => {
		const runtime = runtimeWithShell(await loginShell("answers", ANSWERS));
		const result = await run(runtime, [
			"/bin/sh",
			"-c",
			'printf "%s|%s" "$PATH" "$LANG"',
		]);
		expect(result.stdout.toString("utf8")).toBe(
			"/opt/devhub/bin:/usr/bin|en_US.UTF-8",
		);
	});

	// They describe the login that was read, not the command about to run, and
	// each of them is set correctly by whatever opens the next channel.
	it("leaves behind the variables that belonged to the login, not the host", async () => {
		const runtime = runtimeWithShell(await loginShell("answers", ANSWERS));
		const result = await run(runtime, [
			"/bin/sh",
			"-c",
			'printf %s "${SSH_TTY:-none}"',
		]);
		expect(result.stdout.toString("utf8")).toBe("none");
	});

	it("lets the caller's own variables win over the person's", async () => {
		const runtime = runtimeWithShell(await loginShell("answers", ANSWERS));
		const result = await runtime.exec({
			argv: ["/bin/sh", "-c", 'printf %s "$PATH"'],
			env: { PATH: "/only/this" },
			deadline: OperationDeadline.in(10_000),
			cancel: new CancellationToken(),
			limits: {
				stdoutBytes: 4096,
				stderrBytes: 4096,
				overflow: { kind: "truncate" },
			},
		});
		expect(result.stdout.toString("utf8")).toBe("/only/this");
	});

	// A reading is pasted into issues, and a login environment is where a
	// person's tokens are — but "which variables is DevHub putting on every
	// command" is the question a wrong PATH raises, and names answer it.
	it("says which variables it carries and never what is in them", async () => {
		const runtime = runtimeWithShell(await loginShell("answers", ANSWERS));
		await run(runtime, ["/bin/sh", "-c", ":"]);
		const reading = runtime.reading();
		expect(reading.loginEnvironmentNames).toEqual(["LANG", "PATH"]);
		expect(JSON.stringify(reading)).not.toContain("/opt/devhub/bin");
	});

	// A `$SHELL` whose `env` has no `-0` is a real host — busybox on an
	// appliance — and the answer has to come from somewhere else rather than
	// from nowhere.
	it("falls back to /bin/sh when the person's own shell cannot answer", async () => {
		const refuses = await loginShell(
			"refuses",
			`printf '%s\\n' "$*" >> "$DEVHUB_LOGIN_LOG"\nexit 1`,
		);
		const log = join(shells, "asked");
		const runtime = runtimeWithShell(refuses, { DEVHUB_LOGIN_LOG: log });
		const result = await run(runtime, ["/bin/sh", "-c", 'printf %s "$PATH"']);
		// It was asked first, and what came back is /bin/sh's answer.
		expect(await readFile(log, "utf8")).toContain("-lc env -0");
		expect(result.stdout.toString("utf8").length).toBeGreaterThan(0);
	});

	// Not a swallow and not a guess: a machine whose login environment DevHub
	// could not read is a machine it cannot say where the programs are on.
	it("refuses the machine by name when no shell will say what its PATH is", async () => {
		const runtime = runtimeWithShell(await loginShell("answers", ANSWERS), {
			DEVHUB_FAKE_NO_ENV: "yes",
		});
		await expect(run(runtime, ["/bin/sh", "-c", ":"])).rejects.toThrow(
			/build-box\.example\.com.*login environment|login environment.*build-box\.example\.com/su,
		);
	});

	it("resolves a configured program under that PATH, to an absolute path", async () => {
		const widget = join(shells, "widget");
		await writeFile(widget, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		await chmod(widget, 0o700);
		const runtime = runtimeWithShell(
			await loginShell(
				"found",
				`case "$2" in 'env -0') printf 'PATH=%s\\0' ${JSON.stringify(shells)}; exit 0;; esac\nexit 1`,
			),
		);
		expect(await runtime.resolveProgram("widget", "")).toEqual({
			kind: "absolute_path",
			value: widget,
		});
	});

	// The directories are the *host's*, in the host's own order, which is the
	// fact a person is missing when the answer on their Mac looked fine.
	it("names the host's own search path when the program is not there", async () => {
		const runtime = runtimeWithShell(await loginShell("answers", ANSWERS));
		expect(await runtime.resolveProgram("widget", "")).toEqual({
			kind: "unavailable",
			configured: "widget",
			lookup: { kind: "path", directories: ["/opt/devhub/bin", "/usr/bin"] },
		});
	});
});

describe("reading an env listing", () => {
	it("keeps a value with a newline in it whole when env said so with NULs", () => {
		expect(parseLoginEnvironment("A=one\ntwo\0B=three\0", "\0")).toEqual({
			A: "one\ntwo",
			B: "three",
		});
	});

	// The one guess in the file, confined to the one listing that forces it:
	// a newline-separated `env` cannot say whether a line is a new variable or
	// the rest of the last one's value, and the rest of a value is the only
	// thing it can be.
	it("puts a stray line back on the value it fell off", () => {
		expect(parseLoginEnvironment("A=one\ntwo\nB=three\n", "\n")).toEqual({
			A: "one\ntwo",
			B: "three",
		});
	});

	it("drops the variables that described the login rather than the machine", () => {
		expect(
			parseLoginEnvironment("PATH=/bin\0SSH_CONNECTION=a b\0SHLVL=2\0", "\0"),
		).toEqual({ PATH: "/bin" });
	});
});

/**
 * The tmux DevHub puts on a host, and never the host's own.
 *
 * The fake ssh runs its commands here, so the "host" is a scratch `$HOME` and
 * the install is a directory this test can read — which is what makes the
 * whole of it checkable without a NAS: the tarball is a real gzipped tar
 * unpacked by a real `tar` reading a real stream from stdin, and the binary at
 * the end is a script that answers `-V`, because "did the thing that came out
 * run" is the question the last step asks the host.
 */
describe("the tmux DevHub installs on a host", () => {
	let remoteHome: string;
	let workshop: string;
	let asked: string[];

	beforeEach(async () => {
		remoteHome = await mkdtemp("/tmp/devhub-tmux-home-");
		workshop = await mkdtemp("/tmp/devhub-tmux-build-");
		asked = [];
	});
	afterEach(async () => {
		await rm(remoteHome, { recursive: true, force: true });
		await rm(workshop, { recursive: true, force: true });
	});

	/** A real `devhub-tmux-<platform>-<version>.tar.gz`, built here. */
	async function tarballFor(
		platform: string,
		version: string,
		binary = `#!/bin/sh\necho "tmux ${version}"\n`,
	): Promise<Uint8Array> {
		const top = tmuxTopLevelDirectory(platform);
		const root = join(workshop, `${top}-${version}`);
		await mkdir(join(root, top, "bin"), { recursive: true });
		await mkdir(join(root, top, "terminfo", "x"), { recursive: true });
		await writeFile(join(root, top, "bin", "tmux"), binary, { mode: 0o755 });
		await chmod(join(root, top, "bin", "tmux"), 0o755);
		await writeFile(join(root, top, "terminfo", "x", "xterm-256color"), "e");
		const archive = join(workshop, `${top}-${version}.tar.gz`);
		await new Promise<void>((resolve, reject) => {
			const tar = spawn("tar", ["czf", archive, "-C", root, top]);
			tar.on("error", reject);
			tar.on("exit", (code) =>
				code === 0
					? resolve()
					: reject(new Error(`tar exited ${String(code)}`)),
			);
		});
		return new Uint8Array(await readFile(archive));
	}

	function delivery(
		version: string,
		bytes: (platform: string) => Promise<Uint8Array>,
	): TmuxDelivery {
		return {
			version,
			directory: ".devhub-server/tmux",
			tarball: async (platform) => {
				asked.push(platform);
				return {
					bytes: await bytes(platform),
					topLevelDirectory: tmuxTopLevelDirectory(platform),
					verifiedSha256: undefined,
				};
			},
		};
	}

	function runtimeWith(tmux: TmuxDelivery): SshRuntime {
		return new SshRuntime({
			host: "build-box.example.com",
			controlDirectory: control,
			sshPath: join(bin, "ssh"),
			localEnvironment: { ...FAKE_ENVIRONMENT, HOME: remoteHome },
			tmux,
		});
	}

	it("unpacks it into the host's own home and names it absolutely", async () => {
		const runtime = runtimeWith(
			delivery("3.7c", (platform) => tarballFor(platform, "3.7c")),
		);
		const program = await runtime.tmuxProgram();
		expect(program).toEqual({
			kind: "resolved",
			path: `${remoteHome}/.devhub-server/tmux/3.7c/bin/tmux`,
			// A static ncurses has the terminfo code and no database, and a bare
			// appliance has no database either: this is how the binary is told
			// to read the one that travelled with it.
			environment: {
				TERMINFO: `${remoteHome}/.devhub-server/tmux/3.7c/terminfo`,
			},
		});
		const installed = await stat(
			`${remoteHome}/.devhub-server/tmux/3.7c/bin/tmux`,
		);
		expect(installed.mode & 0o111).toBeGreaterThan(0);
	});

	// The version is in the path, so a DevHub of a different age on the same
	// host finds its own and neither disturbs the other.
	it("keeps one directory per version, not one directory", async () => {
		await runtimeWith(
			delivery("3.7c", (p) => tarballFor(p, "3.7c")),
		).tmuxProgram();
		await runtimeWith(
			delivery("3.8", (p) => tarballFor(p, "3.8")),
		).tmuxProgram();
		expect(
			await stat(`${remoteHome}/.devhub-server/tmux/3.7c/bin/tmux`),
		).toBeTruthy();
		expect(
			await stat(`${remoteHome}/.devhub-server/tmux/3.8/bin/tmux`),
		).toBeTruthy();
	});

	// Once per machine per DevHub start, and once per machine ever: the
	// question the install starts with is what makes it idempotent.
	it("asks for no tarball when the version is already there and runs", async () => {
		const first = runtimeWith(delivery("3.7c", (p) => tarballFor(p, "3.7c")));
		await first.tmuxProgram();
		await first.tmuxProgram();
		expect(asked).toHaveLength(1);
		// A second DevHub, and a second connection: still nothing downloaded.
		await runtimeWith(
			delivery("3.7c", (p) => tarballFor(p, "3.7c")),
		).tmuxProgram();
		expect(asked).toHaveLength(1);
	});

	it("says which host and which tarball when it cannot get one", async () => {
		const program = await runtimeWith(
			delivery("3.7c", () =>
				Promise.reject(new Error("github.com answered 404 Not Found")),
			),
		).tmuxProgram();
		expect(program.kind).toBe("unavailable");
		const reason = program.kind === "unavailable" ? program.reason : "";
		expect(reason).toContain("build-box.example.com");
		expect(reason).toContain("3.7c");
		expect(reason).toContain("404 Not Found");
	});

	it("says which host and which step when the tarball is not what it should be", async () => {
		const program = await runtimeWith(
			// The right archive for the wrong platform: the directory the unpack
			// looks for is not in it.
			delivery("3.7c", () => tarballFor("linux-riscv64", "3.7c")),
		).tmuxProgram();
		const reason = program.kind === "unavailable" ? program.reason : "";
		expect(reason).toContain("could not unpack tmux 3.7c");
		expect(reason).toContain("build-box.example.com");
	});

	// The step that makes the first one mean anything: an unpack that wrote a
	// binary this machine cannot run is caught here and not at the first attach.
	it("says so when what came out will not run on that machine", async () => {
		const program = await runtimeWith(
			delivery("3.7c", (p) =>
				tarballFor(p, "3.7c", "ELF not for this machine\n"),
			),
		).tmuxProgram();
		const reason = program.kind === "unavailable" ? program.reason : "";
		expect(reason).toContain("-V did not answer");
		expect(reason).toContain("build-box.example.com");
	});

	// Not remembered across a failure: a host with no route to the release when
	// the first window opened may have one by the second.
	it("tries again after a failure rather than answering with the old one", async () => {
		let broken = true;
		const runtime = runtimeWith(
			delivery("3.7c", async (platform) => {
				if (broken) throw new Error("no route to host");
				return tarballFor(platform, "3.7c");
			}),
		);
		expect((await runtime.tmuxProgram()).kind).toBe("unavailable");
		broken = false;
		expect((await runtime.tmuxProgram()).kind).toBe("resolved");
	});
});

/**
 * DevHub's one tmux config, on the machine tmux reads it.
 *
 * The contract suite already says the rule — a path on that machine with the
 * config's own bytes at it, the same on both — so what is left here is the
 * part only the remote arm has: *where* the copy goes, and that a config a
 * person deleted stops being sourced over there rather than living on as a
 * copy nobody can see.
 */
describe("carrying the tmux config to a host", () => {
	let remoteHome: string;
	let here: string;

	beforeEach(async () => {
		remoteHome = await mkdtemp("/tmp/devhub-conf-home-");
		here = await mkdtemp("/tmp/devhub-conf-local-");
	});
	afterEach(async () => {
		await rm(remoteHome, { recursive: true, force: true });
		await rm(here, { recursive: true, force: true });
	});

	function runtime(): SshRuntime {
		return new SshRuntime({
			host: "build-box.example.com",
			controlDirectory: control,
			sshPath: join(bin, "ssh"),
			localEnvironment: { ...FAKE_ENVIRONMENT, HOME: remoteHome },
			tmux: {
				version: "3.7c",
				directory: ".devhub-server/tmux",
				tarball: () => Promise.reject(new Error("not asked for here")),
			},
		});
	}

	// Beside the tmux it configures, under the same `serverDataFolderName`, and
	// not versioned: it is the person's file and not a build artifact, so a
	// version bump must not leave them configuring a tmux they no longer run.
	it("puts it beside the tmux it configures", async () => {
		const local = join(here, "tmux.conf");
		await writeFile(local, "set -g mouse on\n");
		const answer = await runtime().userTmuxConfig(local);
		expect(answer).toBe(`${remoteHome}/.devhub-server/tmux/tmux.conf`);
		expect(await readFile(answer, "utf8")).toBe("set -g mouse on\n");
		// It is DevHub's file on somebody else's machine, in a directory whose
		// other contents run as this user.
		expect((await stat(answer)).mode & 0o777).toBe(0o600);
	});

	// "Always current" has to mean both directions or it means neither: a
	// config a person deleted must stop being sourced, not go on being a copy.
	it("takes it away again when there is no longer one here", async () => {
		const local = join(here, "tmux.conf");
		await writeFile(local, "set -g mouse on\n");
		const answer = await runtime().userTmuxConfig(local);
		await rm(local);
		expect(await runtime().userTmuxConfig(local)).toBe("/dev/null");
		await expect(readFile(answer, "utf8")).rejects.toThrow();
	});
});

/**
 * A runtime built without a tmux delivery is a bug in DevHub.
 *
 * `runtimeFor` is the only thing that builds one and it always passes a
 * delivery, so there is no state of the world in which this is missing. What
 * makes it worth a case of its own is what the alternative looked like: a
 * runtime that guessed `~/.devhub-server/tmux` would go on to fail somewhere
 * on the host and report it as "that host has no tmux", which sends whoever
 * reads it to the wrong machine entirely.
 */
describe("a runtime built without a tmux to deliver", () => {
	function undelivered(): SshRuntime {
		return new SshRuntime({
			host: "build-box.example.com",
			controlDirectory: control,
			sshPath: join(bin, "ssh"),
			localEnvironment: FAKE_ENVIRONMENT,
		});
	}

	it("refuses to say which tmux it runs, and says whose bug that is", async () => {
		await expect(undelivered().tmuxProgram()).rejects.toThrow(
			/a bug in DevHub and not a fact about that host/u,
		);
	});

	// A throw and not an `unavailable`: `tmuxProgram` turns a host that could
	// not be reached into a reason a person can act on, and this is not one.
	it("refuses to place the tmux config, rather than guessing where", async () => {
		await expect(
			undelivered().userTmuxConfig("/nowhere/tmux.conf"),
		).rejects.toThrow(/built without a tmux delivery/u);
	});
});
