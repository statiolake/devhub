/**
 * DevHub's items survive a menu bar it did not build.
 *
 * The workbench's own menubar service calls `setApplicationMenu` and replaces
 * the bar wholesale the moment the editor takes the keyboard. That is not a
 * thing DevHub can ask it to stop doing, and it is not a thing every future
 * caller will remember to account for — so the guarantee has to hold for a
 * menu built by somebody who has never heard of DevHub.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeItemOptions {
	readonly id?: string;
	readonly label?: string;
	readonly type?: string;
	readonly role?: string;
	readonly registerAccelerator?: boolean;
	readonly submenu?: FakeMenu;
	readonly click?: () => void;
}

class FakeMenuItem {
	readonly id: string | undefined;
	readonly label: string | undefined;
	readonly type: string | undefined;
	readonly role: string | undefined;
	readonly registerAccelerator: boolean | undefined;
	readonly submenu: FakeMenu | undefined;
	readonly click: (() => void) | undefined;
	constructor(options: FakeItemOptions) {
		this.id = options.id;
		this.label = options.label;
		this.type = options.type;
		this.role = options.role;
		this.registerAccelerator = options.registerAccelerator;
		this.submenu = options.submenu;
		this.click = options.click;
	}
}

class FakeMenu {
	readonly items: FakeMenuItem[] = [];
	insert(position: number, item: FakeMenuItem): void {
		this.items.splice(position, 0, item);
	}
	append(item: FakeMenuItem): void {
		this.items.push(item);
	}
	static buildFromTemplate(template: FakeItemOptions[]): FakeMenu {
		const menu = new FakeMenu();
		for (const entry of template) {
			const submenu = Array.isArray(entry.submenu)
				? FakeMenu.buildFromTemplate(entry.submenu)
				: undefined;
			menu.append(new FakeMenuItem({ ...entry, submenu }));
		}
		return menu;
	}
	static setApplicationMenu = (menu: FakeMenu | null) => {
		applied = menu;
	};
}

/** The menu currently on the bar, as the last caller left it. */
let applied: FakeMenu | null = null;

vi.mock("../electron.js", () => ({
	electron: {
		Menu: FakeMenu,
		MenuItem: FakeMenuItem,
		app: { quit: () => undefined },
		shell: { openExternal: () => Promise.resolve() },
		BrowserWindow: { getFocusedWindow: () => undefined },
	},
}));

const { installMenu } = await import("./menu.js");
const { EDITING_COMMAND_GROUPS } = await import("./editingCommands.js");
const { electron } = await import("../electron.js");

let settingsOpened = 0;
let devToolsOpened = 0;

function host() {
	return {
		snapshot: () => undefined,
		focusedWindow: () => "shell" as const,
		toggleIntegratedTerminal: () => undefined,
		closeWorkspace: () => undefined,
		openWorkspacePicker: () => undefined,
		openSettings: () => {
			settingsOpened += 1;
		},
		openDeveloperTools: () => {
			devToolsOpened += 1;
		},
	};
}

/** The application menu, which on a Mac is the first one on the bar. */
function appMenuLabels(menu: FakeMenu | null): (string | undefined)[] {
	return (menu?.items[0]?.submenu?.items ?? []).map((item) => item.label);
}

function itemLabelled(menu: FakeMenu | null, label: string) {
	return (menu?.items[0]?.submenu?.items ?? []).find(
		(item) => item.label === label,
	);
}

beforeEach(() => {
	applied = null;
	settingsOpened = 0;
	devToolsOpened = 0;
	installMenu(host());
});

describe("the permanent application-menu items", () => {
	it("are on the bar DevHub builds itself", () => {
		expect(appMenuLabels(applied)).toContain("Settings…");
		expect(appMenuLabels(applied)).toContain("Developer Tools");
	});

	it("are added to a bar built by somebody else", () => {
		// What the workbench's menubar service does: its own template, its own
		// application menu, nothing of DevHub's in it.
		electron.Menu.setApplicationMenu(
			FakeMenu.buildFromTemplate([
				{ label: "Code", submenu: [{ label: "About Code" }] as never },
				{ label: "File", submenu: [] as never },
			] as never) as never,
		);

		expect(appMenuLabels(applied)).toEqual([
			"About Code",
			undefined,
			"Settings…",
			"Developer Tools",
		]);
	});

	it("reach the commands they name", () => {
		itemLabelled(applied, "Settings…")?.click?.();
		itemLabelled(applied, "Developer Tools")?.click?.();
		expect(settingsOpened).toBe(1);
		expect(devToolsOpened).toBe(1);
	});

	it("are not added twice to a menu that already carries them", () => {
		const menu = FakeMenu.buildFromTemplate([
			{ label: "Code", submenu: [{ label: "About Code" }] as never },
		] as never);
		electron.Menu.setApplicationMenu(menu as never);
		// Electron re-sets the same menu often; a second pass must leave it as
		// it is rather than growing a duplicate pair every time.
		electron.Menu.setApplicationMenu(menu as never);

		const settings = appMenuLabels(applied).filter(
			(label) => label === "Settings…",
		);
		expect(settings).toHaveLength(1);
	});

	it("leaves a menu of nothing alone", () => {
		// `setApplicationMenu(null)` clears the bar; there is no application
		// menu to merge into, and inventing one would put a bar back.
		electron.Menu.setApplicationMenu(null);
		expect(applied).toBeNull();
	});
});

describe("the Edit menu", () => {
	/** The Edit menu of the bar DevHub built itself. */
	function editItems() {
		return (
			applied?.items.find((item) => item.label === "Edit")?.submenu?.items ?? []
		);
	}

	it("is built from the one list of editing commands", () => {
		expect(
			editItems()
				.filter((item) => item.type !== "separator")
				.map((item) => item.role),
		).toEqual(EDITING_COMMAND_GROUPS.flat().map((command) => command.role));
	});

	it("separates the groups the list is written in", () => {
		expect(editItems().map((item) => item.type ?? item.role)).toEqual([
			"undo",
			"redo",
			"separator",
			"cut",
			"copy",
			"paste",
			"pasteAndMatchStyle",
			"delete",
			"selectAll",
		]);
	});

	it("registers none of the accelerators it shows", () => {
		// A role draws its Mac shortcut next to the item, which is right — those
		// keys work. Registering them would take them from every surface at
		// once; `editingCommands.ts` answers them per surface instead.
		for (const item of editItems()) {
			if (item.type === "separator") continue;
			expect(item.registerAccelerator).toBe(false);
		}
	});
});
