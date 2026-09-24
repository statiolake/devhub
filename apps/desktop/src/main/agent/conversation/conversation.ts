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
 */

import {
	EMPTY_TRANSCRIPT,
	TranscriptInvariantError,
	applyEvent,
	type ConversationEvent,
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
	type SettingName,
} from "./protocolAdapter.js";

/** What a conversation needs of its host. `HostLink` is the real one. */
export interface ConversationHost {
	lines(
		fromOffset: number,
		cancel: CancellationToken,
	): AsyncIterable<JournalLine>;
	write(line: string, afterOffset: number): Promise<void>;
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
			this.#refuseIfBroken();
			await this.#write(this.#adapter.encode(command));
		});
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
			this.#refuseIfBroken();
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
			this.#cancel.cancel();
			this.#crashed = error instanceof Error ? error : new Error(String(error));
			console.error(
				"[devhub] a GUI Agent's conversation stopped on a failure DevHub did not expect:",
				this.#crashed.stack ?? this.#crashed.message,
			);
		}
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
