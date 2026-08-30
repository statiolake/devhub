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
 * selected, Hide Sidebar becomes Show Sidebar, and an activity that is not
 * available in the current context is not a choice.
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
import type { Activity } from "../../model/domain.js";

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
	selectActivity(activity: Activity): void;
	setSidebarVisible(visible: boolean): void;
	closeWorkspace(workspaceId: string): void;
	openWorkspacePicker(): void;
	openSettings(): void;
}

let host: MenuHost | undefined;

const ACTIVITY_ITEMS: readonly {
	readonly activity: Activity;
	readonly label: string;
}[] = [
	{ activity: "editor", label: "Editor" },
	{ activity: "agent", label: "Agent" },
	{ activity: "terminal", label: "Terminal" },
];

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
	const sidebarVisible = snapshot?.sidebar.visible ?? true;

	return [
		{
			label: "DevHub",
			submenu: [
				{ role: "about", label: "About DevHub", registerAccelerator: false },
				{ type: "separator" },
				{
					label: "Settings…",
					click: () => {
						menuHost.openSettings();
					},
				},
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
				...ACTIVITY_ITEMS.map(
					({ activity, label }): Electron.MenuItemConstructorOptions => ({
						label,
						type: "checkbox",
						checked: snapshot?.selection.activity === activity,
						enabled:
							snapshot?.activities.find((entry) => entry.activity === activity)
								?.resolution.kind === "enabled",
						click: () => {
							menuHost.selectActivity(activity);
						},
					}),
				),
				{ type: "separator" },
				{
					label: sidebarVisible ? "Hide Sidebar" : "Show Sidebar",
					click: () => {
						menuHost.setSidebarVisible(!sidebarVisible);
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

/** Install the menu bar, and keep it saying what is true. */
export function installMenu(next: MenuHost): void {
	host = next;
	refreshMenu();
}

export function refreshMenu(): void {
	if (!host) return;
	electron.Menu.setApplicationMenu(
		electron.Menu.buildFromTemplate(template(host)),
	);
}
