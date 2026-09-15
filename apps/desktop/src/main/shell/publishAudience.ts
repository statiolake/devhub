/**
 * Which pages main is talking to, and why it is not always all of them.
 *
 * Two audiences, because there are two kinds of thing main says.
 *
 * A *projection* is a description of the model. The App Shell page and the
 * modal overlay are two views of the same model — an alert about a workspace
 * is the same workspace the sidebar lists — so they are told the same things
 * at the same moment rather than the overlay fetching its own copy on a second
 * path. A page with no use for a projection draws nothing, and that is the end
 * of it.
 *
 * A *failure* is not a description; it is an event, and a page that receives
 * one and has nowhere to put it has only one thing left to do with it, which
 * is to hand it back. Then main publishes it again. The loop is not a mistake
 * in either half: it is what "every page hears everything" costs once one of
 * the things being said is itself a thing pages say. So a failure goes to the
 * page that draws it and to no other, and the page-side half of the rule is
 * that what arrived is never raised again.
 */

/** As much of a shell window as an audience is decided from. */
export interface Pages<Contents> {
	readonly window: {
		isDestroyed(): boolean;
		readonly webContents: Contents;
	};
	readonly modals: { contents(): Contents | undefined };
}

/** Every page that draws from the model. */
export function projectionAudience<Contents>(
	pages: Pages<Contents>,
): readonly Contents[] {
	if (pages.window.isDestroyed()) return [];
	const overlay = pages.modals.contents();
	return overlay
		? [pages.window.webContents, overlay]
		: [pages.window.webContents];
}

/**
 * The one page that draws failures: the App Shell page, which is the page that
 * is always on screen. The overlay is a sheet of glass main takes off screen
 * the moment the last modal closes, so a failure held there is a failure
 * nobody sees — which is why it is not told.
 */
export function displayAudience<Contents>(
	pages: Pages<Contents>,
): readonly Contents[] {
	if (pages.window.isDestroyed()) return [];
	return [pages.window.webContents];
}
