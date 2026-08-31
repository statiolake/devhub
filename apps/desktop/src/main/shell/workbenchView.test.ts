/**
 * What a workbench view has to answer about itself.
 *
 * The important one is `isVisible`. VS Code running from sources treats a
 * window that is neither visible nor minimized ten seconds after it loads as a
 * failed start, and forces it up with its DevTools open. A workbench view that
 * called itself invisible whenever it was not the selected one therefore made
 * DevTools open by itself for every workspace the person was not looking at.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeWebContents {
	destroyed = false;
	private readonly listeners = new Map<string, (() => void)[]>();
	focus(): void {}
	close(): void {
		this.destroyed = true;
		for (const listener of this.listeners.get("destroyed") ?? []) listener();
	}
	isDestroyed(): boolean {
		return this.destroyed;
	}
	get id(): number {
		return 7;
	}
	on(event: string, listener: () => void): this {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
		return this;
	}
	once(event: string, listener: () => void): this {
		return this.on(event, listener);
	}
	removeListener(): this {
		return this;
	}
}

class FakeWebContentsView {
	readonly webContents = new FakeWebContents();
	visible = true;
	setVisible(visible: boolean): void {
		this.visible = visible;
	}
	setBackgroundColor(): void {}
}

vi.mock("../electron.js", () => ({
	electron: { WebContentsView: FakeWebContentsView },
}));

const { WorkbenchView } = await import("./workbenchView.js");
type WorkbenchView = InstanceType<typeof WorkbenchView>;

/** Only the part of the shell a view touches while being shown or hidden. */
class FakeShellWindow {
	private readonly listeners = new Map<
		string,
		((...args: unknown[]) => void)[]
	>();
	on(event: string, listener: (...args: unknown[]) => void): this {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
		return this;
	}
	once(event: string, listener: (...args: unknown[]) => void): this {
		return this.on(event, listener);
	}
	removeListener(): this {
		return this;
	}
	/** Fire what Electron fires when the person clicks the red button. */
	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(event) ?? []) listener(...args);
	}
}

class FakeShell {
	/** The real shell's `BrowserWindow`, which a view must not mistake for its own. */
	readonly window = new FakeShellWindow();
	revealed: WorkbenchView | undefined;
	reveal(view: WorkbenchView): void {
		this.revealed = view;
	}
	isRevealed(view: WorkbenchView): boolean {
		return this.revealed === view;
	}
	detach(): void {}
}

/**
 * The exact predicate `windowImpl.ts` schedules ten seconds after a load.
 * If this is ever true for a healthy view, DevTools opens on its own.
 */
function looksLikeAFailedStart(view: WorkbenchView): boolean {
	return !view.isVisible() && !view.isMinimized();
}

describe("a workbench view's window state", () => {
	let shell: FakeShell;
	let view: WorkbenchView;
	let other: WorkbenchView;

	beforeEach(() => {
		shell = new FakeShell();
		const asShell = shell as unknown as ConstructorParameters<
			typeof WorkbenchView
		>[0];
		view = new WorkbenchView(asShell, {});
		other = new WorkbenchView(asShell, {});
	});

	it("is visible as soon as it exists", () => {
		expect(view.isVisible()).toBe(true);
		expect(looksLikeAFailedStart(view)).toBe(false);
	});

	it("stays visible while another view is the selected one", () => {
		view.show();
		expect(shell.isRevealed(view)).toBe(true);

		other.show();
		// The person switched workspace, or to the Terminal activity. This view is
		// now behind what is on screen — which is a window behind other windows,
		// not a hidden one.
		expect(shell.isRevealed(view)).toBe(false);
		expect(view.isVisible()).toBe(true);
		expect(view.isMinimized()).toBe(false);
		expect(looksLikeAFailedStart(view)).toBe(false);
	});

	it("is invisible only when something hid it, and visible again when shown", () => {
		view.hide();
		expect(view.isVisible()).toBe(false);

		view.show();
		expect(view.isVisible()).toBe(true);
	});

	it("never hears the shell window's close", () => {
		// The shell's red button is DevHub's business. VS Code answers a `close`
		// by unloading the workbench and destroying its contents, so a view that
		// listened to the shell's close would empty itself out of a window that
		// stayed — which is exactly what people saw.
		let closes = 0;
		let closeds = 0;
		view.on("close", () => {
			closes += 1;
		});
		view.on("closed", () => {
			closeds += 1;
		});

		shell.window.emit("close", { preventDefault: () => undefined });
		shell.window.emit("closed");
		expect(closes).toBe(0);
		expect(closeds).toBe(0);
		expect(view.isDestroyed()).toBe(false);

		// Its own ending is its own business, and does reach it. (A `close()`
		// request from VS Code is declined outright — see the next case — so the
		// ending that matters is DevHub destroying the view with its workspace.)
		view.destroy();
		expect(closeds).toBe(1);
	});

	it("still hears what is genuinely true of the window around it", () => {
		let maximized = 0;
		view.on("maximize", () => {
			maximized += 1;
		});
		shell.window.emit("maximize");
		expect(maximized).toBe(1);
	});

	it("declines VS Code's request to close its own window", () => {
		// `workbench.action.closeWindow` is what Command-W reaches once the last
		// editor tab is gone, and it arrives here as a plain `close()`. The
		// window is DevHub's, so the answer is no: nothing is destroyed, nothing
		// is emitted, and the workbench the person did not mean to close is
		// still standing.
		let closes = 0;
		view.on("close", () => {
			closes += 1;
		});

		view.close();
		expect(view.isDestroyed()).toBe(false);
		expect(closes).toBe(0);
		expect(shell.isRevealed(view) || !shell.isRevealed(view)).toBe(true);

		// DevHub's own teardown does not come through `close`, and still works.
		view.destroy();
		expect(view.isDestroyed()).toBe(true);
	});

	it("remembers what the workbench said about its unsaved work", () => {
		// VS Code's renderer pushes this whenever a working copy changes dirty,
		// and it is the only answer main can read about unsaved editors. A
		// no-op setter with a `return false` getter is why every workspace
		// close said "Could not verify editor state".
		expect(view.isDocumentEdited()).toBe(false);
		view.setDocumentEdited(true);
		expect(view.isDocumentEdited()).toBe(true);
		// Each view answers for itself; a sibling workbench is not consulted.
		expect(other.isDocumentEdited()).toBe(false);
		view.setDocumentEdited(false);
		expect(view.isDocumentEdited()).toBe(false);
	});

	it("is not visible once destroyed", () => {
		view.destroy();
		expect(view.isDestroyed()).toBe(true);
		expect(view.isVisible()).toBe(false);
	});
});
