/**
 * Context menus, drawn by macOS.
 *
 * A page that offers a right-click menu says *what* is in it — an id and a
 * label per item — and main puts a native `Menu` up over the window. The page
 * then runs the item that was chosen, exactly the way its own buttons run it,
 * so the menu holds no act of its own and cannot drift from the row's.
 *
 * Native rather than a DOM menu, because a page is a `WebContentsView` and a
 * box drawn in it is clipped by it: the Sidebar's row menu used to be one, and
 * on a collapsed rail — 44px wide — it was a sliver nobody could read. A
 * native menu is a window of its own, above every view, at the platform's own
 * size and look, and it already answers the keyboard (arrows, type-to-select,
 * Return, Escape) the way every other Mac menu does — the workbench's included,
 * which are native on a Mac too. One kind of context menu in the window.
 */

import { electron } from "../electron.js";
import type {
	ContextMenuItemWire,
	ContextMenuRequestWire,
	SidebarAreaWire,
} from "../../ipc/contract.js";

/**
 * The template for a request: one item per entry, in order, each choosing
 * its own id.
 *
 * Pure, so what a page asked for and what macOS is handed can be compared
 * without a menu on screen.
 */
export function contextMenuTemplate(
	items: readonly ContextMenuItemWire[],
	choose: (id: string) => void,
): Electron.MenuItemConstructorOptions[] {
	return items.flatMap((item, index): Electron.MenuItemConstructorOptions[] => [
		// Never at the top: a separator with nothing above it is a stray line.
		...(item.separatorBefore === true && index > 0
			? [{ type: "separator" as const }]
			: []),
		{
			id: item.id,
			label: item.label,
			click: () => {
				choose(item.id);
			},
		},
	]);
}

/**
 * Where the menu goes, in the window: the page's own point plus where main
 * laid the page. Rounded, because `Menu.popup` takes whole points.
 */
export function contextMenuPoint(
	at: ContextMenuRequestWire["at"],
	origin: SidebarAreaWire,
): { readonly x: number; readonly y: number } {
	return {
		x: Math.round(origin.x + at.x),
		y: Math.round(origin.y + at.y),
	};
}

/**
 * Put the menu up and answer with the id that was chosen, or nothing when it
 * was dismissed.
 *
 * `callback` is the menu closing, which is not ordered against the chosen
 * item's `click` on every path; so a close settles one turn later, and a
 * click that arrives by then is the answer.
 */
export function popupContextMenu(
	window: Electron.BaseWindow,
	request: ContextMenuRequestWire,
	origin: SidebarAreaWire,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (id: string | undefined) => {
			if (settled) return;
			settled = true;
			resolve(id);
		};
		const menu = electron.Menu.buildFromTemplate(
			contextMenuTemplate(request.items, settle),
		);
		menu.popup({
			window,
			...contextMenuPoint(request.at, origin),
			callback: () => {
				setTimeout(() => {
					settle(undefined);
				}, 0);
			},
		});
	});
}
