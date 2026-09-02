/**
 * What an Agent says it is doing, in its own words.
 *
 * A terminal program can name itself with OSC 0 or OSC 2, and tmux keeps the
 * last such name as the pane's `#{pane_title}`. When an Agent sets it to the
 * step it is on, that one string is the Agent's own sentence about itself —
 * read on the same capture, on the same cadence, as its status.
 * `AgentStatusDetector` says *how* the Agent is; this says *what* it is doing,
 * and neither is derived from the other.
 *
 * **What "no report" looks like.** An empty title, and nothing else.
 *
 * That is only a usable rule because DevHub makes it true: a new pane's title
 * is tmux's own default — the host name — so an Agent's session is created
 * with the title blanked (see `createSession`), and from then on anything in
 * it was put there by the Agent.
 *
 * It used to be inferred instead: the title a pane carried the first time
 * DevHub read it was taken to be that pane's silence. That is a race with the
 * Agent's own startup. Read a moment early and the baseline is the host name,
 * so every title the Agent ever sets reads as a word; read a moment late and
 * the Agent's first title *becomes* the baseline, so the Agent is silent for
 * the rest of its life. The same Agent behaved either way depending on when
 * DevHub happened to look, and the answer was drawn again from scratch on
 * every restart — which is what made a row's word come and go.
 *
 * An Agent that outlived DevHub keeps whatever title it had, and that reads as
 * its word rather than as silence. That is the honest answer for a pane DevHub
 * did not start: something is in the title, and the Agent is what put it there.
 */

import type { AgentScreen } from "./detect/detector.js";

export class AgentActivityReader {
	/** The word each Agent's row is showing, for a round that read nothing. */
	readonly #current = new Map<string, string | undefined>();

	/** This Agent's word this round, or `undefined` if it has none. */
	activity(screen: AgentScreen): string | undefined {
		const title = screen.oscTitle.trim();
		const word = title === "" ? undefined : title;
		this.#current.set(screen.agentId, word);
		return word;
	}

	/** What this Agent's row is showing now, for a round that read nothing. */
	showing(agentId: string): string | undefined {
		return this.#current.get(agentId);
	}

	/** An Agent that ended takes its pane's history with it. */
	forget(agentId: string): void {
		this.#current.delete(agentId);
	}
}
