/**
 * Signing in to one of a GUI Agent's MCP servers: the CLI's own documented
 * `<cli> mcp login <server>`, run by DevHub on the Agent's machine and shown
 * in the MCP panel as it goes.
 *
 * Both CLIs have the command (Claude Code's CLI reference, "claude mcp
 * login"; Codex's `codex mcp login`) and neither has a way to run the flow
 * from inside a structured session, so the command is the one way for both,
 * run the same way: the Agent's profile's program with the profile's
 * environment, in the Agent's Workspace folder, on the machine the Agent runs
 * on — the same CLI configuration the Agent reads, so the credentials land
 * where the Agent looks for them.
 *
 * # A terminal, not pipes
 *
 * `claude mcp login` needs an interactive terminal: where it cannot open a
 * browser (over SSH) it prints the authorization URL and asks for the
 * redirect URL to be pasted back at a prompt. So it runs on a pseudo-terminal
 * (`Runtime.spawnPty`), what it prints is shown as text with the terminal's
 * escapes taken out, and a line the person types in the panel is written to
 * it as a line typed at that prompt. `TERM=dumb`: what reads the output is
 * not a terminal emulator, and saying so keeps a CLI from drawing for one.
 * The terminal is as wide as a URL can be long, so no URL is broken in two.
 *
 * # The browser's way back
 *
 * The authorization URL's `redirect_uri` is `http://localhost:<port>/…` on
 * the machine the command runs on, where it listens for the browser. The
 * browser is this Mac's, so for an Agent on a host DevHub forwards that port
 * there for as long as the command runs (`Runtime.forwardLoopbackPort`: `ssh
 * -O forward -L` over the host's master; nothing on this Mac, where the port
 * is already the same port). It is taken away when the command ends, however
 * it ends. A forward that cannot be made is said in the panel and the
 * sign-in goes on: pasting the redirect URL at the prompt still finishes it.
 *
 * An Agent of a Workspace whose editor is attached to a dev container runs
 * where the Workspace's folder is, not in the container
 * (`runtime/container.ts`), so its sign-in is forwarded the same way as any
 * Agent on that machine: the container is never in the way.
 */

import { Buffer } from "node:buffer";
import type { McpSignIn } from "../../../model/conversation.js";
import { failureText } from "../../../model/wire.js";
import type { LoopbackForward, Runtime } from "../../runtime/runtime.js";
import type { Pty } from "../../terminal/pty.js";

/** What a sign-in needs of the Agent's machine. */
export type SignInMachine = Pick<
	Runtime,
	"environment" | "spawnPty" | "forwardLoopbackPort"
>;

export interface SignInPlan {
	readonly machine: SignInMachine;
	/** The Agent's profile's program (`claude`, `codex`): never its arguments. */
	readonly program: string;
	/** The profile's environment, over the machine's own. */
	readonly env: Readonly<Record<string, string>>;
	/** The Agent's Workspace folder, on that machine. */
	readonly cwd: string;
	readonly server: string;
	/** Told every change of how the sign-in stands, the last one included. */
	readonly show: (signIn: McpSignIn) => void;
	/**
	 * What to do once the command has signed in: have the Agent's CLI
	 * reconnect the server with the new credentials. A failure of it is the
	 * sign-in's to say.
	 */
	readonly signedIn: () => Promise<void>;
}

/**
 * Wide enough that no authorization URL wraps: a CLI that breaks its lines
 * at the terminal's width would otherwise put a newline in the middle of it.
 */
const COLUMNS = 4096;

/** Escape sequences a terminal program writes: CSI, OSC, and the two-byte ones. */
const ESCAPES =
	// eslint-disable-next-line no-control-regex -- terminal escapes are control characters
	/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/gu;
// eslint-disable-next-line no-control-regex -- the control characters a text view drops
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

/**
 * What a terminal program printed, as the text a person would read on the
 * terminal: escapes gone, and a line a carriage return went back over is
 * what was written over it last.
 */
export function terminalText(printed: string): string {
	return printed
		.replace(ESCAPES, "")
		.replace(/\r\n/gu, "\n")
		.split("\n")
		.map((line) => {
			// A progress line redrawn in place: what is left is the last drawing.
			const parts = line.split("\r").filter((part) => part.length > 0);
			return (parts.at(-1) ?? "").replace(CONTROLS, "");
		})
		.join("\n");
}

const URLS = /https?:\/\/[^\s"'<>`]+/gu;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The port an authorization URL in `text` has the browser come back to: the
 * port of its `redirect_uri`, when that is a loopback address. The first
 * such URL decides.
 */
export function callbackPort(text: string): number | undefined {
	for (const [found] of text.matchAll(URLS)) {
		// Text that only looked like a URL, or a `redirect_uri` that is not
		// one, names no port to forward.
		if (!URL.canParse(found)) continue;
		const uri = new URL(found).searchParams.get("redirect_uri");
		if (uri === null || !URL.canParse(uri)) continue;
		const redirect = new URL(uri);
		if (!LOOPBACK.has(redirect.hostname) || redirect.port === "") continue;
		return Number(redirect.port);
	}
	return undefined;
}

/**
 * One run of `<program> mcp login <server>`. It starts as it is made; how
 * it stands is told to `plan.show`, and `finished` settles with how it ended
 * — it never rejects: whatever stopped it is its `failure`, in the panel.
 */
export class McpSignInRun {
	readonly server: string;
	readonly finished: Promise<McpSignIn>;

	readonly #plan: SignInPlan;
	#state: McpSignIn;
	#printed = "";
	#pty: Pty | undefined;
	#cancelled = false;
	#forward: Promise<LoopbackForward | undefined> | undefined;

	constructor(plan: SignInPlan) {
		this.#plan = plan;
		this.server = plan.server;
		this.#state = {
			server: plan.server,
			phase: "running",
			output: "",
			callback: undefined,
			failure: undefined,
		};
		plan.show(this.#state);
		this.finished = this.#run();
	}

	get state(): McpSignIn {
		return this.#state;
	}

	/** A line the person typed in the panel, written as if typed at the command's prompt. */
	input(text: string): void {
		const pty = this.#pty;
		if (pty === undefined || this.#state.phase !== "running") {
			throw new Error(
				`the sign-in to ${this.server} is not running, so it takes nothing typed`,
			);
		}
		pty.write(Buffer.from(`${text}\r`, "utf8"));
	}

	/** Stop the command; the sign-in ends as cancelled. */
	cancel(): void {
		if (this.#state.phase !== "running") return;
		this.#cancelled = true;
		this.#pty?.kill();
	}

	#show(patch: Partial<McpSignIn>): void {
		this.#state = { ...this.#state, ...patch };
		this.#plan.show(this.#state);
	}

	/**
	 * The whole run, and its one root: anything that stopped it — the
	 * machine's environment unreadable, the command not starting, a forward
	 * that could not be taken away — is the sign-in's failure, shown where the
	 * sign-in is.
	 */
	async #run(): Promise<McpSignIn> {
		const plan = this.#plan;
		const failures: string[] = [];
		let exitCode: number | undefined;
		try {
			exitCode = await this.#command();
		} catch (failure: unknown) {
			failures.push(failureText(failure));
		}
		// However the command ended, the forward goes with it.
		try {
			await this.#closeForward();
		} catch (failure: unknown) {
			failures.push(failureText(failure));
		}
		if (failures.length === 0 && exitCode !== 0) {
			failures.push(
				this.#cancelled
					? "The sign-in was cancelled."
					: `\`${plan.program} mcp login ${plan.server}\` ended ${exitCode === undefined ? "without an exit code" : `with exit code ${String(exitCode)}`}.`,
			);
		}
		if (failures.length > 0) {
			this.#show({ phase: "failed", failure: failures.join(" ") });
			return this.#state;
		}
		try {
			await plan.signedIn();
		} catch (failure: unknown) {
			this.#show({
				phase: "succeeded",
				failure: `Signed in, but the server could not be reconnected: ${failureText(failure)}`,
			});
			return this.#state;
		}
		this.#show({ phase: "succeeded" });
		return this.#state;
	}

	/** Run the command to its end: its exit code. */
	async #command(): Promise<number | undefined> {
		const plan = this.#plan;
		const env = {
			...(await plan.machine.environment()),
			...plan.env,
			TERM: "dumb",
			NO_COLOR: "1",
		};
		if (this.#cancelled) return undefined;
		const pty = plan.machine.spawnPty({
			file: plan.program,
			args: ["mcp", "login", plan.server],
			cwd: plan.cwd,
			cols: COLUMNS,
			rows: 40,
			pixelWidth: 0,
			pixelHeight: 0,
			env,
		});
		this.#pty = pty;
		const exited = new Promise<number | undefined>((resolve) => {
			pty.onExit(resolve);
		});
		pty.onData((bytes) => {
			this.#printed += Buffer.from(bytes).toString("utf8");
			this.#show({ output: terminalText(this.#printed) });
			this.#forwardOnce();
		});
		return exited;
	}

	/** Forward the callback port, once the command has printed a URL naming one. */
	#forwardOnce(): void {
		if (this.#forward !== undefined) return;
		const port = callbackPort(this.#state.output);
		if (port === undefined) return;
		this.#forward = this.#plan.machine.forwardLoopbackPort(port).then(
			(forward) => {
				if (forward.to !== undefined) {
					this.#show({
						callback: { kind: "forwarded", port, to: forward.to },
					});
				}
				return forward;
			},
			(failure: unknown) => {
				// The sign-in goes on without it: the redirect URL can still be
				// pasted at the command's prompt, and the panel says so.
				this.#show({
					callback: { kind: "unforwarded", port, why: failureText(failure) },
				});
				return undefined;
			},
		);
	}

	async #closeForward(): Promise<void> {
		const forward = await this.#forward;
		await forward?.close();
	}
}
