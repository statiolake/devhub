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
	focus(): void {}
	close(): void {
		this.destroyed = true;
	}
	isDestroyed(): boolean {
		return this.destroyed;
	}
	get id(): number {
		return 7;
	}
	on(): this {
		return this;
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
class FakeShell {
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

	it("is not visible once destroyed", () => {
		view.destroy();
		expect(view.isDestroyed()).toBe(true);
		expect(view.isVisible()).toBe(false);
	});
});
