/**
 * One GUI Agent's conversation, as main holds it.
 *
 * It owns three things and nothing else: the protocol adapter, the true
 * `Transcript` (every event the adapter produced, folded with the same
 * `applyEvent` the page uses), and the loop that feeds the adapter from the
 * host. The reconcile round reads it, the page subscribes to it, and commands
 * go through it to the host.
 *
 * # One order, live or replayed
 *
 * The adapter sees two kinds of line: what the CLI printed (the journal) and
 * what DevHub wrote (`in.log`). A transcript is only reproducible if the two
 * reach the adapter in the same order every time, so every adapter call goes
 * through one turnstile, and every write records the journal offset the
 * conversation had consumed when it was made. Attaching — the first time or
 * after a restart of DevHub — reads the journal from 0 and feeds each written
 * line back at the offset it was written after. That is the same sequence of
 * calls the live conversation made, so it folds to the same transcript.
 *
 * The CLI is greeted (the adapter's `opening`) exactly when nothing has ever
 * been written to it, which is a fact `in.log` states: a restart finds the
 * greeting there and does not greet again. The same fact settles the replies
 * a protocol demands of a line (Codex's handshake is made of them): a line
 * the last write came after was answered when it was read, so replaying it
 * writes nothing, and a line past that — printed while no DevHub was
 * following — is answered now.
 *
 * # Failure, at the one root
 *
 * The loop is the root the design names (§6.2), and it tells two families
 * apart:
 *
 * - The link to the host failed (`HostLinkFailure`). The conversation is
 *   intact in the host, so this is recoverable: the reading carries it as
 *   `lost` for the round to show, and `reattach` — once a round — follows the
 *   journal again from where it stopped, with the same adapter.
 * - The adapter could not read a line (`ProtocolMismatch`, or a
 *   `TranscriptInvariantError` from its own fold). That is version skew and
 *   nothing retries it: the conversation turns `broken` and takes no input.
 *
 * Anything else is a broken assumption of DevHub's own — a host that could
 * not even be opened, a bug — and it is not turned into either. It stops the
 * conversation for good, goes to the log with its stack, and is read as this
 * Agent's failure (`crashed`): on its pane and its row, where its subject is.
 * It is not thrown at the round, which would fail every Agent on the machine
 * and show on none of them — the spinner that never ends.
 *
 * # Rewinding
 *
 * `rewind` takes the conversation back to before one of the person's
 * messages: the adapter's plan is carried out (lines written, or the CLI
 * started again by its host), and the adapter reports the turn `rewinding`
 * until the CLI has done it. Nothing else may be written meanwhile. The
 * rewind itself is in the journal (a request and its answer, or the host's
 * mark between two CLIs), so a replay rebuilds the rewound transcript like
 * everything else.
 *
 * # The person's messages, held
 *
 * The person's words (`submit`) are written at once when the Agent is idle.
 * Otherwise — a turn running, a request open, the CLI still connecting or
 * being started again — DevHub holds them (`Transcript.pending`), and the
 * person can change them, take them back, or have one written at once
 * (`sendPendingNow`), which a running turn takes in as it goes. Each time the
 * Agent becomes idle, the oldest held message is written and starts the next
 * turn. A held message is DevHub's alone, not in the journal: it is lost if
 * DevHub quits before writing it. A write of one that fails leaves it held,
 * saying why, until the person tries again.
 */

import {
	EMPTY_TRANSCRIPT,
	TranscriptInvariantError,
	applyEvent,
	pendingId,
	rewindTargets,
	type ConversationEvent,
	type EntryId,
	type PendingId,
	type PendingMessage,
	type RewindOutcome,
	type Transcript,
} from "../../../model/conversation.js";
import { CancellationToken } from "../../terminal/ports.js";
import {
	HostLinkFailure,
	type JournalLine,
	type SentRecord,
} from "./hostLink.js";
import {
	ProtocolMismatch,
	type AdapterStep,
	type ConversationCommand,
	type ProtocolAdapter,
	type RewindPlan,
	type SettingName,
} from "./protocolAdapter.js";

/** What a conversation needs of its host. `HostLink` is the real one. */
export interface ConversationHost {
	lines(
		fromOffset: number,
		cancel: CancellationToken,
	): AsyncIterable<JournalLine>;
	write(line: string, afterOffset: number): Promise<void>;
	/** Have the host start the CLI again with `args` added, the lines of `mark` in the journal between the two. */
	restart(args: readonly string[], mark: readonly string[]): Promise<void>;
	sentLog(): Promise<readonly SentRecord[]>;
}

/**
 * A host that is opened by the first call that needs it.
 *
 * Opening one asks the machine where its home is, which can fail; done here,
 * inside the conversation's own calls, the failure reaches the conversation's
 * root like every other, instead of whoever asked for the conversation.
 */
export function openedLater(
	open: () => Promise<ConversationHost>,
): ConversationHost {
	let opening: Promise<ConversationHost> | undefined;
	const host = () => (opening ??= open());
	return {
		async *lines(fromOffset, cancel) {
			yield* (await host()).lines(fromOffset, cancel);
		},
		write: async (line, afterOffset) => (await host()).write(line, afterOffset),
		restart: async (args, mark) => (await host()).restart(args, mark),
		sentLog: async () => (await host()).sentLog(),
	};
}

export interface ConversationReading {
	readonly transcript: Transcript;
	/** Why the journal is not being followed now, if it is not. */
	readonly lost: HostLinkFailure | undefined;
	/** What stopped the conversation for good, if something DevHub did not expect did. */
	readonly crashed: Error | undefined;
}

/** An event as the page receives it: numbered, so a gap is visible. */
export type ConversationPublish = (
	revision: number,
	event: ConversationEvent,
) => void;

/** An edit waiting for its rewind to be over. */
interface PendingRewind {
	/** The turn has been `rewinding` since the plan was carried out. */
	begun: boolean;
	readonly done: () => void;
	readonly failed: (error: Error) => void;
}

export class AgentConversation {
	readonly #host: ConversationHost;
	readonly #adapter: ProtocolAdapter;
	readonly #publish: ConversationPublish;

	#transcript: Transcript = EMPTY_TRANSCRIPT;
	#revision = 0;
	/** The journal, consumed up to here. */
	#offset = 0;
	/** Lines of `in.log` not yet fed back, in order. */
	#replay: SentRecord[] = [];
	/**
	 * How far into the journal an earlier DevHub had read when it last wrote.
	 * It answered every line up to here already, so a reply a replayed line
	 * demands again is not written again. -1 is "it never wrote".
	 */
	#answeredUpTo = -1;
	#turnstile: Promise<unknown> = Promise.resolve();

	#cancel = new CancellationToken();
	#following: Promise<void> | undefined;
	#attached = false;
	#lost: HostLinkFailure | undefined;
	#crashed: Error | undefined;
	#rewind: PendingRewind | undefined;
	/** Whether the Agent was idle after the last event: becoming idle writes a held message. */
	#idle = false;
	#heldCount = 0;

	constructor(
		host: ConversationHost,
		adapter: ProtocolAdapter,
		publish: ConversationPublish,
	) {
		this.#host = host;
		this.#adapter = adapter;
		this.#publish = publish;
	}

	/** Start following the host. Once; `reattach` is how it starts again. */
	start(): void {
		if (this.#following !== undefined)
			throw new Error("this conversation has already started");
		this.#following = this.#follow();
	}

	/**
	 * Follow the journal again after the link was lost, from where it stopped.
	 * The round calls it once per round; a conversation that is not lost is
	 * left alone.
	 */
	reattach(): void {
		if (this.#lost === undefined || this.#cancel.isCancelled) return;
		this.#lost = undefined;
		this.#following = this.#follow();
	}

	reading(): ConversationReading {
		return {
			transcript: this.#transcript,
			lost: this.#lost,
			crashed: this.#crashed,
		};
	}

	/** The page's starting point: everything up to `revision`; events after it follow. */
	snapshot(): { readonly transcript: Transcript; readonly revision: number } {
		return { transcript: this.#transcript, revision: this.#revision };
	}

	/**
	 * Carry out one command: its lines written to the host, then taken back as
	 * sent. Rejects if it could not be — a write that failed leaves no trace.
	 */
	command(command: ConversationCommand): Promise<void> {
		return this.#serial(async () => {
			this.#refuseIfBusy();
			await this.#write(this.#adapter.encode(command));
		});
	}

	/**
	 * Take the conversation back to before `message`, one of `rewindTargets`:
	 * that message and everything after it go. Refused, with the reason, when
	 * it cannot be rewound to now; `refused` when the CLI would not (the
	 * conversation says why, and nothing was dropped); rejects when the plan
	 * could not be carried out or the conversation stopped first.
	 */
	async rewind(message: EntryId): Promise<RewindOutcome> {
		const rewound = await this.#serial(async () => {
			this.#refuseIfBusy();
			this.#refuseRewind(message);
			return this.#carryOut(this.#adapter.rewind(message));
		});
		await rewound.over;
		return this.#transcript.entries.some((entry) => entry.id === message)
			? "refused"
			: "rewound";
	}

	/**
	 * The person's words to the Agent: written at once when it is idle and
	 * holds nothing of theirs, else held until it is (see the module's doc).
	 */
	submit(text: string): Promise<void> {
		return this.#serial(async () => {
			this.#refuseIfBroken();
			if (this.#idleNow() && this.#transcript.pending.length === 0) {
				await this.#write(
					this.#adapter.encode({ kind: "send", text, origin: "person" }),
				);
				return;
			}
			this.#heldCount += 1;
			this.#setPending([
				...this.#transcript.pending,
				{ id: pendingId(`held:${this.#heldCount}`), text, failure: undefined },
			]);
		});
	}

	/** Change the words of a held message. */
	editPending(id: PendingId, text: string): Promise<void> {
		return this.#serial(async () => {
			this.#held(id);
			this.#setPending(
				this.#transcript.pending.map((each) =>
					each.id === id ? { ...each, text, failure: undefined } : each,
				),
			);
		});
	}

	/** Take a held message back: it is never written. */
	removePending(id: PendingId): Promise<void> {
		return this.#serial(async () => {
			this.#held(id);
			this.#setPending(
				this.#transcript.pending.filter((each) => each.id !== id),
			);
		});
	}

	/**
	 * Write a held message now, without waiting for the Agent to be idle: a
	 * running turn takes it in as it goes (the adapter's `send`). Refused
	 * while the CLI cannot take a message at all.
	 */
	sendPendingNow(id: PendingId): Promise<void> {
		return this.#serial(async () => {
			this.#refuseIfBusy();
			this.#held(id);
			const { state } = this.#transcript;
			if (state.phase !== "ready" || state.turn === "rewinding") {
				throw new Error(
					"The Agent cannot take a message yet. It is sent when the Agent is ready.",
				);
			}
			await this.#writeHeld(id);
		});
	}

	#held(id: PendingId): PendingMessage {
		const found = this.#transcript.pending.find((each) => each.id === id);
		if (found === undefined) {
			throw new Error(
				"That message is no longer waiting: it was sent or taken back.",
			);
		}
		return found;
	}

	/**
	 * Inside the turnstile only: write a held message and let it go, or keep
	 * it held with the reason its write failed, which it shows. That is the
	 * one place a held message's failure is reported.
	 */
	async #writeHeld(id: PendingId): Promise<void> {
		const { text } = this.#held(id);
		try {
			await this.#write(
				this.#adapter.encode({ kind: "send", text, origin: "person" }),
			);
		} catch (error: unknown) {
			if (!(error instanceof HostLinkFailure)) throw error;
			this.#setPending(
				this.#transcript.pending.map((each) =>
					each.id === id ? { ...each, failure: error.message } : each,
				),
			);
			return;
		}
		this.#setPending(this.#transcript.pending.filter((each) => each.id !== id));
	}

	#setPending(pending: readonly PendingMessage[]): void {
		this.#apply({ type: "pending", pending });
	}

	/** Nothing running, waiting or being taken back: a message written now starts a turn. */
	#idleNow(): boolean {
		const { state, requests } = this.#transcript;
		return (
			state.phase === "ready" &&
			state.turn === "none" &&
			requests.length === 0 &&
			this.#rewind === undefined
		);
	}

	/**
	 * The Agent became idle: the oldest held message is written, in the
	 * turnstile after whatever made it idle. A held message whose last write
	 * failed waits for the person.
	 */
	#writeNextHeld(): void {
		const next = this.#transcript.pending[0];
		if (next === undefined || next.failure !== undefined) return;
		void this.#serial(async () => {
			if (!this.#idleNow() || this.#transcript.pending[0]?.id !== next.id)
				return;
			await this.#writeHeld(next.id);
		}).catch((error: unknown) => this.#crash(error));
	}

	/**
	 * Go on with another session of the CLI, `session` (`/resume`), in place
	 * of this one: the adapter's plan is carried out as an edit's is, and this
	 * resolves once the CLI has the other session (the adapter emitted
	 * `session-switched` and the turn is no longer `rewinding`). `history` is
	 * that session's past, for a protocol whose CLI prints none of it. The
	 * switch is in the journal like a rewind, so a replay draws the same.
	 * Refused while a turn runs, a request is open or an edit is under way.
	 */
	async resumeSession(
		session: string,
		history: readonly string[],
	): Promise<void> {
		const resumed = await this.#serial(async () => {
			this.#refuseIfBusy();
			const { state, requests } = this.#transcript;
			if (
				state.phase !== "ready" ||
				state.turn !== "none" ||
				requests.length > 0
			) {
				throw new Error(
					"The Agent is in the middle of a turn. Stop it before going on with another session.",
				);
			}
			return this.#carryOut(this.#adapter.resumeSession(session, history));
		});
		try {
			await resumed.over;
		} catch (error: unknown) {
			throw new Error(
				`The conversation stopped before it went on with session ${session}: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}

	/**
	 * Inside the turnstile only: carry out the adapter's plan for a rewind or
	 * a `/resume` — its lines written, or the CLI started again — and hand
	 * back `over`, which settles when the adapter says the switch is done
	 * (`#rewind`). A plan that could not be carried out leaves nothing under
	 * way. Wrapped: returned bare, the turnstile would wait for `over`, and
	 * the lines that settle it could never be read.
	 */
	async #carryOut(plan: RewindPlan): Promise<{ readonly over: Promise<void> }> {
		const over = new Promise<void>((done, failed) => {
			this.#rewind = { begun: false, done, failed };
		});
		try {
			if (plan.kind === "write") await this.#write(plan.lines);
			else await this.#host.restart(plan.args, plan.mark);
		} catch (error: unknown) {
			this.#rewind = undefined;
			throw error;
		}
		return { over };
	}

	#refuseRewind(message: EntryId): void {
		if (rewindTargets(this.#transcript).has(message)) return;
		const { state, session, requests, pending } = this.#transcript;
		if (!session.canRewind) {
			throw new Error(
				"This Agent's CLI cannot take turns back, so the conversation cannot be rewound.",
			);
		}
		if (
			requests.length > 0 ||
			(state.phase === "ready" && state.turn !== "none")
		) {
			throw new Error(
				"The Agent is in the middle of a turn. Stop it before rewinding.",
			);
		}
		if (pending.length > 0) {
			throw new Error(
				"Messages of yours are waiting to be sent. Send or remove them before rewinding.",
			);
		}
		throw new Error(
			"The conversation cannot be rewound to before that message.",
		);
	}

	#refuseIfBusy(): void {
		this.#refuseIfBroken();
		if (this.#rewind !== undefined) {
			throw new Error(
				"The conversation is being taken back. Wait until that is done.",
			);
		}
	}

	#refuseIfBroken(): void {
		if (this.#crashed !== undefined) throw this.#crashed;
		const { state } = this.#transcript;
		if (state.phase === "broken") {
			throw new Error(
				`this conversation has stopped taking input: ${state.failure.detail}`,
			);
		}
	}

	/**
	 * Choose a setting. Whatever lines the protocol sets it with are written
	 * and taken back as sent, like a command's; a protocol that carries it on
	 * the next turn instead has already said so in the step's events.
	 */
	configure(which: SettingName, id: string): Promise<void> {
		return this.#serial(async () => {
			this.#refuseIfBusy();
			const step = this.#adapter.configure(which, id);
			this.#take(step);
			await this.#write(step.replies);
		});
	}

	/** Stop following. The host and its CLI are untouched. */
	async stop(): Promise<void> {
		this.#cancel.cancel();
		await this.#following;
	}

	async #follow(): Promise<void> {
		try {
			await this.#followJournal();
		} finally {
			// However following ended, an edit waiting on the CLI will not hear
			// from it now.
			const rewind = this.#rewind;
			this.#rewind = undefined;
			rewind?.failed(
				new Error(
					"The conversation stopped before the CLI had taken the turns back.",
				),
			);
		}
	}

	async #followJournal(): Promise<void> {
		try {
			// Queued before this method first awaits, so that no command can be
			// written between reading `in.log` and greeting: it would be in the
			// log and missing from the replay, or the other way round. It counts
			// as done only once it is: a greeting whose write failed is looked
			// for again, in `in.log`, by the next attach.
			if (!this.#attached) {
				await this.#serial(async () => {
					this.#replay = [...(await this.#host.sentLog())];
					this.#answeredUpTo = Math.max(
						-1,
						...this.#replay.map((each) => each.afterOffset),
					);
					if (this.#replay.length === 0)
						await this.#write(this.#adapter.opening());
					this.#feedSentUpTo(this.#offset);
					this.#attached = true;
				});
			}
			for await (const { line, offset } of this.#host.lines(
				this.#offset,
				this.#cancel,
			)) {
				const replies = await this.#serial(async () => {
					const step = this.#adapter.received(line);
					this.#take(step);
					this.#offset = offset;
					this.#feedSentUpTo(offset);
					// A line an earlier DevHub read had its replies written then;
					// they are in `in.log`, and fed back above as sent.
					return offset <= this.#answeredUpTo ? [] : step.replies;
				});
				if (replies.length > 0) await this.#serial(() => this.#write(replies));
			}
		} catch (error: unknown) {
			if (error instanceof HostLinkFailure) {
				this.#lost = error;
				return;
			}
			if (
				error instanceof ProtocolMismatch ||
				error instanceof TranscriptInvariantError
			) {
				this.#cancel.cancel();
				this.#apply({
					type: "state",
					state: {
						phase: "broken",
						failure: { code: "protocol_mismatch", detail: error.message },
					},
				});
				return;
			}
			this.#crash(error);
		}
	}

	/** A failure DevHub did not expect stops the conversation for good (see the module's doc). */
	#crash(error: unknown): void {
		this.#cancel.cancel();
		this.#crashed = error instanceof Error ? error : new Error(String(error));
		console.error(
			"[devhub] a GUI Agent's conversation stopped on a failure DevHub did not expect:",
			this.#crashed.stack ?? this.#crashed.message,
		);
	}

	/** Feed back what DevHub wrote after the journal reached `offset`. */
	#feedSentUpTo(offset: number): void {
		while (this.#replay.length > 0 && this.#replay[0]!.afterOffset <= offset) {
			this.#take(this.#adapter.sent(this.#replay.shift()!.line));
		}
	}

	/** Inside the turnstile only: write, then take each line back as sent. */
	async #write(lines: readonly string[]): Promise<void> {
		for (const line of lines) {
			await this.#host.write(line, this.#offset);
			this.#take(this.#adapter.sent(line));
		}
	}

	#take(step: AdapterStep): void {
		for (const event of step.events) this.#apply(event);
	}

	#apply(event: ConversationEvent): void {
		this.#transcript = applyEvent(this.#transcript, event);
		this.#revision += 1;
		this.#publish(this.#revision, event);
		this.#watchRewind();
		const idle = this.#idleNow();
		if (idle && !this.#idle) this.#writeNextHeld();
		this.#idle = idle;
	}

	/** An edit's rewind is over once the turn has been `rewinding` and is not any more. */
	#watchRewind(): void {
		const rewind = this.#rewind;
		if (rewind === undefined) return;
		const { state } = this.#transcript;
		const rewinding = state.phase === "ready" && state.turn === "rewinding";
		if (rewinding) {
			rewind.begun = true;
			return;
		}
		if (!rewind.begun) return;
		this.#rewind = undefined;
		if (state.phase === "broken") {
			rewind.failed(
				new Error(
					`The conversation stopped before the CLI had taken the turns back: ${state.failure.detail}`,
				),
			);
			return;
		}
		rewind.done();
	}

	/** Runs `work` after everything already queued, and before anything queued later. */
	#serial<T>(work: () => Promise<T>): Promise<T> {
		const next = this.#turnstile.then(work);
		this.#turnstile = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}
