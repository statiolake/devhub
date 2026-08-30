/**
 * Whether the page asking for the native surface is asking for something real.
 *
 * The page says "show the workbench" the moment its selection resolves to one.
 * Main knows three things about that workbench and they are not two: it can be
 * on screen, it can be *being built*, or it can not exist at all. Only the
 * third is a broken invariant.
 *
 * They were read as two, and at launch that is exactly the wrong pair to
 * collapse: a relaunch restores the selection and the page asks for the
 * Editor before the eager open for that folder has finished, so a perfectly
 * ordinary start reported "which has no live workbench view" on the failure
 * surface. A view that died still has to be caught — that is a real bug and
 * has to stay loud — so the distinction is made here, in one line, rather than
 * by softening the check.
 */
export type EditorReveal = "on-screen" | "coming" | "absent";

export function editorReveal(state: {
	/** A workbench view is revealed in the window right now. */
	readonly revealed: boolean;
	/** An open for the folder the selection resolves to is in flight. */
	readonly opening: boolean;
}): EditorReveal {
	if (state.revealed) return "on-screen";
	return state.opening ? "coming" : "absent";
}
