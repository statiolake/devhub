/**
 * The one real window DevHub has.
 *
 * It shows the App Shell page — sidebar, titlebar, error area — and hosts every
 * workbench as a `WebContentsView` laid into the content rectangle the page
 * reports. There is one way to put a workbench on screen (`reveal`) and one
 * way to size it (`layout`); the page never positions anything itself.
 */

import { electron } from "../electron.js";
import type { ContentRect } from "../../ipc/contract.js";
import type { WorkbenchView } from "./workbenchView.js";

export class ShellWindow {
	readonly window: Electron.BrowserWindow;

	private readonly views: WorkbenchView[] = [];
	private revealed: WorkbenchView | undefined;
	private contentRect: ContentRect | undefined;

	constructor(preloadPath: string, pageUrl: string) {
		this.window = new electron.BrowserWindow({
			width: 1440,
			height: 900,
			minWidth: 720,
			minHeight: 480,
			title: "DevHub",
			// The Tauri app's chrome: the page paints the titlebar band itself
			// over the window's own material, and the traffic lights sit on the
			// sidebar rather than above it.
			titleBarStyle: "hiddenInset",
			vibrancy: "sidebar",
			backgroundColor: "#00000000",
			show: false,
			webPreferences: {
				preload: preloadPath,
				sandbox: false,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});

		this.window.loadURL(pageUrl);
		this.window.once("ready-to-show", () => this.window.show());
		this.window.on("resize", () => this.layout());
		this.window.on("closed", () => electron.app.quit());
	}

	//#region the views

	attach(view: WorkbenchView): void {
		this.views.push(view);
		this.window.contentView.addChildView(view.view);
		this.reveal(view);
	}

	detach(view: WorkbenchView): void {
		const index = this.views.indexOf(view);
		if (index === -1) {
			return;
		}
		this.views.splice(index, 1);
		this.window.contentView.removeChildView(view.view);
		if (this.revealed === view) {
			this.revealed = this.views.at(-1);
		}
		this.layout();
	}

	getViews(): readonly WorkbenchView[] {
		return this.views;
	}

	getViewById(id: number): WorkbenchView | undefined {
		return this.views.find((view) => view.id === id);
	}

	/** Exactly one view is on screen at a time; this says which. */
	reveal(view: WorkbenchView): void {
		this.revealed = view;
		this.layout();
	}

	isRevealed(view: WorkbenchView): boolean {
		return this.revealed === view;
	}

	//#endregion

	//#region layout

	/** The page measures its own content area and tells main where it is. */
	setContentRect(rect: ContentRect): void {
		this.contentRect = rect;
		this.layout();
	}

	boundsOf(_view: WorkbenchView): Electron.Rectangle {
		return this.currentRect();
	}

	private currentRect(): Electron.Rectangle {
		if (this.contentRect) {
			return {
				x: Math.round(this.contentRect.x),
				y: Math.round(this.contentRect.y),
				width: Math.round(this.contentRect.width),
				height: Math.round(this.contentRect.height),
			};
		}

		// Until the page has measured itself, the whole content area is the
		// honest answer: a zero-sized view would make the workbench lay itself
		// out against nothing and never recover.
		const [width, height] = this.window.getContentSize();
		return { x: 0, y: 0, width, height };
	}

	layout(): void {
		if (this.window.isDestroyed()) {
			return;
		}
		const bounds = this.currentRect();
		for (const view of this.views) {
			view.view.setBounds(bounds);
			view.view.setVisible(view === this.revealed);
		}
	}

	//#endregion
}

let current: ShellWindow | undefined;

export function createShellWindow(
	preloadPath: string,
	pageUrl: string,
): ShellWindow {
	if (current) {
		throw new Error("the App Shell window already exists");
	}
	current = new ShellWindow(preloadPath, pageUrl);
	return current;
}

/** The shell must exist before any workbench does; not having one is a bug. */
export function shellWindow(): ShellWindow {
	if (!current) {
		throw new Error("the App Shell window has not been created yet");
	}
	return current;
}

export function shellWindowIfCreated(): ShellWindow | undefined {
	return current;
}
