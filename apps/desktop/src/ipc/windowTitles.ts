/**
 * What each of DevHub's pages is called.
 *
 * Two processes need this and they need it at different moments, which is why
 * it is stated here rather than in either of them. Main sets the title when it
 * creates a window, so the window has a name before its page exists; the page
 * sets `document.title` when it loads, because Electron applies a page's title
 * to its window and would otherwise overwrite whatever main chose.
 *
 * There is one name per entry, and a page reads its own. It used to be one
 * name per *role*, looked up with the query string the page had been served
 * under, because one `index.html` served the shell window and the Settings
 * window and neither could say which it was. Every page is its own entry now,
 * so the question has no runtime half left: a page names itself by naming the
 * constant it is.
 *
 * The shell window is the exception, and it is an exception in the other
 * direction: its name depends on what is on screen, which only main knows, so
 * main refuses the page's title outright (`ShellWindow`'s `page-title-updated`
 * handler) and names the window itself. The constant below is what that name
 * ends with rather than what it is.
 *
 * These are the names macOS shows in Mission Control, in the Window menu and in
 * the window switcher. They are *not* the application's name: that comes from
 * the bundle DevHub is running in. `app.setName` in `main.ts` says where that
 * bundle comes from in each mode.
 *
 * The shell window's name is not a constant, because a window that is always
 * called the same thing tells anything watching window titles — and people do
 * watch them, to know where their day went — that DevHub was open and nothing
 * else. `shellWindowTitle` is the rule it follows instead, and
 * `main/shell/shellTitle.ts` is what keeps it true.
 */

/** Which of DevHub's own pages this is — one per entry point. */
export type ShellWindowKind =
	| "shell"
	| "settings"
	| "toasts"
	| "picker"
	| "sidebar"
	| "agents";

export const WINDOW_TITLES: Readonly<Record<ShellWindowKind, string>> = {
	shell: "DevHub",
	settings: "DevHub Settings",
	// Every one of these but `shell` and `settings` is a view inside the shell
	// window rather than a window of its own, so nothing displays them. They
	// are here so a page can set a title unconditionally instead of branching
	// on whether it is the kind of page that has one.
	toasts: "DevHub",
	picker: "DevHub",
	sidebar: "DevHub",
	agents: "DevHub",
};

/**
 * What the Navigation Context is called when nothing is selected in it.
 *
 * The Scratch row and the shell window's title are two places that name the
 * same thing, so they name it from here rather than each spelling it.
 */
export const SCRATCH_NAME = "Scratch";

/** Between the parts of the shell window's title, and nowhere else. */
export const TITLE_SEPARATOR = " — ";

/** What the shell window's title is made of, in the order it is read. */
export interface ShellTitleParts {
	/**
	 * The thing being looked at right now: the file the Editor is showing, or
	 * what the selected Agent says it is doing. Absent when there is nothing
	 * more specific than the Workspace itself.
	 */
	readonly element: string | undefined;
	/** The Workspace the selection is in — Scratch is one of them. */
	readonly workspace: string;
}

/**
 * The name of the shell window, whatever it is showing.
 *
 * One rule, in one direction, from the most specific to the least:
 *
 *     {element} — {workspace} — DevHub
 *
 * "DevHub" and the Workspace's name are in every title this can produce. That
 * is the requirement, not a preference: a title is the only handle an activity
 * tracker has on what a window is, and one that drops to "DevHub" while the
 * Editor is showing a file — or to a bare filename while it is not — makes a
 * day's work unattributable to the project it was spent on.
 *
 * The element is the part that can be missing, and when it is, the title simply
 * has one fewer segment. Nothing is substituted for it: a placeholder would be
 * a name for something that is not there.
 */
export function shellWindowTitle(parts: ShellTitleParts): string {
	const element = parts.element?.trim();
	const workspace = parts.workspace.trim();
	// Every title says which Workspace it is about, so there is no such title
	// as one with no Workspace to name. A caller that has none has a bug, and
	// it is a bug about the model rather than about the title.
	if (workspace === "") {
		throw new Error("the shell window's title has no workspace to name");
	}
	return [element === "" ? undefined : element, workspace, WINDOW_TITLES.shell]
		.filter((segment): segment is string => segment !== undefined)
		.join(TITLE_SEPARATOR);
}
