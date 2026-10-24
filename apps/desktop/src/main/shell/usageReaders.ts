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
 * # Failures
 *
 * A process that will not start or stops, a request the CLI refuses, a
 * response in a shape DevHub does not read, a reading not done within 30 s
 * (`READ_TIMEOUT_MS`): that reading's process is killed and the next one is at
 * the next tick, at the same cadence — no backoff, no giving up. Readings are
 * one at a time per CLI, so a slow one never overlaps or holds up the next.
 *
 * The failure is said once as `usage_unreadable` at the root — on the first
 * failure of a streak, not on each retry; a successful reading ends the streak
 * (the root surface has no way to take a notice back, so a recovery says
 * nothing). Readings already taken stay in the readout meanwhile, which goes on
 * with what GUI Agents report.
 *
 * Not a failure: Claude answering that the plan has limits but it could not
 * fetch them just now (`rate_limits: null`, e.g. its usage endpoint answered
 * 429). Nothing is delivered and the usual cadence goes on.
 *
 * Not retried: a command that is not on this Mac (the readout says so; a
 * settings change is picked up at the next start of DevHub). A sign-in with no
 * plan limits is an answer, asked again at the usual cadence.
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

/** How long one whole read (handshake and request) may take before it is killed. */
export const READ_TIMEOUT_MS = 30_000;

/** `promise`, failing if it is not settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(
				new Error(`${what} was not answered within ${String(ms / 1000)} s`),
			);
		}, ms);
		promise.then(
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
	/** The root surface: a reader's failure, once per streak. */
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
 * Start a reader loop for each CLI with plan limits that has a profile; stop
 * them all with the answer. Everything a reader does — finding its command,
 * starting it, reading — happens after this returns.
 */
export function startUsageReaders(deps: UsageReadersDeps): { stop(): void } {
	const stopped = new AbortController();
	/** The processes alive now, at most one per CLI. */
	const live = new Set<UsageSource>();
	const wait = deps.wait ?? waitFor;
	for (const cli of LIMITED_CLIS) {
		const profile = deps.profiles.find((one) => one.kind === cli);
		if (profile === undefined) continue;
		let program: string | undefined;
		// A command not on this Mac is a note, and nothing is read until DevHub
		// starts again.
		const resolve = async (): Promise<string | undefined> => {
			const resolved = await deps.runtime.resolveProgram(
				profile.command,
				deps.searchPath,
			);
			if (resolved.kind === "unavailable") {
				deps.note(cli, "cli_not_found");
				return undefined;
			}
			return resolved.value;
		};
		// One process for one reading, killed whatever comes of it.
		const readOnce = async (): Promise<UsageReading | undefined> => {
			program ??= await resolve();
			if (program === undefined) return undefined;
			const env = { ...(await deps.runtime.environment()), ...profile.env };
			const home = await deps.runtime.home();
			if (stopped.signal.aborted) return undefined;
			const child = deps.spawn(usageCommand(cli, program, env), home);
			const source =
				cli === "claude"
					? new ClaudeUsageSource(child)
					: new CodexUsageSource(child, deps.clientVersion);
			live.add(source);
			try {
				return await within(
					(async () => {
						await source.open();
						return await source.read();
					})(),
					READ_TIMEOUT_MS,
					"the usage read",
				);
			} finally {
				live.delete(source);
				source.close();
			}
		};
		const loop = async (): Promise<void> => {
			let last: UsageReading | undefined;
			// Whether this streak of failures was said.
			let said = false;
			while (!stopped.signal.aborted) {
				try {
					const reading = await readOnce();
					if (stopped.signal.aborted || program === undefined) return;
					// No reading this time (limits not fetched): nothing delivered.
					if (reading !== undefined) {
						last = reading;
						said = false;
						deps.deliver(cli, reading);
					}
				} catch (failure) {
					if (stopped.signal.aborted) return;
					if (!said) {
						said = true;
						deps.report(usageUnreadable(cli, profile.display_name, failure));
					}
				}
				// A failure is asked again at the same cadence, not later.
				await wait(
					last === undefined ? USUAL_INTERVAL_MS : pollInterval(cli, last),
					stopped.signal,
				);
			}
		};
		void loop();
	}
	return {
		stop() {
			stopped.abort();
			for (const source of live) source.close();
		},
	};
}
