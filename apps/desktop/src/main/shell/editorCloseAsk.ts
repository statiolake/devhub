import type { EditorRuntimeState } from "./editorInspection.js";

/**
 * What happened the last time this workspace's workbench was asked to close.
 *
 * Three things, not two. A boolean here carried "we asked and got silence" and
 * "we got as far as the ask" at once, and the two are not the same fact: the
 * second was set before the `starting` refusal, so a workbench that was never
 * asked anything was closed without a save prompt the next time round.
 *
 * A refusal is not an outcome and never enters this. Only the ask writes it,
 * and only from what the ask did.
 */
export type EditorCloseAsk = "never-asked" | "asked-and-silent" | "answered";

/** What to do about a workbench that has been told to close. */
export type EditorCloseStep =
	/** Nothing there holds work anybody could save; the step is already true. */
	| "nothing-to-ask"
	/** It was asked and never answered; asking again would never end. */
	| "close-without-asking"
	/** It is still coming up. Refuse the close and record nothing. */
	| "not-yet"
	/** Run VS Code's unload and let it prompt, save, or veto. */
	| "ask";

/**
 * The one rule for whether a workbench gets asked before it is closed.
 *
 * A veto is an *answer*, so it leaves `answered` behind and the next close
 * asks again — that is what lets work that can still be saved be saved. Only
 * silence earns a close without a question.
 */
export function editorCloseStep(facts: {
	readonly runtime: EditorRuntimeState;
	readonly asked: EditorCloseAsk;
}): EditorCloseStep {
	if (facts.runtime === "absent" || facts.runtime === "gone") {
		return "nothing-to-ask";
	}
	if (facts.asked === "asked-and-silent") return "close-without-asking";
	if (facts.runtime === "starting") return "not-yet";
	return "ask";
}
