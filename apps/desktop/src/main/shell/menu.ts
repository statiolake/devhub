/**
 * DevHub's menu bar.
 *
 * On a Mac the menu bar is where a command is looked for first, so every
 * command DevHub has appears here with the shortcut it is reached by, and the
 * shortcuts live nowhere else: a page that also listened for Cmd+, or Cmd+W
 * would be a second answer to the same key, and the two would drift.
 *
 * The menu is rebuilt whenever the model changes, because a menu item has to
 * say what is true now — Close Workspace is only meaningful with a workspace
 * selected, and it names the workspace it would close.
 *
 * **Nothing here has an accelerator, deliberately.** A menu accelerator is a
 * key taken away from whatever is focused, and DevHub's surfaces are whole
 * applications with their own: Command-W closes an editor tab, Command-N makes
 * a file, Command-1 focuses an editor group, Command-K belongs to the
 * terminal. A menu that claimed those would break every one of them to save a
 * click. The keys stay with the surfaces; the menu stays the place commands
 * can be found and clicked. Quitting is the Quit item, or the Command-Q chord
 * (see `keyRouter.ts`), which is the one key DevHub does interpret.
 */

import { electron } from "../electron.js";
import type { AppSnapshotWire } from "../../ipc/appShell.js";

export interface MenuHost {
	/** The model as the page sees it, or nothing before the first projection. */
	snapshot(): AppSnapshotWire | undefined;
	/**
	 * Which window the menu is currently about.
	 *
	 * A Mac menu bar describes the key window, so Cmd+W has to mean "close this
	 * Settings window" while Settings is in front and "close this workspace"
	 * while the main window is.
	 */
	focusedWindow(): "shell" | "settings" | "none";
	/** Show or hide the integrated terminal in the workbench on screen. */
	toggleIntegratedTerminal(): void;
	closeWorkspace(workspaceId: string): void;
	openWorkspacePicker(): void;
	openSettings(): void;
	/** Open the Web Inspector on whatever the keyboard is currently in. */
	openDeveloperTools(): void;
}

let host: MenuHost | undefined;

/**
 * The workspace the selection is in, or nothing when it is Global.
 *
 * An Agent is selected *within* a workspace, so Close Workspace means the same
 * thing there as it does with the workspace row itself selected. Anything else
 * would make the command's availability depend on which row of the same
 * workspace happens to be highlighted.
 */
function selectedWorkspace(
	snapshot: AppSnapshotWire | undefined,
): { readonly id: string; readonly label: string } | undefined {
	const context = snapshot?.selection.context;
	if (!context || context.kind === "global") return undefined;
	const workspace = snapshot?.workspaces.find((candidate) =>
		context.kind === "workspace"
			? candidate.id === context.workspaceId
			: candidate.agents.some((agent) => agent.id === context.agentId),
	);
	if (!workspace) return undefined;
	return { id: workspace.id, label: workspace.label };
}

function template(menuHost: MenuHost): Electron.MenuItemConstructorOptions[] {
	const snapshot = menuHost.snapshot();
	const workspace = selectedWorkspace(snapshot);

	return [
		{
			label: "DevHub",
			submenu: [
				{ role: "about", label: "About DevHub", registerAccelerator: false },
				// Settings and the Web Inspector are not written here. They are
				// merged into whichever application menu is current — this one, or
				// the one the workbench installs — by `permanentAppMenuItems`.
				{ type: "separator" },
				{ role: "services", registerAccelerator: false },
				{ type: "separator" },
				{ role: "hide", label: "Hide DevHub", registerAccelerator: false },
				{ role: "hideOthers", registerAccelerator: false },
				{ role: "unhide", registerAccelerator: false },
				{ type: "separator" },
				{
					label: "Quit DevHub",
					click: () => {
						electron.app.quit();
					},
				},
			],
		},
		{
			label: "File",
			submenu:
				menuHost.focusedWindow() === "settings"
					? [
							{
								label: "Close Settings",
								click: () => {
									electron.BrowserWindow.getFocusedWindow()?.close();
								},
							},
						]
					: [
							{
								label: "Add Workspace…",
								click: () => {
									menuHost.openWorkspacePicker();
								},
							},
							{ type: "separator" },
							{
								// Named for what it closes, and disabled when there is
								// nothing selected to close, rather than closing
								// something else.
								label: workspace
									? `Close “${workspace.label}”`
									: "Close Workspace",
								enabled: workspace !== undefined,
								click: () => {
									if (workspace) menuHost.closeWorkspace(workspace.id);
								},
							},
							{
								label: "Close Window",
								click: () => {
									electron.BrowserWindow.getFocusedWindow()?.close();
								},
							},
						],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo", registerAccelerator: false },
				{ role: "redo", registerAccelerator: false },
				{ type: "separator" },
				{ role: "cut", registerAccelerator: false },
				{ role: "copy", registerAccelerator: false },
				{ role: "paste", registerAccelerator: false },
				{ role: "pasteAndMatchStyle", registerAccelerator: false },
				{ role: "delete", registerAccelerator: false },
				{ role: "selectAll", registerAccelerator: false },
			],
		},
		{
			label: "View",
			submenu: [
				{
					// Not a checkbox: whether the panel is up is the workbench's own
					// state, and a checkmark drawn from a fact DevHub does not hold
					// would be right only by luck.
					label: "Toggle Integrated Terminal",
					click: () => {
						menuHost.toggleIntegratedTerminal();
					},
				},
				{ type: "separator" },
				{ role: "togglefullscreen", registerAccelerator: false },
			],
		},
		{
			label: "Window",
			submenu: [
				{ role: "minimize", registerAccelerator: false },
				{ role: "zoom", registerAccelerator: false },
				{ type: "separator" },
				{
					role: "front",
					label: "Bring All to Front",
					registerAccelerator: false,
				},
			],
		},
		{
			role: "help",
			submenu: [
				{
					label: "DevHub Help",
					click: () => {
						void electron.shell.openExternal(
							"https://github.com/statiolake/devhub#readme",
						);
					},
				},
			],
		},
	];
}

/**
 * The id our merged items carry, so a menu is never given them twice.
 *
 * Electron rebuilds and re-sets the application menu often; the merge runs on
 * every one of those, and a `Menu` it has already seen must come back
 * unchanged.
 */
const PERMANENT_ITEM_ID = "devhub.permanent";

/**
 * The items that belong to DevHub whatever else is on the menu bar.
 *
 * DevHub is two applications sharing one menu bar: the shell owns it while the
 * sidebar has the keyboard, and the workbench replaces it wholesale — its own
 * menubar service calls `setApplicationMenu` — the moment the editor does. The
 * replacement is complete, so DevHub's own commands simply left the bar, and
 * Settings became unreachable from exactly the place a Mac user looks for it.
 *
 * The fix is not a second menu or a branch per caller. `setApplicationMenu` is
 * the one door every menu goes through, so it is the one place that can say
 * "and these are always in the application menu". Whoever built the menu, and
 * whatever else is on it, these two are in it.
 */
function permanentAppMenuItems(
	menuHost: MenuHost,
): Electron.MenuItemConstructorOptions[] {
	return [
		{ type: "separator", id: PERMANENT_ITEM_ID },
		{
			id: PERMANENT_ITEM_ID,
			label: "Settings…",
			click: () => {
				menuHost.openSettings();
			},
		},
		{
			id: PERMANENT_ITEM_ID,
			// Named for the window it opens, and pointed at whatever the keyboard
			// is in — see `openDeveloperTools`. A DevHub window is several web
			// contents stacked over one rectangle, so "the page" is not a thing
			// this item could mean on its own.
			label: "Developer Tools",
			click: () => {
				menuHost.openDeveloperTools();
			},
		},
	];
}

/**
 * Put DevHub's permanent items into an application menu it is not the author of.
 *
 * Insertion rather than a rebuild: what arrives here is a built `Menu`, and the
 * template that produced it belongs to whoever built it. They go at the top of
 * the first submenu, which is the application menu on macOS, directly under
 * About — where they already sat in DevHub's own template, so the bar does not
 * rearrange itself depending on which surface has the keyboard.
 */
function mergePermanentItems(menu: Electron.Menu): void {
	if (!host) return;
	const appMenu = menu.items[0]?.submenu;
	if (!appMenu) return;
	if (appMenu.items.some((item) => item.id === PERMANENT_ITEM_ID)) return;
	// Built one at a time and inserted in order, so the separator stays above
	// the items it separates.
	let position = 1;
	for (const options of permanentAppMenuItems(host)) {
		appMenu.insert(position, new electron.MenuItem(options));
		position += 1;
	}
}

/**
 * Take over `setApplicationMenu`, once.
 *
 * Every menu the application ever wears goes through the replacement, so there
 * is no caller left that can install a bar without DevHub's own items on it —
 * including the workbench's menubar service, which knows nothing about DevHub
 * and should not have to.
 */
let claimed = false;
function claimApplicationMenu(): void {
	if (claimed) return;
	claimed = true;
	const original = electron.Menu.setApplicationMenu.bind(electron.Menu);
	electron.Menu.setApplicationMenu = (menu: Electron.Menu | null) => {
		if (menu) mergePermanentItems(menu);
		original(menu);
	};
}

/** Install the menu bar, and keep it saying what is true. */
export function installMenu(next: MenuHost): void {
	host = next;
	claimApplicationMenu();
	refreshMenu();
}

export function refreshMenu(): void {
	if (!host) return;
	electron.Menu.setApplicationMenu(
		electron.Menu.buildFromTemplate(template(host)),
	);
}
