/**
 * DevHub's own readers of Claude's and Codex's plan limits, so the Sidebar's
 * readout is there without a GUI Agent having run a turn.
 *
 * One reader per CLI kind, each keeping **one long-lived process** on this
 * Mac, started with the first profile of that kind in Settings' order — its
 * command and its environment, the account a launch from it would use. The
 * profile's own arguments are not passed: they are for a conversation (a
 * model, a permission mode, a session to resume), and the reader must never
 * load or start one. With several profiles of a kind, the first is the one
 * read; the others are assumed to share its account.
 *
 * - **Claude**: `claude -p` in stream-json (`CLAUDE_USAGE_FLAGS`), sent the
 *   control requests `initialize` and then `get_usage` — the SDK's
 *   `SDKControlGetUsageRequest`, which the SDK marks experimental. No model is
 *   called and no message is ever written.
 * - **Codex**: `codex app-server`, sent `initialize`, `initialized`, and per
 *   reading `account/read` and — for a ChatGPT sign-in — the public
 *   `account/rateLimits/read`, the request Codex's own TUI polls. No thread is
 *   opened.
 *
 * A sign-in with no plan limits (an API key, Bedrock) is an answer, said in
 * the Sidebar as a state. A CLI whose command is not on this Mac is not
 * started, and the readout says so too.
 *
 * # How often
 *
 * Codex's TUI rule, by the most used window of the reader's last reading: 60 s,
 * 30 s from 75%, 15 s from 90%, 5 s from 99%, and one read at start. Claude's
 * endpoint is experimental, so it is asked at most once a minute until a
 * window reaches 90%: 60 s below 90%, 15 s from 90%, 5 s from 99%.
 *
 * # Failures
 *
 * A process that will not start or stops, a request the CLI refuses, a
 * response in a shape DevHub does not read: the reader stops, its process is
 * killed, and the failure is said once as `usage_unreadable` at the root. It
 * is not retried — a retry loop would say the same failure again and again —
 * and restarting DevHub asks again. Readings already taken stay in the
 * readout, which goes on with what GUI Agents report.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { UsageNoteWire } from "../../ipc/contract.js";
import type { ConfiguredAgentProfile } from "../../model/config.js";
import type { UsageReading } from "../../model/conversation.js";
import {
	errorWireAt,
	failureText,
	NamedFailure,
	withDetail,
} from "../../model/wire.js";
import { CLAUDE_USAGE_FLAGS } from "../agent/conversation/claude/argv.js";
import {
	decodeReceived,
	decodeUsage,
} from "../agent/conversation/claude/decode.js";
import {
	accountResponse,
	decodeLine,
	rateLimits,
	Reader,
} from "../agent/conversation/codex/decode.js";
import type { GetAccountParams } from "../agent/conversation/codex/protocol/v2/GetAccountParams.js";
import type { InitializeParams } from "../agent/conversation/codex/protocol/InitializeParams.js";
import type { MachineCommand, Runtime } from "../runtime/runtime.js";
import { LIMITED_CLIS, type LimitedCli } from "./usageLimits.js";

const CLI_NAMES: Readonly<Record<LimitedCli, string>> = {
	claude: "Claude",
	codex: "Codex",
};

// ---------------------------------------------------------------------------
// The process.

/** A program spoken to in lines of JSON, one each way. */
export interface LineProcess {
	send(message: object): void;
	/** Every line the program writes on stdout, in order. */
	onLine(listener: (line: string) => void): void;
	/**
	 * Aborted once the program is gone or could not start, with the sentence
	 * why as its reason. A signal rather than a promise, so that an end nobody
	 * is waiting on at that moment is still read, and never unhandled.
	 */
	readonly ended: AbortSignal;
	/** Stop it. Idempotent. */
	kill(): void;
}

/** How much of stderr a failure quotes: the end is where a reason is. */
const STDERR_TAIL = 2048;

export function spawnLineProcess(
	command: MachineCommand,
	cwd: string,
): LineProcess {
	const child = spawn(command.file, [...command.args], {
		cwd,
		env: command.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const ended = new AbortController();
	let stderr = "";
	const end = (why: string) => {
		if (ended.signal.aborted) return;
		const said = stderr.trim();
		ended.abort(new Error(said === "" ? why : `${why}: ${said}`));
	};
	child.on("error", (error) => {
		end(`${command.file} could not be started: ${error.message}`);
	});
	child.on("exit", (code, signal) => {
		end(
			`${command.file} stopped (${signal === null ? `exit code ${String(code)}` : signal})`,
		);
	});
	child.stdin.on("error", (error) => {
		end(`${command.file} stopped reading: ${error.message}`);
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-STDERR_TAIL);
	});
	const lines = createInterface({ input: child.stdout });
	return {
		send(message) {
			child.stdin.write(`${JSON.stringify(message)}\n`);
		},
		onLine(listener) {
			lines.on("line", listener);
		},
		ended: ended.signal,
		kill() {
			child.stdin.end();
			child.kill();
		},
	};
}

// ---------------------------------------------------------------------------
// The two protocols.

/** One CLI's account, asked over its process. */
export interface UsageSource {
	/** The handshake. */
	open(): Promise<void>;
	read(): Promise<UsageReading>;
	/**
	 * Aborted once the source can answer nothing more — its process ended, or
	 * said something DevHub cannot read — with the reason.
	 */
	readonly ended: AbortSignal;
	/** Stop its process. Idempotent. */
	close(): void;
}

/**
 * Requests a process answers by id, and the one rule for their failure: when
 * the process ends, or says something that cannot be read, every request
 * waiting fails with that reason, and so does every request after it.
 */
class Pending<Answer> {
	readonly #waiting = new Map<
		string,
		{
			readonly resolve: (answer: Answer) => void;
			readonly reject: (failure: unknown) => void;
		}
	>();
	readonly #broken = new AbortController();
	readonly ended = this.#broken.signal;

	constructor(child: LineProcess) {
		if (child.ended.aborted) this.fail(child.ended.reason);
		child.ended.addEventListener("abort", () => {
			this.fail(child.ended.reason);
		});
	}

	wait(id: string): Promise<Answer> {
		if (this.ended.aborted) return Promise.reject(this.ended.reason as Error);
		return new Promise((resolve, reject) => {
			this.#waiting.set(id, { resolve, reject });
		});
	}

	/** Answer `id`; a request never asked is a failure. */
	answer(id: string, answer: Answer): void {
		const waiting = this.#waiting.get(id);
		if (waiting === undefined) {
			this.fail(new Error(`the CLI answered ${id}, which DevHub did not ask`));
			return;
		}
		this.#waiting.delete(id);
		waiting.resolve(answer);
	}

	fail(failure: unknown): void {
		if (!this.ended.aborted) this.#broken.abort(failure);
		for (const waiting of this.#waiting.values()) {
			waiting.reject(this.ended.reason);
		}
		this.#waiting.clear();
	}
}

type ClaudeAnswer = Extract<
	ReturnType<typeof decodeReceived>,
	{ type: "control_response" }
>["outcome"];

/**
 * `claude -p` in stream-json, asked with control requests only.
 *
 * A line that is not a control response is not an answer to anything the
 * reader asked, and is not read: with no message ever sent, nothing a
 * conversation says can follow.
 */
export class ClaudeUsageSource implements UsageSource {
	readonly #pending: Pending<ClaudeAnswer>;
	readonly ended: AbortSignal;
	#next = 0;

	constructor(private readonly child: LineProcess) {
		this.#pending = new Pending(child);
		this.ended = this.#pending.ended;
		child.onLine((line) => {
			this.#line(line);
		});
	}

	close(): void {
		this.child.kill();
	}

	async open(): Promise<void> {
		await this.#request("initialize");
	}

	async read(): Promise<UsageReading> {
		return decodeUsage(await this.#request("get_usage"), undefined);
	}

	async #request(subtype: "initialize" | "get_usage") {
		this.#next += 1;
		const id = `devhub-usage-${String(this.#next)}`;
		const answer = this.#pending.wait(id);
		this.child.send({
			type: "control_request",
			request_id: id,
			request: { subtype },
		});
		const outcome = await answer;
		if (!outcome.ok) {
			throw new Error(`claude refused ${subtype}: ${outcome.error}`);
		}
		return outcome.payload;
	}

	#line(line: string): void {
		try {
			let type: unknown;
			try {
				type = (JSON.parse(line) as { type?: unknown }).type;
			} catch {
				throw new Error(
					`claude wrote a line that is not JSON: ${line.slice(0, 200)}`,
				);
			}
			if (type !== "control_response") return;
			const decoded = decodeReceived(line, undefined);
			if (decoded.type !== "control_response") {
				throw new Error(`a control response decoded as ${decoded.type}`);
			}
			this.#pending.answer(decoded.requestId, decoded.outcome);
		} catch (failure) {
			// Read where it arrived, said where it is waited on: the reader
			// stops on it.
			this.#pending.fail(failure);
		}
	}
}

/**
 * `codex app-server`, asked for its account and its rate limits.
 *
 * Notifications are not read — `account/rateLimits/updated` among them, which
 * says again what the next read says. A request *from* the server is refused
 * as a failure: a reader opens no thread, so there is nothing for Codex to
 * ask about, and leaving one unanswered could hold the server.
 */
export class CodexUsageSource implements UsageSource {
	readonly #pending: Pending<
		| { readonly ok: true; readonly result: unknown }
		| { readonly ok: false; readonly error: string }
	>;
	readonly #reader = new Reader(undefined);
	readonly ended: AbortSignal;
	#next = 0;

	constructor(
		private readonly child: LineProcess,
		private readonly clientVersion: string,
	) {
		this.#pending = new Pending(child);
		this.ended = this.#pending.ended;
		child.onLine((line) => {
			this.#line(line);
		});
	}

	close(): void {
		this.child.kill();
	}

	async open(): Promise<void> {
		await this.#call("initialize", {
			clientInfo: {
				name: "devhub",
				title: "DevHub",
				version: this.clientVersion,
			},
			capabilities: { experimentalApi: false, requestAttestation: false },
		} satisfies InitializeParams);
		this.child.send({ method: "initialized" });
	}

	async read(): Promise<UsageReading> {
		const account = accountResponse(
			this.#reader,
			await this.#call("account/read", {} satisfies GetAccountParams),
		);
		if (account.account === null) {
			throw new Error(
				"codex is not signed in, so it has no limits to read. Run `codex login` in a terminal.",
			);
		}
		// Only a ChatGPT sign-in has plan limits: an API key or Bedrock is
		// refused by the read ("chatgpt authentication required").
		if (account.account !== "chatgpt") return { kind: "no_plan_limits" };
		// `GetAccountRateLimitsParams` is not among the vendored types; the
		// one field is the protocol's, and leaves out the list of reset
		// credits, which DevHub does not show.
		const result = await this.#call("account/rateLimits/read", {
			excludeResetCreditDetails: true,
		});
		return {
			kind: "windows",
			windows: rateLimits(this.#reader, result, "result").windows,
		};
	}

	async #call(method: string, params: object): Promise<unknown> {
		const id = this.#next;
		this.#next += 1;
		const answer = this.#pending.wait(String(id));
		this.child.send({ id, method, params });
		const outcome = await answer;
		if (!outcome.ok)
			throw new Error(`codex refused ${method}: ${outcome.error}`);
		return outcome.result;
	}

	#line(line: string): void {
		try {
			const message = decodeLine(this.#reader, line);
			switch (message.kind) {
				case "notification":
					return;
				case "request":
					throw new Error(
						`codex asked ${message.method}, which a usage reader does not answer`,
					);
				case "restart":
					throw new Error(
						"codex app-server said it restarted, which only DevHub's host says",
					);
				case "response":
					return this.#pending.answer(String(message.id), {
						ok: true,
						result: message.result,
					});
				case "error":
					return this.#pending.answer(
						message.id === null ? "null" : String(message.id),
						{
							ok: false,
							error: `${message.message} (${String(message.code)})`,
						},
					);
			}
		} catch (failure) {
			this.#pending.fail(failure);
		}
	}
}

// ---------------------------------------------------------------------------
// How often.

/** From the most used window up: at or over `from` percent, every `ms`. */
const INTERVALS: Readonly<
	Record<LimitedCli, readonly { readonly from: number; readonly ms: number }[]>
> = {
	codex: [
		{ from: 99, ms: 5_000 },
		{ from: 90, ms: 15_000 },
		{ from: 75, ms: 30_000 },
	],
	// Experimental: at most once a minute until a window is at 90%.
	claude: [
		{ from: 99, ms: 5_000 },
		{ from: 90, ms: 15_000 },
	],
};

const USUAL_INTERVAL_MS = 60_000;

/** How long after `reading` the next read is. */
export function pollInterval(cli: LimitedCli, reading: UsageReading): number {
	const most =
		reading.kind === "windows"
			? Math.max(-1, ...reading.windows.map((one) => one.usedPercent ?? -1))
			: -1;
	return (
		INTERVALS[cli].find((step) => most >= step.from)?.ms ?? USUAL_INTERVAL_MS
	);
}

// ---------------------------------------------------------------------------
// One reader.

/** Resolves after `ms`, or as soon as `signal` is aborted. */
export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

export function usageUnreadable(
	cli: LimitedCli,
	profile: string,
	failure: unknown,
): NamedFailure {
	return new NamedFailure(
		withDetail(
			errorWireAt("usage_unreadable"),
			`${CLI_NAMES[cli]}, read with the profile “${profile}”: ${failureText(failure)}`,
		),
		{ cause: failure },
	);
}

export class UsageReader {
	readonly #stop = new AbortController();

	constructor(
		readonly cli: LimitedCli,
		/** The profile's name, for the sentence a failure is said in. */
		private readonly profile: string,
		private readonly source: UsageSource,
		private readonly deliver: (reading: UsageReading) => void,
		private readonly wait: (
			ms: number,
			signal: AbortSignal,
		) => Promise<void> = waitFor,
	) {}

	/**
	 * Read until stopped. Rejects, once, with `usage_unreadable` when a read
	 * cannot be taken; a stop ends it quietly, whatever the kill did to a read
	 * in flight, because that was asked for.
	 */
	async run(): Promise<void> {
		const stopOrEnd = AbortSignal.any([this.#stop.signal, this.source.ended]);
		try {
			await this.source.open();
			while (!stopOrEnd.aborted) {
				const reading = await this.source.read();
				if (this.#stop.signal.aborted) return;
				this.deliver(reading);
				await this.wait(pollInterval(this.cli, reading), stopOrEnd);
			}
			if (!this.#stop.signal.aborted) throw this.source.ended.reason;
		} catch (failure) {
			if (this.#stop.signal.aborted) return;
			throw usageUnreadable(this.cli, this.profile, failure);
		} finally {
			this.source.close();
		}
	}

	stop(): void {
		this.#stop.abort();
		this.source.close();
	}
}

// ---------------------------------------------------------------------------
// Every reader.

export interface UsageReadersDeps {
	/** Settings' profiles, in its order. */
	readonly profiles: readonly ConfiguredAgentProfile[];
	/** This Mac. */
	readonly runtime: Pick<Runtime, "resolveProgram" | "environment" | "home">;
	/** This Mac's launch PATH, which `resolveProgram` searches. */
	readonly searchPath: string;
	/** DevHub's own version, which Codex is told. */
	readonly clientVersion: string;
	readonly spawn: (command: MachineCommand, cwd: string) => LineProcess;
	readonly deliver: (cli: LimitedCli, reading: UsageReading) => void;
	readonly note: (cli: LimitedCli, note: UsageNoteWire) => void;
	/** The root surface: a reader's failure, once. */
	readonly report: (failure: NamedFailure) => void;
	readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The command a reader of `cli` runs: the profile's program, never its arguments. */
function usageCommand(
	cli: LimitedCli,
	file: string,
	env: Readonly<Record<string, string>>,
): MachineCommand {
	return {
		file,
		args: cli === "claude" ? CLAUDE_USAGE_FLAGS : ["app-server"],
		env,
	};
}

/**
 * Start a reader for each CLI with plan limits that has a profile; stop them
 * all with the answer. Everything a reader does — finding its command,
 * starting it, reading — happens after this returns.
 */
export function startUsageReaders(deps: UsageReadersDeps): { stop(): void } {
	const readers: UsageReader[] = [];
	let stopped = false;
	for (const cli of LIMITED_CLIS) {
		const profile = deps.profiles.find((one) => one.kind === cli);
		if (profile === undefined) continue;
		const start = async (): Promise<void> => {
			const resolved = await deps.runtime.resolveProgram(
				profile.command,
				deps.searchPath,
			);
			if (resolved.kind === "unavailable") {
				deps.note(cli, "cli_not_found");
				return;
			}
			const env = { ...(await deps.runtime.environment()), ...profile.env };
			const home = await deps.runtime.home();
			if (stopped) return;
			const child = deps.spawn(usageCommand(cli, resolved.value, env), home);
			const reader = new UsageReader(
				cli,
				profile.display_name,
				cli === "claude"
					? new ClaudeUsageSource(child)
					: new CodexUsageSource(child, deps.clientVersion),
				(reading) => {
					deps.deliver(cli, reading);
				},
				deps.wait,
			);
			readers.push(reader);
			await reader.run();
		};
		void start().catch((failure: unknown) => {
			deps.report(
				failure instanceof NamedFailure &&
					failure.wire.code === "usage_unreadable"
					? failure
					: usageUnreadable(cli, profile.display_name, failure),
			);
		});
	}
	return {
		stop() {
			stopped = true;
			for (const reader of readers) reader.stop();
		},
	};
}
