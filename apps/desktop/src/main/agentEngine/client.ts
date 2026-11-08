/**
 * Main's side of the conversation engine (`engine.ts`): the utility process,
 * the proxies main holds for its conversations, and what the engine asks of
 * main.
 *
 * Each proxy is a `ConversationHandle`. Its `facts()` are what the engine last
 * pushed; its calls are messages, answered by the engine; its `snapshot()` is
 * a request. Pages attach to the engine over a `MessagePort` this hands out
 * (`pagePort`), so a conversation's events never pass main. For an Agent on
 * another machine the engine follows the journal itself, and main brokers
 * what needs the machine: a stream its runtime starts (in the process host)
 * with its bytes sent to the engine on a port of their own, how that stream
 * ended, and a command.
 *
 * **When the engine is gone.** An engine that exits fails the calls it held
 * (`ConversationStopped`), and every conversation reads as one nobody follows
 * (status unknown, the reason said) until a new engine, started at once,
 * has been told to open each again; it replays them from their journals,
 * which are on disk. The pages are told to attach again (`onRestarted`). An
 * engine that keeps dying is given up on, as the process host is: after
 * `MAX_RESTARTS` exits within a minute the conversations run in main from
 * then on (`onGaveUp`), and that is said once.
 */

import { join } from "node:path";
import type { AgentId } from "../../model/domain.js";
import { EMPTY_TRANSCRIPT, type Usage } from "../../model/conversation.js";
import { electron } from "../electron.js";
import { APP_ROOT } from "../shell/appRoot.js";
import type {
	ConversationFacts,
	ConversationHost,
} from "../agent/conversation/conversation.js";
import { ConversationStopped } from "../agent/conversation/failures.js";
import type {
	ConversationHandle,
	ConversationSnapshot,
} from "../agent/conversation/handle.js";
import type { LimitResumeRecord } from "../agent/conversation/limitResume.js";
import { observeConversation } from "../agent/conversation/reading.js";
import type { HostRuntime } from "../agent/conversation/hostLink.js";
import { OperationDeadline } from "../terminal/command.js";
import { CancellationToken } from "../terminal/ports.js";
import type { StreamSink } from "../terminal/streamRun.js";
import {
	errorFromWire,
	errorToWire,
	type CallMethod,
	type EngineQuestion,
	type EngineSettings,
	type ExecAnswer,
	type FromEngine,
	type HostMethod,
	type JournalPlace,
	type OpenSpec,
	type PreparedHost,
	type ToEngine,
} from "./protocol.js";

export const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

/** A port's end that is handed to the engine; Electron's `MessagePortMain` in DevHub. */
export type TransferablePort = object;

/** What the client needs of a utility process; Electron's, in DevHub. */
export interface EngineProcess {
	postMessage(message: ToEngine, transfer?: TransferablePort[]): void;
	onMessage(listener: (message: FromEngine) => void): void;
	onExit(listener: (code: number) => void): void;
	kill(): void;
}

export type EngineLauncher = () => EngineProcess;

/** The engine's entry, from the app's root, as the process host's is (`processHost/client.ts`). */
export const ENGINE_ENTRY = join(
	APP_ROOT,
	"out",
	"main",
	"agentEngine",
	"entry.js",
);

/** The conversation engine as an Electron utility process. */
export function electronEngineLauncher(): EngineProcess {
	const child = electron.utilityProcess.fork(ENGINE_ENTRY, [], {
		serviceName: "DevHub Conversation Engine",
		// Main's environment as it is now, after the login environment's
		// import: what the hosts' commands run in (`LocalRuntime.environment`).
		env: { ...process.env },
	});
	return {
		postMessage: (message, transfer) =>
			child.postMessage(
				message,
				transfer as Electron.MessagePortMain[] | undefined,
			),
		onMessage: (listener) =>
			child.on("message", (message: unknown) =>
				listener(message as FromEngine),
			),
		onExit: (listener) => child.on("exit", listener),
		kill: () => {
			child.kill();
		},
	};
}

/** What main answers for one conversation when the engine asks. */
export interface ConversationServices {
	/** Where the host of an Agent on this machine is, and what its CLI is. */
	prepareHost(): Promise<PreparedHost>;
	/** The host of an Agent on another machine, which main reaches. */
	host(): ConversationHost;
	/** That host's machine and state directory: what its journal is followed on. */
	journal(): Promise<{
		readonly runtime: HostRuntime;
		readonly directory: string;
	}>;
	/** The Agent's usage-limit record now, for a conversation opened (again). */
	record(): LimitResumeRecord | undefined;
	setRecord(record: LimitResumeRecord): void;
	/** Codex's developer instructions now. */
	instructions(): string | undefined;
}

export interface EngineClientOptions {
	readonly launch: EngineLauncher;
	readonly settings: () => EngineSettings;
	readonly log?: (line: string) => void;
	readonly now?: () => number;
	/** A new port pair for a stream: Electron's `MessageChannelMain`; tests pass their own. */
	readonly channel?: () => StreamChannel;
}

/** A stream's port pair: the sink end goes to the stream's process, the other to the engine. */
export interface StreamChannel {
	readonly port1: StreamSink & TransferablePort;
	readonly port2: TransferablePort;
}

/** A command overflowed a cap under `overflow: "fail"`, which the engine words. */
class Overflowed extends Error {}

interface Proxy {
	readonly agentId: AgentId;
	readonly spec: Omit<OpenSpec, "record" | "instructions">;
	readonly services: ConversationServices;
	facts: ConversationFacts;
	instructions: string | undefined;
	host: ConversationHost | undefined;
}

/** What a conversation reads as before the engine has said anything of it. */
const FIRST_FACTS: ConversationFacts = {
	observation: observeConversation({
		transcript: EMPTY_TRANSCRIPT,
		lost: undefined,
		crashed: undefined,
	}),
	sessionId: undefined,
	mcpServers: undefined,
};

function engineGone(facts: ConversationFacts, why: string): ConversationFacts {
	return {
		...facts,
		observation: {
			status: "unknown",
			activity: undefined,
			failure: { code: "conversation_host_lost", detail: why },
		},
	};
}

export class EngineClient {
	readonly #options: EngineClientOptions;
	#engine: EngineProcess | undefined;
	#disposed = false;
	#gaveUp = false;
	readonly #exits: number[] = [];
	/** Bumped for each engine started: a page's port is for one of them. */
	#generation = 0;
	readonly #proxies = new Map<AgentId, Proxy>();
	readonly #pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	readonly #streams = new Map<number, CancellationToken>();
	readonly #restarted = new Set<() => void>();
	readonly #gaveUpListeners = new Set<() => void>();
	#nextCall = 1;
	#nextPage = 1;

	constructor(options: EngineClientOptions) {
		this.#options = options;
	}

	/** Whether conversations can be opened in the engine; false once it was given up on. */
	get available(): boolean {
		return !this.#disposed && !this.#gaveUp;
	}

	/** The engine of the moment, for a page's port: the same number until it is replaced. */
	get generation(): number {
		return this.#generation;
	}

	/** A new engine took over from one that ended: pages attach again. */
	onRestarted(listener: () => void): () => void {
		this.#restarted.add(listener);
		return () => this.#restarted.delete(listener);
	}

	/** The engine was given up on: conversations run in main from now on. */
	onGaveUp(listener: () => void): () => void {
		this.#gaveUpListeners.add(listener);
		return () => this.#gaveUpListeners.delete(listener);
	}

	/** `[agents]` changed: every conversation runs on the new settings. */
	settingsChanged(): void {
		this.#engine?.postMessage({
			type: "settings",
			settings: this.#options.settings(),
		});
	}

	/** Hand the engine one end of a page's port; the page gets the other. Returns the page's number. */
	attachPage(port: TransferablePort): number {
		const page = this.#nextPage++;
		this.#now().postMessage({ type: "page", page }, [port]);
		return page;
	}

	pageGone(page: number): void {
		this.#engine?.postMessage({ type: "page-gone", page });
	}

	/** Codex's developer instructions for an Agent may have changed: told to its adapter if they did. */
	instructionsChanged(agentId: AgentId): void {
		const proxy = this.#proxies.get(agentId);
		if (proxy === undefined) return;
		const text = proxy.services.instructions();
		if (text === proxy.instructions) return;
		proxy.instructions = text;
		this.#engine?.postMessage({ type: "instructions", agentId, text });
	}

	open(
		agentId: AgentId,
		spec: Omit<OpenSpec, "record" | "instructions">,
		services: ConversationServices,
	): ConversationHandle {
		if (this.#proxies.has(agentId))
			throw new Error(`the conversation of Agent ${agentId} is open already`);
		const proxy: Proxy = {
			agentId,
			spec,
			services,
			facts: FIRST_FACTS,
			instructions: services.instructions(),
			host: undefined,
		};
		const call = <T>(method: CallMethod, ...args: unknown[]): Promise<T> =>
			this.#call(agentId, method, args) as Promise<T>;
		let started = false;
		return {
			pagePort: true,
			start: () => {
				if (started) throw new Error("this conversation has already started");
				started = true;
				this.#proxies.set(agentId, proxy);
				this.#openIn(this.#now(), proxy);
			},
			facts: () => proxy.facts,
			reattach: () => {
				void call("reattach").catch(() => undefined);
			},
			snapshot: () => call<ConversationSnapshot>("snapshot"),
			command: (command) => call("command", command),
			rewind: (message) => call("rewind", message),
			submit: (text, images) => call("submit", text, images),
			startEditingPending: (id) => call("startEditingPending", id),
			editPending: (id, text) => call("editPending", id, text),
			stopEditingPending: (id) => call("stopEditingPending", id),
			stopEditingAll: () => {
				void call("stopEditingAll").catch(() => undefined);
			},
			removePending: (id) => call("removePending", id),
			sendPendingNow: (id) => call("sendPendingNow", id),
			showSignIn: (signIn) => call("showSignIn", signIn),
			cancelLimitResume: () => call("cancelLimitResume"),
			reconsiderCacheKeeping: () => {
				void call("reconsiderCacheKeeping").catch(() => undefined);
			},
			resumeSession: (session, history) =>
				call("resumeSession", session, history),
			restart: () => call("restart"),
			configure: (which, id) => call("configure", which, id),
			stop: async () => {
				if (this.#proxies.get(agentId) !== proxy) return;
				this.#proxies.delete(agentId);
				if (this.#engine === undefined) return;
				await call("stop").catch(() => undefined);
			},
		};
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const engine = this.#engine;
		this.#engine = undefined;
		this.#failAll("DevHub is quitting");
		engine?.kill();
	}

	#call(
		agentId: AgentId,
		method: CallMethod,
		args: unknown[],
	): Promise<unknown> {
		if (this.#gaveUp || this.#disposed) {
			return Promise.reject(
				new ConversationStopped("DevHub's conversation engine is not running."),
			);
		}
		const id = this.#nextCall++;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#now().postMessage({ type: "call", id, agentId, method, args });
		});
	}

	#openIn(engine: EngineProcess, proxy: Proxy): void {
		proxy.instructions = proxy.services.instructions();
		engine.postMessage({
			type: "open",
			agentId: proxy.agentId,
			spec: {
				...proxy.spec,
				record: proxy.services.record(),
				instructions: proxy.instructions,
			},
		});
	}

	#failAll(why: string): void {
		const held = [...this.#pending.values()];
		this.#pending.clear();
		for (const call of held) call.reject(new ConversationStopped(why));
		for (const token of this.#streams.values()) token.cancel();
		this.#streams.clear();
		for (const proxy of this.#proxies.values())
			proxy.facts = engineGone(proxy.facts, why);
	}

	/** The engine running now, started if there is none. */
	#now(): EngineProcess {
		if (this.#engine !== undefined) return this.#engine;
		const engine = this.#options.launch();
		this.#engine = engine;
		this.#generation += 1;
		engine.onMessage((message) => {
			if (engine === this.#engine) this.#fromEngine(engine, message);
		});
		engine.onExit((code) => {
			if (engine === this.#engine) this.#exited(code);
		});
		engine.postMessage({
			type: "settings",
			settings: this.#options.settings(),
		});
		for (const proxy of this.#proxies.values()) this.#openIn(engine, proxy);
		return engine;
	}

	#exited(code: number): void {
		this.#engine = undefined;
		const why = `DevHub's conversation engine stopped (exit code ${String(code)}); it is being started again.`;
		this.#failAll(why);
		if (this.#disposed) return;
		const log = this.#options.log ?? ((line) => console.warn(line));
		const at = (this.#options.now ?? Date.now)();
		this.#exits.push(at);
		while (
			this.#exits.length > 0 &&
			at - (this.#exits[0] ?? at) > RESTART_WINDOW_MS
		) {
			this.#exits.shift();
		}
		if (this.#exits.length >= MAX_RESTARTS) {
			this.#gaveUp = true;
			log(
				`[devhub] the conversation engine ended ${String(this.#exits.length)} times in a minute; GUI Agents' conversations run in main from now on`,
			);
			for (const proxy of this.#proxies.values()) proxy.host = undefined;
			this.#proxies.clear();
			for (const listener of this.#gaveUpListeners) listener();
			return;
		}
		log(
			`[devhub] the conversation engine ended with exit code ${String(code)}; starting it again`,
		);
		if (this.#proxies.size > 0) this.#now();
		for (const listener of this.#restarted) listener();
	}

	#fromEngine(engine: EngineProcess, message: FromEngine): void {
		switch (message.type) {
			case "facts": {
				const proxy = this.#proxies.get(message.agentId);
				if (proxy !== undefined) proxy.facts = message.facts;
				return;
			}
			case "usage":
				for (const listener of this.#usage)
					listener(message.agentId, message.usage);
				return;
			case "result": {
				const call = this.#pending.get(message.id);
				if (call === undefined) return;
				this.#pending.delete(message.id);
				if (message.ok) call.resolve(message.value);
				else call.reject(errorFromWire(message.error));
				return;
			}
			case "record":
				this.#proxies.get(message.agentId)?.services.setRecord(message.record);
				return;
			case "ask":
				void this.#answer(engine, message);
				return;
			case "stream-open":
				void this.#stream(engine, message);
				return;
			case "stream-cancel":
				this.#streams.get(message.stream)?.cancel();
				return;
		}
	}

	readonly #usage = new Set<(agentId: AgentId, usage: Usage) => void>();

	/** Each conversation's usage, as the engine reports it. */
	onUsage(listener: (agentId: AgentId, usage: Usage) => void): () => void {
		this.#usage.add(listener);
		return () => this.#usage.delete(listener);
	}

	#hostOf(proxy: Proxy): ConversationHost {
		return (proxy.host ??= proxy.services.host());
	}

	async #answer(
		engine: EngineProcess,
		message: Extract<FromEngine, { type: "ask" }>,
	): Promise<void> {
		const reply = (answer: ToEngine) => {
			if (engine === this.#engine) engine.postMessage(answer);
		};
		try {
			const proxy = this.#proxies.get(message.agentId);
			if (proxy === undefined)
				throw new Error(
					`the conversation of Agent ${message.agentId} is not open`,
				);
			const { question } = message;
			let value: unknown;
			if (question.kind === "prepare-host") {
				const prepared = await proxy.services.prepareHost();
				proxy.instructions = prepared.instructions;
				value = prepared;
			} else if (question.kind === "journal") {
				const { runtime, directory } = await proxy.services.journal();
				value = { directory, where: runtime.where } satisfies JournalPlace;
			} else if (question.kind === "exec") {
				value = await execFor(
					(await proxy.services.journal()).runtime,
					question,
				);
			} else {
				value = await hostCall(
					this.#hostOf(proxy),
					question.method,
					question.args,
				);
			}
			reply({ type: "answer", id: message.id, ok: true, value });
		} catch (error: unknown) {
			reply({
				type: "answer",
				id: message.id,
				ok: false,
				error: errorToWire(error),
			});
		}
	}

	/**
	 * Start a stream on an Agent's machine for the engine: main's runtime
	 * composes and starts it, its bytes go to the engine on a port of their
	 * own, and main tells the engine how it ended.
	 */
	async #stream(
		engine: EngineProcess,
		message: Extract<FromEngine, { type: "stream-open" }>,
	): Promise<void> {
		const { stream } = message;
		const token = new CancellationToken();
		this.#streams.set(stream, token);
		const send = (answer: ToEngine) => {
			if (engine === this.#engine) engine.postMessage(answer);
		};
		try {
			const proxy = this.#proxies.get(message.agentId);
			if (proxy === undefined)
				throw new Error(
					`the conversation of Agent ${message.agentId} is not open`,
				);
			const { runtime } = await proxy.services.journal();
			const { port1, port2 } = (
				this.#options.channel ?? electronStreamChannel
			)();
			engine.postMessage({ type: "stream-port", stream }, [port2]);
			const running = runtime.spawnStream({
				argv: message.argv,
				...(message.cwd === undefined ? {} : { cwd: message.cwd }),
				...(message.env === undefined ? {} : { env: message.env }),
				cancel: token,
				to: port1,
			});
			const end = await running.ended;
			send({
				type: "stream-end",
				stream,
				end: {
					code: end.code,
					signal: end.signal,
					stderr: new Uint8Array(end.stderr),
				},
				error: undefined,
			});
		} catch (error: unknown) {
			send({
				type: "stream-end",
				stream,
				end: undefined,
				error: errorToWire(error),
			});
		} finally {
			this.#streams.delete(stream);
		}
	}
}

function electronStreamChannel(): StreamChannel {
	return new electron.MessageChannelMain();
}

/** A command on an Agent's machine, for the engine, answered as data. */
async function execFor(
	runtime: HostRuntime,
	question: Extract<EngineQuestion, { kind: "exec" }>,
): Promise<ExecAnswer> {
	try {
		const result = await runtime.exec({
			argv: question.argv,
			...(question.cwd === undefined ? {} : { cwd: question.cwd }),
			...(question.env === undefined ? {} : { env: question.env }),
			...(question.stdin === undefined ? {} : { stdin: question.stdin }),
			deadline: OperationDeadline.in(question.timeoutMs),
			cancel: new CancellationToken(),
			limits: {
				stdoutBytes: question.stdoutBytes,
				stderrBytes: question.stderrBytes,
				overflow:
					question.overflow === "fail"
						? { kind: "fail", failure: () => new Overflowed() }
						: { kind: "truncate" },
			},
		});
		return {
			kind: "result",
			code: result.code,
			signal: result.signal,
			stdout: new Uint8Array(result.stdout),
			stderr: new Uint8Array(result.stderr),
		};
	} catch (failure: unknown) {
		if (failure instanceof Overflowed) return { kind: "overflow" };
		throw failure;
	}
}

function hostCall(
	host: ConversationHost,
	method: HostMethod,
	args: readonly unknown[],
): Promise<unknown> {
	switch (method) {
		case "write":
			return host.write(args[0] as string, args[1] as number);
		case "restart":
			return host.restart(
				args[0] as readonly string[],
				args[1] as readonly string[],
			);
		case "sleep":
			return host.sleep(args[0] as readonly string[]);
		case "sentLog":
			return host.sentLog();
		case "journalSize":
			return host.journalSize?.() ?? Promise.resolve(0);
	}
}
