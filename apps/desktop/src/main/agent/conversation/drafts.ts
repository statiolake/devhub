/**
 * What the person was typing to each GUI Agent and has not sent: its draft.
 *
 * One string per Agent, held by main and kept in `drafts.json` beside
 * `state.json`, so a draft outlives a restart of DevHub (or of the Agents
 * page) and comes back into the same Agent's composer. The page is the only
 * author: it reports the draft as it changes (`ConversationActions.saveDraft`,
 * debounced there), and main keeps the last report — so two places typing to
 * one Agent is last write wins.
 *
 * A draft lives exactly as long as its Agent, and the store is told which
 * Agents there are (`accounted`) rather than trusting anyone to remember to
 * say one went away: a report for an Agent that is not there is dropped, and
 * `prune` (run whenever the projection changes, and at load) drops every
 * draft whose Agent has gone. That is why the drafts are not in the Agent's
 * own host directory, which lives as long but sits on the Agent's machine —
 * an SSH round trip per keystroke pause, and a write that could not finish
 * after main is told to quit — nor in `state.json`, whose every save is a
 * snapshot of the whole model.
 *
 * Only the words are kept. Attached images are not: they are the bytes of
 * the images themselves, which a text file written on every pause in typing
 * should not carry, so after a restart the text comes back without them.
 *
 * Each write replaces the file whole (a temporary file renamed over it) and
 * is synchronous, so a report main has received is on disk before anything
 * after it — a quit included — can run.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const VERSION = 1;

export class AgentDrafts {
	readonly #path: string;
	readonly #accounted: () => ReadonlySet<string>;
	readonly #drafts: Map<string, string>;

	private constructor(
		path: string,
		accounted: () => ReadonlySet<string>,
		drafts: Map<string, string>,
	) {
		this.#path = path;
		this.#accounted = accounted;
		this.#drafts = drafts;
	}

	/**
	 * The drafts at `path`, none when there is no file yet. A file that does
	 * not read as drafts is moved aside to `<path>.corrupt` and the store starts
	 * empty; `refused` says so, for the caller to tell the person.
	 */
	static load(
		path: string,
		accounted: () => ReadonlySet<string>,
	): { readonly drafts: AgentDrafts; readonly refused: string | undefined } {
		if (!existsSync(path)) {
			return {
				drafts: new AgentDrafts(path, accounted, new Map()),
				refused: undefined,
			};
		}
		const text = readFileSync(path, "utf8");
		let decoded: Map<string, string>;
		try {
			decoded = decode(JSON.parse(text));
		} catch (error: unknown) {
			if (!(error instanceof SyntaxError || error instanceof DraftsRefused)) {
				throw error;
			}
			const aside = `${path}.corrupt`;
			renameSync(path, aside);
			return {
				drafts: new AgentDrafts(path, accounted, new Map()),
				refused: `${path} could not be read (${error.message}); it was moved to ${aside}, and the Agents' unsent drafts start empty.`,
			};
		}
		const drafts = new AgentDrafts(path, accounted, decoded);
		drafts.prune();
		return { drafts, refused: undefined };
	}

	/** The Agent's draft; empty when it has none. */
	get(agentId: string): string {
		return this.#drafts.get(agentId) ?? "";
	}

	/**
	 * The Agent's draft is now `text`; empty is no draft. Dropped when the
	 * Agent is not there: a report that arrives after its Agent went away is
	 * a draft for nothing.
	 */
	set(agentId: string, text: string): void {
		if (!this.#accounted().has(agentId)) {
			if (this.#drafts.delete(agentId)) this.#write();
			return;
		}
		if (this.get(agentId) === text) return;
		if (text === "") this.#drafts.delete(agentId);
		else this.#drafts.set(agentId, text);
		this.#write();
	}

	/** Drop the draft of every Agent that is not there any more. */
	prune(): void {
		const accounted = this.#accounted();
		let dropped = false;
		for (const agentId of [...this.#drafts.keys()]) {
			if (accounted.has(agentId)) continue;
			this.#drafts.delete(agentId);
			dropped = true;
		}
		if (dropped) this.#write();
	}

	#write(): void {
		mkdirSync(dirname(this.#path), { recursive: true });
		const temporary = `${this.#path}.tmp`;
		writeFileSync(
			temporary,
			`${JSON.stringify({
				version: VERSION,
				drafts: Object.fromEntries(this.#drafts),
			})}\n`,
		);
		renameSync(temporary, this.#path);
	}
}

class DraftsRefused extends Error {}

function decode(value: unknown): Map<string, string> {
	if (typeof value !== "object" || value === null)
		throw new DraftsRefused("it is not an object");
	const { version, drafts } = value as Record<string, unknown>;
	if (version !== VERSION)
		throw new DraftsRefused(`its version is ${JSON.stringify(version)}`);
	if (typeof drafts !== "object" || drafts === null || Array.isArray(drafts))
		throw new DraftsRefused("its drafts are not an object");
	const decoded = new Map<string, string>();
	for (const [agentId, text] of Object.entries(drafts)) {
		if (typeof text !== "string")
			throw new DraftsRefused(`the draft of ${agentId} is not text`);
		decoded.set(agentId, text);
	}
	return decoded;
}
