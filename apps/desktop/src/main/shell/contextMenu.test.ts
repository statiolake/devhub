/**
 * A context menu is what the page asked for, at the point it was asked for.
 *
 * The template is pure, so what reaches macOS is compared here without a menu
 * on screen; the popup is driven through a fake `Menu`, so the one rule it
 * has — a click answers, a dismissal answers nothing — is pinned too.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface PopupOptions {
	readonly x?: number;
	readonly y?: number;
	readonly callback?: () => void;
}

let built: Electron.MenuItemConstructorOptions[] = [];
let popped: PopupOptions | undefined;

vi.mock("../electron.js", () => ({
	electron: {
		Menu: {
			buildFromTemplate: (template: Electron.MenuItemConstructorOptions[]) => {
				built = template;
				return {
					popup: (options: PopupOptions) => {
						popped = options;
					},
				};
			},
		},
	},
}));

const { contextMenuPoint, contextMenuTemplate, popupContextMenu } =
	await import("./contextMenu.js");

const ITEMS = [
	{ id: "rename", label: "Rename…" },
	{ id: "stop", label: "Stop Agent" },
];
const SIDEBAR = { x: 0, y: 28, width: 44, height: 600 };
const window = {} as Electron.BaseWindow;

beforeEach(() => {
	built = [];
	popped = undefined;
});

describe("the template", () => {
	it("is one item per entry, in order, with the page's ids and labels", () => {
		const chosen: string[] = [];
		const template = contextMenuTemplate(ITEMS, (id) => chosen.push(id));
		expect(template.map(({ id, label }) => ({ id, label }))).toEqual(ITEMS);
		(template[1]?.click as () => void)();
		expect(chosen).toEqual(["stop"]);
	});
});

describe("where it goes", () => {
	it("is the page's point plus where main laid the page, in whole points", () => {
		expect(contextMenuPoint({ x: 10.6, y: 4.2 }, SIDEBAR)).toEqual({
			x: 11,
			y: 32,
		});
	});
});

describe("the popup", () => {
	it("answers with the item chosen, even when the close is said first", async () => {
		const answer = popupContextMenu(
			window,
			{ items: ITEMS, at: { x: 1, y: 2 } },
			SIDEBAR,
		);
		expect(popped).toMatchObject({ x: 1, y: 30 });
		popped?.callback?.();
		(built[0]?.click as () => void)();
		await expect(answer).resolves.toBe("rename");
	});

	it("answers nothing when it is dismissed", async () => {
		const answer = popupContextMenu(
			window,
			{ items: ITEMS, at: { x: 1, y: 2 } },
			SIDEBAR,
		);
		popped?.callback?.();
		await expect(answer).resolves.toBeUndefined();
	});
});
