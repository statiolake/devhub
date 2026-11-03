/**
 * DevHub's own readers of Claude's and Codex's plan limits, so the Sidebar's
 * readout is there without a GUI Agent having run a turn.
 *
 * One reader per CLI kind, reading with the first profile of that kind in
 * Settings' order — its command and its environment, the account a launch from
 * it would use. The profile's own arguments are not passed: they are for a
 * conversation (a model, a permission mode, a session to resume), and the
 * reader must never load or start one. With several profiles of a kind, the
 * first is the one read; the others are assumed to share its account.
 *
 * **No process stays between readings.** Each reading starts the CLI, does the
 * handshake and one read, and kills it — also when it fails or times out.
 *
 * - **Claude**: `claude -p` in stream-json (`CLAUDE_USAGE_FLAGS`), sent the
 *   control requests `initialize` and then `get_usage` — the SDK's
 *   `SDKControlGetUsageRequest`, which the SDK marks experimental. No model is
 *   called and no message is ever written.
 * - **Codex**: `codex app-server`, sent `initialize`, `initialized`,
 *   `account/read` and — for a ChatGPT sign-in — the public
 *   `account/rateLimits/read`, the request Codex's own TUI polls. No thread is
 *   opened.
 *
 * A sign-in with no plan limits (an API key, Bedrock) is an answer, said in
 * the Sidebar as a state. A CLI whose command is not on this Mac is not
 * started, and the readout says so too.
 *
 * # How often
 *
 * By the most used window of the reader's latest reading: 60 s, 15 s from 90%,
 * 5 s from 99% (Codex's TUI rule also has 30 s from 75%; Claude's endpoint is
 * experimental, so it stays at 60 s until a window reaches 90%). The first
 * reading is at start.
 *
 * # When there is no reading
 *
 * Two kinds of attempt give nothing:
 *
 * - **A failure**: a process that will not start or stops, a request the CLI
 *   refuses, a response in a shape DevHub does not read, or a whole attempt —
 *   finding the command, the environment, the start, the handshake and the
 *   read — not done within 30 s (`READ_TIMEOUT_MS`). That attempt's process is
 *   killed (and a process that will not go is killed hard).
 * - **No reading**: Claude answering that the plan has limits but it could
 *   not fetch them just now (`rate_limits: null`: its usage endpoint answered
 *   429, or could not be reached). Each reading is a fresh process, so nothing
 *   the CLI remembers of a 429 carries over to the next one — asking again
 *   every minute only keeps the endpoint saying no.
 *
 * Either way the next attempt backs off: after the first, at the usual
 * cadence; then 2, 5 and 10 minutes (`BACKOFF_MS`), staying at 10 until an
 * attempt reads. A reading ends the streak. Readings already taken stay in the
 * readout meanwhile, which goes on with what GUI Agents report, and the
 * reader's status (`deps.status`: when it last read, why its latest attempt
 * gave nothing) goes on the wire, so the readout fades and its tooltip says
 * when it last read and why it could not since. Readings are one at a time per
 * CLI, so a slow one never overlaps or holds up the next. A failure to start
 * also looks the command up again at the next attempt, in case it moved.
 *
 * A failure is also said once as `usage_unreadable` at the root — on the first
 * failure of a streak, not on each retry (the root surface has no way to take
 * a notice back, so a recovery says nothing). No reading is not said there.
 *
 * Not retried: a command that is not on this Mac (the readout says so; a
 * settings change is picked up at the next start of DevHub). A sign-in with no
 * plan limits is an answer, asked again at the usual cadence.
 *
 * # The log
 *
 * Every attempt's outcome goes to main's log (`devhub-main.log`), as
 * `[devhub] usage reader <cli>: …` — `read in 1.2 s: 5-hour 34% resets …`,
 * `no reading in 0.9 s: …`, `failed after 30.0 s: …`, with the next attempt's
 * delay — but only when it is not the same kind of outcome as the line before
 * (or a failure with other words), and otherwise once every 15 minutes with how
 * many attempts went unsaid, so a reader that reads every minute adds four
 * lines an hour. (`usageLimits.ts` logs, as `[devhub] usage <cli>: kept …`, a
 * window the readout kept over the reader's reading of it.)
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
import {
	describeWindow,
	LIMITED_CLIS,
	LOG_AGAIN_MS,
	type LimitedCli,
	type UsageReaderStatus,
} from "./usageLimits.js";

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

/** How long a killed process has to go before it is killed hard. */
const KILL_GRACE_MS = 5_000;

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
			// A CLI that does not go on SIGTERM is not left behind.
			if (child.exitCode === null && child.signalCode === null) {
				const timer = setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) {
						child.kill("SIGKILL");
					}
				}, KILL_GRACE_MS);
				(timer as unknown as { unref?: () => void }).unref?.();
			}
		},
	};
}

// ---------------------------------------------------------------------------
// The two protocols.

/** One CLI's account, asked over its process. */
export interface UsageSource {
	/** The handshake. */
	open(): Promise<void>;
	/** `undefined`: the CLI had no reading this time (not a failure). */
	read(): Promise<UsageReading | undefined>;
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
	#next = 0;

	constructor(private readonly child: LineProcess) {
		this.#pending = new Pending(child);
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

	async read(): Promise<UsageReading | undefined> {
		return decodeUsage(await this.#request("get_usage"), undefined);
	}

	async #request(subtype: "initialize" | "get_usage") {
		// `skip_behaviors`: get_usage otherwise also scans the session history
		// for its "behaviors" recommendations, which a readout never shows.
		this.#next += 1;
		const id = `devhub-usage-${String(this.#next)}`;
		const answer = this.#pending.wait(id);
		this.child.send({
			type: "control_request",
			request_id: id,
			request:
				subtype === "get_usage"
					? { subtype, skip_behaviors: true }
					: { subtype },
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
	#next = 0;

	constructor(
		private readonly child: LineProcess,
		private readonly clientVersion: string,
	) {
		this.#pending = new Pending(child);
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

	async read(): Promise<UsageReading | undefined> {
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
// Every reader.

/** Resolves after `ms`, or as soon as `signal` is aborted. */
function waitFor(ms: number, signal: AbortSignal): Promise<void> {
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

/**
 * How long one whole attempt (finding the command, the environment, the start,
 * the handshake and the read) may take before it is abandoned and killed.
 */
export const READ_TIMEOUT_MS = 30_000;

/**
 * The waits after the second, third and later attempts in a row with no
 * reading (the first waits the usual cadence), the last repeated.
 */
export const BACKOFF_MS: readonly number[] = [
	2 * 60_000,
	5 * 60_000,
	10 * 60_000,
];

/**
 * `work`, failing if it is not settled within `ms`; its signal is aborted
 * then, so that what it has not started yet is never started.
 */
function within<T>(
	work: (signal: AbortSignal) => Promise<T>,
	ms: number,
	what: string,
): Promise<T> {
	const abandoned = new AbortController();
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			const failure = new Error(
				`${what} was not answered within ${String(ms / 1000)} s`,
			);
			abandoned.abort(failure);
			reject(failure);
		}, ms);
		// Started inside the promise, so a throw before its first await is a
		// rejection too.
		Promise.resolve()
			.then(() => work(abandoned.signal))
			.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(failure: unknown) => {
					clearTimeout(timer);
					reject(failure as Error);
				},
			);
	});
}

function usageUnreadable(
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

/** What one attempt came to. */
type Outcome =
	| { readonly kind: "read"; readonly reading: UsageReading }
	| { readonly kind: "none"; readonly why: string }
	| { readonly kind: "failed"; readonly failure: unknown }
	| { readonly kind: "not_found" };

/** Why an attempt that the CLI answered had no reading. */
const NO_READING: Readonly<Record<LimitedCli, string>> = {
	claude:
		"no reading: Claude could not fetch its limits just now (its usage endpoint rate-limited it or could not be reached)",
	codex: "no reading: Codex had no limits to say just now",
};

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
	/** The reader's status after each attempt: when it last read, why it could not since. */
	readonly status: (cli: LimitedCli, status: UsageReaderStatus) => void;
	/** The root surface: a reader's failure, once per streak. */
	readonly report: (failure: NamedFailure) => void;
	readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Main's log; `console.log` by default. */
	readonly log?: (line: string) => void;
	/** The clock; `Date.now` by default. */
	readonly now?: () => number;
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

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)} s`;
}

function delay(ms: number): string {
	return ms >= 60_000 ? `${String(Math.round(ms / 60_000))} min` : seconds(ms);
}

/**
 * Start a reader loop for each CLI with plan limits that has a profile; stop
 * them all with the answer. Everything a reader does — finding its command,
 * starting it, reading — happens after this returns.
 */
export function startUsageReaders(deps: UsageReadersDeps): { stop(): void } {
	const stopped = new AbortController();
	/** The processes alive now, at most one per CLI. */
	const live = new Set<UsageSource>();
	const wait = deps.wait ?? waitFor;
	const log =
		deps.log ??
		((line: string) => {
			console.log(line);
		});
	const now = deps.now ?? Date.now;
	for (const cli of LIMITED_CLIS) {
		const profile = deps.profiles.find((one) => one.kind === cli);
		if (profile === undefined) continue;
		const say = (line: string) => {
			log(`[devhub] usage reader ${cli}: ${line}`);
		};
		let program: string | undefined;
		// One process for one reading, killed whatever comes of it; every
		// step of it under the one timeout.
		const attempt = async (signal: AbortSignal): Promise<Outcome> => {
			if (program === undefined) {
				const resolved = await deps.runtime.resolveProgram(
					profile.command,
					deps.searchPath,
				);
				if (resolved.kind === "unavailable") return { kind: "not_found" };
				program = resolved.value;
			}
			const env = { ...(await deps.runtime.environment()), ...profile.env };
			const home = await deps.runtime.home();
			if (signal.aborted) throw signal.reason;
			if (stopped.signal.aborted) return { kind: "none", why: "stopped" };
			const child = deps.spawn(usageCommand(cli, program, env), home);
			const source =
				cli === "claude"
					? new ClaudeUsageSource(child)
					: new CodexUsageSource(child, deps.clientVersion);
			live.add(source);
			const abandon = () => {
				source.close();
			};
			signal.addEventListener("abort", abandon, { once: true });
			try {
				await source.open();
				const reading = await source.read();
				return reading === undefined
					? { kind: "none", why: NO_READING[cli] }
					: { kind: "read", reading };
			} finally {
				signal.removeEventListener("abort", abandon);
				live.delete(source);
				source.close();
			}
		};
		const loop = async (): Promise<void> => {
			let last: UsageReading | undefined;
			let readAt: number | undefined;
			// Attempts in a row with no reading; whether this streak's failure was said.
			let streak = 0;
			let said = false;
			// What the log said last, and how many attempts it has not said since.
			let logged: { key: string; at: number } | undefined;
			let unsaid = 0;
			while (!stopped.signal.aborted) {
				const started = now();
				let outcome: Outcome;
				try {
					outcome = await within(attempt, READ_TIMEOUT_MS, "the usage read");
				} catch (failure) {
					outcome = { kind: "failed", failure };
				}
				if (stopped.signal.aborted) return;
				const took = now() - started;
				if (outcome.kind === "not_found") {
					say(`the command ${profile.command} is not on this Mac; not read`);
					deps.note(cli, "cli_not_found");
					return;
				}
				const cadence =
					last === undefined ? USUAL_INTERVAL_MS : pollInterval(cli, last);
				let next: number;
				let line: string;
				let key: string;
				if (outcome.kind === "read") {
					last = outcome.reading;
					readAt = now();
					streak = 0;
					said = false;
					next = pollInterval(cli, last);
					deps.deliver(cli, outcome.reading);
					deps.status(cli, { readAt });
					key = "read";
					line = `read in ${seconds(took)}: ${
						outcome.reading.kind === "no_plan_limits"
							? "no plan limits"
							: outcome.reading.windows.length === 0
								? "no windows"
								: outcome.reading.windows.map(describeWindow).join(", ")
					}`;
				} else {
					streak += 1;
					next =
						streak === 1
							? cadence
							: BACKOFF_MS[Math.min(streak - 1, BACKOFF_MS.length) - 1]!;
					const text =
						outcome.kind === "none"
							? outcome.why
							: failureText(outcome.failure);
					deps.status(cli, {
						...(readAt === undefined ? {} : { readAt }),
						problem: { at: now(), text },
					});
					if (outcome.kind === "failed") {
						// Looked up again next time: a command that would not
						// start may have moved.
						program = undefined;
						if (!said) {
							said = true;
							deps.report(
								usageUnreadable(cli, profile.display_name, outcome.failure),
							);
						}
						key = `failed: ${text}`;
						line = `failed after ${seconds(took)}: ${text}`;
					} else {
						key = "none";
						line = `${text} (in ${seconds(took)})`;
					}
					line += ` (${String(streak)} in a row; next in ${delay(next)})`;
				}
				const at = now();
				if (
					logged === undefined ||
					logged.key !== key ||
					at - logged.at >= LOG_AGAIN_MS
				) {
					say(
						unsaid === 0
							? line
							: `${line} [${String(unsaid)} attempts not logged since the last line]`,
					);
					logged = { key, at };
					unsaid = 0;
				} else {
					unsaid += 1;
				}
				await wait(next, stopped.signal);
			}
		};
		void loop().catch((failure: unknown) => {
			// Nothing above throws; if it ever does, the log says the reader
			// ended rather than it going quiet.
			say(`stopped reading: ${failureText(failure)}`);
		});
	}
	return {
		stop() {
			stopped.abort();
			for (const source of live) source.close();
		},
	};
}
