/**
 * The MCP sign-in runner against a fake `mcp login`: a shell script that
 * prints an authorization URL whose `redirect_uri` names a localhost port,
 * reads what is typed at its prompt, and ends the way the test says. The
 * machine is a fake too — its terminal a child process over pipes, its
 * forwards a record — so what is checked is what the runner asks of a
 * machine and what it shows, for an Agent on this Mac and on a host alike.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpSignIn } from "../../../model/conversation.js";
import type { PtyRequest } from "../../runtime/runtime.js";
import type { Pty } from "../../terminal/pty.js";
import {
	McpSignInRun,
	callbackPort,
	terminalText,
	type SignInMachine,
} from "./mcpSignIn.js";

const AUTHORIZE =
	"https://auth.example.com/authorize?response_type=code&client_id=abc" +
	"&redirect_uri=http%3A%2F%2Flocalhost%3A43117%2Fcallback&state=xyz";

/**
 * `<program> mcp login <server>`, as far as the runner can tell: it says
 * what it was run as and with, prints the URL (in colour, as a CLI does),
 * waits for a line at its prompt, and ends with `$FAKE_EXIT`.
 */
const FAKE_CLI = `#!/bin/sh
printf 'args=%s cwd=%s term=%s profile=%s\\n' "$*" "$(pwd)" "$TERM" "$PROFILE_VAR"
printf '\\033[1mOpen this URL:\\033[0m %s\\n' '${AUTHORIZE}'
printf 'Paste the redirect URL: '
read line
printf 'got %s\\n' "$line"
exit "\${FAKE_EXIT:-0}"
`;

let bin: string;
let program: string;
let folder: string;

beforeAll(async () => {
	// Real, so that the script's `pwd` names it the way it is written here.
	bin = await realpath(await mkdtemp(join(tmpdir(), "devhub-mcp-login-")));
	program = join(bin, "fake-cli");
	folder = join(bin, "workspace");
	await writeFile(program, FAKE_CLI, { mode: 0o700 });
	await mkdir(folder);
});
afterAll(async () => {
	await rm(bin, { recursive: true, force: true });
});

/** A terminal that is a child process over pipes: enough for a script that reads a line. */
function pipePty(request: PtyRequest): Pty {
	const child = spawn(request.file, [...request.args], {
		cwd: request.cwd,
		env: request.env as NodeJS.ProcessEnv,
	});
	return {
		pid: child.pid ?? -1,
		onData(listener) {
			child.stdout.on("data", (chunk: Buffer) => listener(chunk));
			child.stderr.on("data", (chunk: Buffer) => listener(chunk));
		},
		onExit(listener) {
			child.on("close", (code) => listener(code ?? undefined));
		},
		// A terminal turns the Return it is sent into the newline `read` waits for.
		write(bytes) {
			child.stdin.write(
				Buffer.from(bytes).toString("utf8").replace(/\r/gu, "\n"),
			);
		},
		resize() {},
		kill() {
			child.kill();
		},
		pause() {},
		resume() {},
	};
}

interface Machine extends SignInMachine {
	readonly launched: PtyRequest[];
	readonly forwards: number[];
	readonly closed: number[];
}

/**
 * The Agent's machine: this Mac (`to` undefined, nothing forwarded) or a host
 * (`to` its name), or one whose forward is refused.
 */
function machine(
	kind: "local" | "remote" | "refusing",
	extra: Record<string, string> = {},
): Machine {
	const launched: PtyRequest[] = [];
	const forwards: number[] = [];
	const closed: number[] = [];
	return {
		launched,
		forwards,
		closed,
		environment: () =>
			Promise.resolve({ PATH: process.env.PATH ?? "/usr/bin:/bin", ...extra }),
		spawnPty(request) {
			launched.push(request);
			return pipePty(request);
		},
		forwardLoopbackPort(port) {
			forwards.push(port);
			if (kind === "refusing") {
				return Promise.reject(
					new Error(
						`DevHub could not forward localhost:${String(port)} to build-box: bind: Address already in use`,
					),
				);
			}
			return Promise.resolve({
				to: kind === "remote" ? "build-box" : undefined,
				close: () => {
					closed.push(port);
					return Promise.resolve();
				},
			});
		},
	};
}

function run(
	on: SignInMachine,
	env: Record<string, string> = {},
	signedIn: () => Promise<void> = () => Promise.resolve(),
): {
	readonly run: McpSignInRun;
	readonly shown: McpSignIn[];
	readonly reconnects: number[];
} {
	const shown: McpSignIn[] = [];
	const reconnects: number[] = [];
	const started = new McpSignInRun({
		machine: on,
		program,
		env: { PROFILE_VAR: "from-profile", ...env },
		cwd: folder,
		server: "linear",
		show: (signIn) => shown.push(signIn),
		signedIn: () => {
			reconnects.push(shown.length);
			return signedIn();
		},
	});
	return { run: started, shown, reconnects };
}

/** Until the command has asked for the redirect URL. */
async function prompted(shown: readonly McpSignIn[]): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!(shown.at(-1)?.output.includes("Paste the redirect URL") ?? false)) {
		if (Date.now() > deadline) throw new Error("the command never prompted");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("an MCP sign-in", () => {
	it("runs the profile's program as `mcp login <server>` in the Workspace, with the profile's environment over the machine's, and shows what it prints without the terminal's escapes", async () => {
		const on = machine("local");
		const { run: started, shown } = run(on);
		expect(shown[0]).toEqual({
			server: "linear",
			phase: "running",
			output: "",
			callback: undefined,
			failure: undefined,
		});
		await prompted(shown);
		started.input("http://localhost:43117/callback?code=c0de&state=xyz");
		const ended = await started.finished;
		expect(on.launched[0]).toMatchObject({
			file: program,
			args: ["mcp", "login", "linear"],
			cwd: folder,
		});
		expect(on.launched[0]!.env).toMatchObject({
			PROFILE_VAR: "from-profile",
			TERM: "dumb",
		});
		expect(ended.output).toContain(
			`args=mcp login linear cwd=${folder} term=dumb profile=from-profile`,
		);
		expect(ended.output).toContain(`Open this URL: ${AUTHORIZE}`);
		expect(ended.output).not.toContain("\u001b");
		expect(ended.output).toContain(
			"got http://localhost:43117/callback?code=c0de&state=xyz",
		);
		expect(ended.phase).toBe("succeeded");
		expect(ended.failure).toBeUndefined();
	});

	it("has the server reconnected once it has signed in, before it says it is done", async () => {
		const { run: started, shown, reconnects } = run(machine("remote"));
		await prompted(shown);
		started.input("");
		await started.finished;
		expect(reconnects).toHaveLength(1);
		expect(shown.slice(reconnects[0]!).map((each) => each.phase)).toEqual([
			"succeeded",
		]);
	});

	it("says so when the server could not be reconnected after signing in", async () => {
		const { run: started, shown } = run(machine("local"), {}, () =>
			Promise.reject(new Error("The conversation has stopped taking input")),
		);
		await prompted(shown);
		started.input("");
		const ended = await started.finished;
		expect(ended.phase).toBe("succeeded");
		expect(ended.failure).toBe(
			"Signed in, but the server could not be reconnected: The conversation has stopped taking input",
		);
	});

	it("on a host, forwards the authorization URL's callback port there while the command runs, says so, and takes it away when it ends", async () => {
		const on = machine("remote");
		const { run: started, shown } = run(on);
		await prompted(shown);
		expect(on.forwards).toEqual([43117]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const forwarded = shown.find((each) => each.callback !== undefined);
		expect(forwarded?.callback).toEqual({
			kind: "forwarded",
			port: 43117,
			to: "build-box",
		});
		expect(on.closed).toEqual([]);
		started.input("");
		const ended = await started.finished;
		expect(on.closed).toEqual([43117]);
		expect(ended.phase).toBe("succeeded");
	});

	it("on this Mac, has nothing forwarded and says nothing about it", async () => {
		const on = machine("local");
		const { run: started, shown } = run(on);
		await prompted(shown);
		started.input("");
		const ended = await started.finished;
		expect(ended.callback).toBeUndefined();
		expect(shown.every((each) => each.callback === undefined)).toBe(true);
	});

	it("takes the forward away when the command fails too, and says how it ended", async () => {
		const on = machine("remote");
		const { run: started, shown, reconnects } = run(on, { FAKE_EXIT: "3" });
		await prompted(shown);
		started.input("");
		const ended = await started.finished;
		expect(reconnects).toEqual([]);
		expect(on.closed).toEqual([43117]);
		expect(ended.phase).toBe("failed");
		expect(ended.failure).toBe(
			`\`${program} mcp login linear\` ended with exit code 3.`,
		);
	});

	it("goes on when the forward is refused, saying why and that the redirect can be pasted instead", async () => {
		const on = machine("refusing");
		const { run: started, shown } = run(on);
		await prompted(shown);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(shown.at(-1)?.callback).toEqual({
			kind: "unforwarded",
			port: 43117,
			why: "DevHub could not forward localhost:43117 to build-box: bind: Address already in use",
		});
		started.input("http://localhost:43117/callback?code=c0de");
		const ended = await started.finished;
		expect(ended.phase).toBe("succeeded");
	});

	it("ends as cancelled when the person cancels it", async () => {
		const on = machine("remote");
		const { run: started, shown } = run(on);
		await prompted(shown);
		started.cancel();
		const ended = await started.finished;
		expect(ended.phase).toBe("failed");
		expect(ended.failure).toBe("The sign-in was cancelled.");
		expect(on.closed).toEqual([43117]);
		expect(() => started.input("late")).toThrow(
			"the sign-in to linear is not running",
		);
	});

	it("fails with the reason when the machine cannot run it", async () => {
		const on: SignInMachine = {
			...machine("remote"),
			environment: () =>
				Promise.reject(new Error("build-box could not be reached: timed out")),
		};
		const { run: started } = run(on);
		const ended = await started.finished;
		expect(ended.phase).toBe("failed");
		expect(ended.failure).toBe("build-box could not be reached: timed out");
	});
});

describe("what a sign-in's command printed", () => {
	it("is read as the terminal would show it", () => {
		expect(
			terminalText(
				"\u001b[1mbold\u001b[0m line\r\nwaiting 1\rwaiting 2\n\u001b]0;title\u0007done\u0007",
			),
		).toBe("bold line\nwaiting 2\ndone");
	});

	it("names the callback port of the first authorization URL with a loopback redirect_uri", () => {
		expect(callbackPort(`Open ${AUTHORIZE} now`)).toBe(43117);
		expect(
			callbackPort(
				"https://a.example.com/?redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb " +
					"https://b.example.com/?redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcb",
			),
		).toBe(5555);
		expect(callbackPort("https://example.com/docs")).toBeUndefined();
		expect(
			callbackPort(
				"https://a.example.com/?redirect_uri=http%3A%2F%2Flocalhost%2Fcb",
			),
		).toBeUndefined();
	});
});
