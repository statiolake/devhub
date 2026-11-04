/**
 * Events for the orchestrator: the seam everything that wants the
 * orchestrator to act goes through.
 *
 * A source (the board, and later GitHub, pull requests, timers) calls
 * `dispatch` with an `OrchestratorEvent`. The dispatcher words it
 * (`describeEvent`), renders `[orchestrator] event_prompt` around it
 * (`{EVENT}`), and hands the text to `deliver`, which queues it for the
 * orchestrator agent as an ordinary message from the person: held while the
 * agent is mid-turn and written once its turn ends, the same queue
 * `devhub --tell agent send` uses (`main/agent/injection.ts`). So the
 * orchestrator is told one thing at a time, in order, whatever it is doing.
 *
 * **Paused** holds every event here instead, in order, and `resume` delivers
 * them all. Nothing is dropped while paused; with no orchestrator assigned
 * there is nobody to tell, and an event is dropped (and said in the log),
 * because the next start's `init` tells it to read the board anyway.
 *
 * Adding an event is three lines: a variant here, its words in
 * `describeEvent`, and a `dispatch` where it happens. See
 * `docs/orchestrator.md`, "Events".
 */

import {
	EVENT_PLACEHOLDER,
	renderEventPrompt,
} from "../../model/orchestratorSettings.js";

export type OrchestratorEvent =
	/** The orchestrator has just been started (or restarted). */
	| { readonly kind: "init" }
	/** The person answered an escalation: it is `in_progress` now. */
	| {
			readonly kind: "escalation_answered";
			readonly escalationId: number;
			readonly title: string;
			readonly agents: readonly string[];
	  }
	/** An agent appeared in 不明: idle, with no open escalation naming it. */
	| {
			readonly kind: "unaccounted";
			readonly agentId: string;
			readonly name: string;
			readonly workspace: string;
			readonly idleSince: number;
	  };

export type OrchestratorEventKind = OrchestratorEvent["kind"];

/** What `{EVENT}` becomes: the kind, what it is about, and where to look. */
export function describeEvent(event: OrchestratorEvent): string {
	switch (event.kind) {
		case "init":
			return [
				"[event: init] The orchestrator has started.",
				"Board: devhub --tell board",
			].join("\n");
		case "escalation_answered":
			return [
				`[event: escalation_answered] #${String(event.escalationId)} 「${event.title}」 was answered by the person (now in progress).`,
				`Read it: devhub --tell escalation show ${String(event.escalationId)}`,
				...(event.agents.length === 0
					? []
					: [`Agents: ${event.agents.join(", ")}`]),
			].join("\n");
		case "unaccounted":
			return [
				`[event: unaccounted] ${event.name} (${event.agentId}) in ${event.workspace} has been idle since ${new Date(event.idleSince).toISOString()} with no open escalation about it.`,
				"Give it its next task, or raise an escalation: devhub --tell board",
			].join("\n");
	}
}

export interface EventDelivery {
	/** The agent to tell, while one is assigned. */
	readonly orchestrator: () => string | undefined;
	/** `[orchestrator]` as DevHub runs on it now. */
	readonly prompts: () => {
		readonly event_prompt: string;
		readonly init_prompt: string | undefined;
	};
	/** Queue `text` for `agentId` as the person's message (held mid-turn). */
	readonly deliver: (agentId: string, text: string) => void;
	/** The pause, or what is held, changed. */
	readonly changed?: () => void;
	readonly log?: (line: string) => void;
}

/** The message `event` is sent as, by the settings `prompts` names. */
export function eventMessage(
	event: OrchestratorEvent,
	prompts: {
		readonly event_prompt: string;
		readonly init_prompt: string | undefined;
	},
): string {
	if (event.kind === "init" && prompts.init_prompt !== undefined)
		return renderEventPrompt(prompts.init_prompt, describeEvent(event));
	return renderEventPrompt(prompts.event_prompt, describeEvent(event));
}

export { EVENT_PLACEHOLDER };

export class EventDispatcher {
	#paused = false;
	readonly #held: OrchestratorEvent[] = [];

	constructor(private readonly delivery: EventDelivery) {}

	get paused(): boolean {
		return this.#paused;
	}

	/** What is held while paused, oldest first. */
	held(): readonly OrchestratorEvent[] {
		return [...this.#held];
	}

	dispatch(event: OrchestratorEvent): void {
		if (this.#paused) {
			this.#held.push(event);
			this.delivery.changed?.();
			return;
		}
		this.#send(event);
	}

	pause(): void {
		if (this.#paused) return;
		this.#paused = true;
		this.delivery.changed?.();
	}

	/** Deliver everything held, in order, and stop holding. */
	resume(): number {
		if (!this.#paused) return 0;
		this.#paused = false;
		const held = this.#held.splice(0);
		for (const event of held) this.#send(event);
		this.delivery.changed?.();
		return held.length;
	}

	#send(event: OrchestratorEvent): void {
		const agentId = this.delivery.orchestrator();
		if (agentId === undefined) {
			this.delivery.log?.(
				`[devhub] orchestrator event ${event.kind} dropped: no orchestrator is assigned`,
			);
			return;
		}
		this.delivery.deliver(
			agentId,
			eventMessage(event, this.delivery.prompts()),
		);
	}
}
