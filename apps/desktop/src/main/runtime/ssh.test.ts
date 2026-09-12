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
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TypedFailure } from "../../model/wire.js";
import { OperationDeadline } from "../terminal/command.js";
import { CancellationToken } from "../terminal/ports.js";
import type { Pty, PtyLaunch } from "../terminal/pty.js";
import { describeRuntimeContract } from "./runtime.contract.test.js";
import {
	chooseControlDirectory,
	CONTROL_PATH_LIMIT,
	controlPathOf,
	errnoFromMessage,
	hostKeyFailure,
	remoteScript,
	SshRuntime,
	sshOptionArgv,
	unauthenticatedFailure,
	unreachableFailure,
} from "./ssh.js";

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
control=''
operation=''
host=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) case "$2" in ControlPath=*) control="\${2#ControlPath=}";; esac; shift 2;;
    -O) operation="$2"; shift 2;;
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
esac
[ -n "$host" ] || { echo 'fake ssh: no host' >&2; exit 255; }
mkdir -p "\${control%/*}" && : > "$marker"
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

function fakeRuntime(): SshRuntime {
	return new SshRuntime({
		host: "build-box.example.com",
		controlDirectory: control,
		sshPath: join(bin, "ssh"),
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
	it("forces a tty and wraps the argv the local one would have run", () => {
		let launched: PtyLaunch | undefined;
		const runtime = new SshRuntime({
			host: "build-box.example.com",
			controlDirectory: control,
			sshPath: join(bin, "ssh"),
			ptyFactory: (launch) => {
				launched = launch;
				return {} as Pty;
			},
		});
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
