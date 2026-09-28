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
 * A draft lives exactly as long as its Agent, kept as every such record is
 * (`agentRecords.ts`): a report for an Agent that is not there is dropped,
 * and a draft goes when its Agent does.
 *
 * Only the words are kept. Attached images are not: they are the bytes of
 * the images themselves, which a text file written on every pause in typing
 * should not carry, so after a restart the text comes back without them.
 */

import { AgentRecords, RecordRefused } from "./agentRecords.js";

export class AgentDrafts {
	readonly #records: AgentRecords<string>;

	private constructor(records: AgentRecords<string>) {
		this.#records = records;
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
		const { records, refused } = AgentRecords.load(
			path,
			{
				key: "drafts",
				lost: "the Agents' unsent drafts start empty",
				decode: (text, agentId) => {
					if (typeof text !== "string")
						throw new RecordRefused(`the draft of ${agentId} is not text`);
					return text;
				},
			},
			accounted,
		);
		return { drafts: new AgentDrafts(records), refused };
	}

	/** The Agent's draft; empty when it has none. */
	get(agentId: string): string {
		return this.#records.get(agentId) ?? "";
	}

	/**
	 * The Agent's draft is now `text`; empty is no draft. Dropped when the
	 * Agent is not there: a report that arrives after its Agent went away is
	 * a draft for nothing.
	 */
	set(agentId: string, text: string): void {
		this.#records.set(agentId, text === "" ? undefined : text);
	}

	/** Drop the draft of every Agent that is not there any more. */
	prune(): void {
		this.#records.prune();
	}
}
