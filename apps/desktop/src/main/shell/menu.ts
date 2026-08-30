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
	 * while the main window is. One accelerator, whichever window it lands in.
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
	readonly accelerator: string;
}[] = [
	{ activity: "editor", label: "Editor", accelerator: "CmdOrCtrl+1" },
	{ activity: "agent", label: "Agent", accelerator: "CmdOrCtrl+2" },
	{ activity: "terminal", label: "Terminal", accelerator: "CmdOrCtrl+3" },
];

/** The selected workspace, or nothing when the selection is Global. */
function selectedWorkspace(
	snapshot: AppSnapshotWire | undefined,
): { readonly id: string; readonly label: string } | undefined {
	const context = snapshot?.selection.context;
	if (!context || context.kind !== "workspace") return undefined;
	const workspace = snapshot?.workspaces.find(
		(candidate) => candidate.id === context.workspaceId,
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
				{ role: "about", label: "About DevHub" },
				{ type: "separator" },
				{
					label: "Settings…",
					accelerator: "CmdOrCtrl+,",
					click: () => {
						menuHost.openSettings();
					},
				},
				{ type: "separator" },
				{ role: "services" },
				{ type: "separator" },
				{ role: "hide", label: "Hide DevHub" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit", label: "Quit DevHub" },
			],
		},
		{
			label: "File",
			submenu:
				menuHost.focusedWindow() === "settings"
					? [{ role: "close", label: "Close Settings" }]
					: [
							{
								label: "Add Workspace…",
								accelerator: "CmdOrCtrl+N",
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
								accelerator: "CmdOrCtrl+W",
								enabled: workspace !== undefined,
								click: () => {
									if (workspace) menuHost.closeWorkspace(workspace.id);
								},
							},
							{
								role: "close",
								label: "Close Window",
								accelerator: "Shift+Cmd+W",
							},
						],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "pasteAndMatchStyle" },
				{ role: "delete" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				...ACTIVITY_ITEMS.map(
					({
						activity,
						label,
						accelerator,
					}): Electron.MenuItemConstructorOptions => ({
						label,
						accelerator,
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
					accelerator: "Control+Cmd+S",
					click: () => {
						menuHost.setSidebarVisible(!sidebarVisible);
					},
				},
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: "Window",
			submenu: [
				{ role: "minimize" },
				{ role: "zoom" },
				{ type: "separator" },
				{ role: "front", label: "Bring All to Front" },
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
