/** DevHub's menu bar: what is on it, and when it is built again. */

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
		installs += 1;
	};
}

/** How many bars have been put up, by anybody. */
let installs = 0;

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

const { installMenu, refreshMenu } = await import("./menu.js");
const { EDITING_COMMAND_GROUPS } = await import("./editingCommands.js");

let settingsOpened = 0;
let devToolsOpened = 0;

function host() {
	return {
		snapshot: () => undefined,
		focusedWindow: () => "shell" as const,
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

describe("the application menu's Settings and Developer Tools", () => {
	it("are on the bar DevHub builds itself", () => {
		expect(appMenuLabels(applied)).toContain("Settings…");
		expect(appMenuLabels(applied)).toContain("Developer Tools");
	});

	it("reach the commands they name", () => {
		itemLabelled(applied, "Settings…")?.click?.();
		itemLabelled(applied, "Developer Tools")?.click?.();
		expect(settingsOpened).toBe(1);
		expect(devToolsOpened).toBe(1);
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

describe("refreshing the bar", () => {
	it("leaves DevHub's own bar up when nothing it says has changed", () => {
		const before = applied;
		const count = installs;
		refreshMenu();
		refreshMenu();
		expect(applied).toBe(before);
		expect(installs).toBe(count);
	});
});
