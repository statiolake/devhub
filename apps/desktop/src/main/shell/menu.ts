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
 * applications with their own: Neovim's and the terminal's keys belong to
 * them. A menu that claimed those would break every one of them to save a
 * click. The keys stay with the surfaces; the menu stays the place commands
 * can be found and clicked. Quitting is the Quit item, or the Command-Q chord
 * (see `keyRouter.ts`), which is the one key DevHub does interpret.
 *
 * The Edit menu's items still *show* their Mac shortcuts, because that is what
 * a role's default accelerator draws and those keys really do work — but they
 * are not registered here either. What answers them is `editingCommands.ts`,
 * per surface, which is why the same list builds this submenu.
 */

import { electron } from "../electron.js";
import { EDITING_COMMAND_GROUPS } from "./editingCommands.js";
import type { AppSnapshotWire } from "../../ipc/appShell.js";
import { noteMainActivity } from "../diagnostics/eventLoopLag.js";

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
	closeWorkspace(workspaceId: string): void;
	openWorkspacePicker(): void;
	openSettings(): void;
	/** Open the Web Inspector on whatever the keyboard is currently in. */
	openDeveloperTools(): void;
}

let host: MenuHost | undefined;

/**
 * The workspace the selection is in, or nothing when that is Scratch, which
 * does not close (it stops being Scratch at midnight instead).
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
	if (!context) return undefined;
	const workspace = snapshot.workspaces.find((candidate) =>
		context.kind === "workspace"
			? candidate.id === context.workspaceId
			: context.kind === "agent" &&
				candidate.agents.some((agent) => agent.id === context.agentId),
	);
	if (
		!workspace ||
		workspace.id === snapshot.scratchWorkspaceId ||
		workspace.id === snapshot.orchestratorWorkspaceId
	) {
		return undefined;
	}
	return { id: workspace.id, label: workspace.label };
}

/**
 * The Edit menu, read from the one list of editing commands.
 *
 * Written from `EDITING_COMMAND_GROUPS` rather than by hand so that the menu
 * and the keys cannot come to disagree about what DevHub can edit with. The
 * groups are what the separators separate, so the shape of the menu is in the
 * list too.
 */
function editSubmenu(): Electron.MenuItemConstructorOptions[] {
	return EDITING_COMMAND_GROUPS.flatMap((group, index) => [
		...(index === 0
			? []
			: [{ type: "separator" } as Electron.MenuItemConstructorOptions]),
		...group.map(
			(command): Electron.MenuItemConstructorOptions => ({
				role: command.role,
				registerAccelerator: false,
			}),
		),
	]);
}

function template(menuHost: MenuHost): Electron.MenuItemConstructorOptions[] {
	const snapshot = menuHost.snapshot();
	const workspace = selectedWorkspace(snapshot);

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
				{
					// Named for the window it opens, and pointed at whatever the
					// keyboard is in — see `openDeveloperTools`. A DevHub window is
					// several web contents stacked over one rectangle, so "the page"
					// is not a thing this item could mean on its own.
					label: "Developer Tools",
					click: () => {
						menuHost.openDeveloperTools();
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
			submenu: editSubmenu(),
		},
		{
			label: "View",
			submenu: [{ role: "togglefullscreen", registerAccelerator: false }],
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
	installed = undefined;
	refreshMenu();
}

/**
 * What the template is a function of, as one string.
 *
 * Everything else in it is fixed. A refresh used to run on every projection
 * change — several times a second while an Agent works — and each one built
 * and installed a whole native menu bar on main's thread, for a bar that said
 * exactly what it said before.
 */
export function menuKey(
	focused: ReturnType<MenuHost["focusedWindow"]>,
	snapshot: AppSnapshotWire | undefined,
): string {
	const workspace = selectedWorkspace(snapshot);
	return JSON.stringify([focused, workspace?.id, workspace?.label]);
}

/** The bar DevHub last installed, and what it was built from. */
let installed: { readonly key: string } | undefined;

export function refreshMenu(): void {
	if (!host) return;
	const key = menuKey(host.focusedWindow(), host.snapshot());
	if (installed?.key === key) return;
	noteMainActivity("menu rebuild");
	const menu = electron.Menu.buildFromTemplate(template(host));
	electron.Menu.setApplicationMenu(menu);
	installed = { key };
}
