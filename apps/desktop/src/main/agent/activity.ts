/**
 * What an Agent says it is doing, in its own words.
 *
 * A terminal program can name itself with OSC 0 or OSC 2, and tmux keeps the
 * last such name as the pane's `#{pane_title}`. Claude Code sets it to the step
 * it is on and updates it as the work moves, so that one string is the Agent's
 * own sentence about itself — read on the same capture, on the same cadence,
 * as its status. `AgentStatusDetector` says *how* the Agent is; this says
 * *what* it is doing, and neither is derived from the other.
 *
 * **What "no report" looks like.** A pane always has a title whether or not
 * anything meant one: tmux gives a new pane a default, and a shell's `precmd`
 * commonly rewrites it at every prompt. Those are the terminal talking about
 * itself, not the Agent talking about its work — but their value belongs to the
 * machine and the person's shell, so no fixed string can name them.
 *
 * So the rule is stated about *this pane* instead of about any particular
 * value: **the title this Agent's pane carried the first time DevHub read it is
 * that pane's silence.** DevHub reads the pane 300ms after creating the
 * session, before the Agent has run a step, so the first reading is whatever
 * the terminal calls itself when nothing has been said — and every later
 * reading equal to it is the same silence, which is exactly what a `precmd` put
 * back when the Agent's step ended. Anything else is the Agent's word, on any
 * machine, under any shell, with nothing hard-coded.
 *
 * The one place the rule reads less than it could is an Agent that outlived
 * DevHub: its session is still running when DevHub starts again, so the first
 * reading is taken mid-task and that sentence becomes this pane's silence. The
 * row is wordless until the title changes again — which, for an Agent that
 * narrates its steps, is the next step. It is a moment of saying nothing rather
 * than a moment of saying something false, and it heals itself.
 */

import type { AgentScreen } from "./detect/detector.js";

export class AgentActivityReader {
	/** The title that means this pane is not saying anything. */
	readonly #silence = new Map<string, string>();
	/** The word each Agent's row is showing, for a round that read nothing. */
	readonly #current = new Map<string, string | undefined>();

	/**
	 * This Agent's word this round, or `undefined` if it has none.
	 *
	 * The first reading of a pane establishes its silence and is therefore
	 * never a word itself.
	 */
	activity(screen: AgentScreen): string | undefined {
		const title = screen.oscTitle.trim();
		const silence = this.#silence.get(screen.agentId);
		if (silence === undefined) {
			this.#silence.set(screen.agentId, title);
			return this.#commit(screen.agentId, undefined);
		}
		return this.#commit(
			screen.agentId,
			title === "" || title === silence ? undefined : title,
		);
	}

	/** What this Agent's row is showing now, for a round that read nothing. */
	showing(agentId: string): string | undefined {
		return this.#current.get(agentId);
	}

	/** An Agent that ended takes its pane's history with it. */
	forget(agentId: string): void {
		this.#silence.delete(agentId);
		this.#current.delete(agentId);
	}

	#commit(agentId: string, word: string | undefined): string | undefined {
		this.#current.set(agentId, word);
		return word;
	}
}
