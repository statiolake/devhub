/**
 * A workbench's question outlives neither the person's answer nor its subject.
 *
 * The failure these cover: an SSH workspace whose remote could not be resolved
 * raised "Could not establish connection to …" over its own editor, and
 * closing the workspace destroyed the view without taking the question with
 * it. What was left was an alert about a workspace that no longer existed, on
 * an overlay layer clipped to a rectangle nothing was in, with no button that
 * could answer it — and the next attempt put another one there.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../electron.js", () => ({
	electron: { WebContentsView: class {}, shell: { openExternal: () => {} } },
}));

const shellWindowStub = { modals: undefined as unknown };
vi.mock("./shellWindow.js", () => ({
	shellWindow: () => shellWindowStub,
}));

const { ModalOverlay } = await import("./modalOverlay.js");
const { askWorkbenchDialog } = await import("./workbenchDialogs.js");
type WorkbenchView = import("./workbenchView.js").WorkbenchView;

/** Just enough of a view to end: the one event `askWorkbenchDialog` listens for. */
class FakeWorkbench {
	private readonly listeners = new Set<() => void>();
	once(event: string, listener: () => void): this {
		if (event === "closed") this.listeners.add(listener);
		return this;
	}
	off(_event: string, listener: () => void): this {
		this.listeners.delete(listener);
		return this;
	}
	/** What DevHub destroying this workbench with its workspace looks like. */
	close(): void {
		for (const listener of [...this.listeners]) listener();
	}
	get asView(): WorkbenchView {
		return this as unknown as WorkbenchView;
	}
}

describe("a workbench's question", () => {
	let modals: InstanceType<typeof ModalOverlay>;
	let view: FakeWorkbench;

	beforeEach(() => {
		modals = new ModalOverlay(
			{
				window: {
					once: () => undefined,
					isDestroyed: () => false,
				} as unknown as Electron.BrowserWindow,
				workbenchRect: () => ({ x: 0, y: 0, width: 100, height: 100 }),
				focusSurface: () => undefined,
				focusModal: () => undefined,
				modalsChanged: () => undefined,
			},
			"preload.js",
			"devhub-app://overlay/index.html",
		);
		shellWindowStub.modals = modals;
		view = new FakeWorkbench();
	});

	const ask = (surfaceKey: string): Promise<Electron.MessageBoxReturnValue> =>
		askWorkbenchDialog(
			{
				message: 'Could not establish connection to "somewhere"',
				detail: "sh: bash: not found",
				buttons: ["&&Close Remote", "Retry"],
				type: "error",
			},
			surfaceKey,
			view.asView,
		);

	it("goes away with the workspace it was about", async () => {
		const answered = ask("workspace-editor:w1");
		expect(modals.askingSurfaceKey()).toBe("workspace-editor:w1");

		view.close();

		// Settled, not left hanging: the caller inside VS Code is awaiting it,
		// and it is answered with the question's own cancel button.
		await expect(answered).resolves.toEqual({
			response: 1,
			checkboxChecked: false,
		});
		expect(modals.askingSurfaceKey()).toBeUndefined();
	});

	it("does not take another workspace's question with it", async () => {
		const other = new FakeWorkbench();
		const mine = ask("workspace-editor:w1");
		const theirs = askWorkbenchDialog(
			{ message: "elsewhere", buttons: ["OK"] },
			"workspace-editor:w2",
			other.asView,
		);

		view.close();
		await mine;

		expect(modals.askingSurfaceKey()).toBe("workspace-editor:w2");
		other.close();
		await theirs;
	});

	it("stops listening once it has been answered", async () => {
		const answered = ask("workspace-editor:w1");
		// The person pressed a button; nothing about the view is left to hear.
		modals.closeWhere(() => true);
		await answered;

		expect(() => view.close()).not.toThrow();
	});
});
