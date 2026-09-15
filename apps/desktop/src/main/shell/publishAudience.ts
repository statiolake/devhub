/**
 * Which pages main is talking to, and why it is not always all of them.
 *
 * Two audiences, because there are two kinds of thing main says.
 *
 * A *projection* is a description of the model. The window's own page, the
 * Sidebar, the Agents and the picker are views of the same model — an alert about a workspace is the
 * same workspace the sidebar lists — so they are told the same things at the
 * same moment rather than the picker fetching its own copy on a second path. A
 * page with no use for a projection draws nothing, and that is the end of it.
 *
 * A *failure* is not a description; it is an event, and a page that receives
 * one and has nowhere to put it has only one thing left to do with it, which
 * is to hand it back. Then main publishes it again. The loop is not a mistake
 * in either half: it is what "every page hears everything" costs once one of
 * the things being said is itself a thing pages say. So a failure goes to the
 * page that draws it and to no other, and the page-side half of the rule is
 * that what arrived is never raised again.
 *
 * # Where a failure is drawn depends on where it can be seen
 *
 * There is now a page whose whole job is drawing them: the `toasts` view. It
 * has no snapshot, no model and no other reason to exist, and it is a child of
 * the shell window, so a failure sent there is drawn over whatever is on
 * screen — including a workbench, which the App Shell page could never do.
 *
 * The Settings window is the exception, and it is an exception about *being
 * seen* rather than about being routed. Settings is an independent window with
 * its own page and its own root handler. A failure that began there, drawn on
 * the shell window's toasts, is a report about the thing the person is looking
 * at, put somewhere they are not looking — and possibly on a window that is
 * hidden. So it goes back to the window it came from. Main still journals it
 * either way: `publishError` is one door, and this only decides who is told.
 */

/** As much of a shell window as an audience is decided from. */
export interface Pages<Contents> {
	readonly window: {
		isDestroyed(): boolean;
		readonly webContents: Contents;
	};
	readonly sidebar: { contents(): Contents | undefined };
	readonly agents: { contents(): Contents | undefined };
	readonly picker: { contents(): Contents | undefined };
	readonly toasts: { contents(): Contents | undefined };
}

/** Every page that draws from the model. */
export function projectionAudience<Contents>(
	pages: Pages<Contents>,
): readonly Contents[] {
	if (pages.window.isDestroyed()) return [];
	// The window's own page, and every child page that draws from the model.
	// They are views of one model — an alert about a workspace is the same
	// workspace the Sidebar lists — so they are told the same things at the
	// same moment rather than each fetching its own copy on a second path.
	return [
		pages.window.webContents,
		pages.sidebar.contents(),
		pages.agents.contents(),
		pages.picker.contents(),
	].filter((contents): contents is Contents => contents !== undefined);
}

/**
 * The one page that draws app-scoped failures and conditions.
 *
 * `origin` is the page a failure began on, when one is known. It is consulted
 * for exactly one thing: a failure raised in a window that is not this one is
 * drawn in that window, because that is the window the person is looking at.
 * Anything else — main's own failures, the App Shell page's, the picker's,
 * the toasts page's own — is drawn on the toasts view.
 */
export function displayAudience<Contents>(
	pages: Pages<Contents>,
	origin?: Contents,
): readonly Contents[] {
	if (origin !== undefined && !ownedBy(pages, origin)) return [origin];
	if (pages.window.isDestroyed()) return [];
	const toasts = pages.toasts.contents();
	return toasts ? [toasts] : [];
}

/** Whether these contents are one of the shell window's own pages. */
function ownedBy<Contents>(
	pages: Pages<Contents>,
	contents: Contents,
): boolean {
	if (pages.window.isDestroyed()) return false;
	return (
		contents === pages.window.webContents ||
		contents === pages.sidebar.contents() ||
		contents === pages.agents.contents() ||
		contents === pages.picker.contents() ||
		contents === pages.toasts.contents()
	);
}
