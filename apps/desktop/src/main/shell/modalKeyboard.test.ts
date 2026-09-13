/**
 * A sheet on screen is a sheet that can be typed into.
 *
 * The failure these cover: the Issue flow's prompt-review sheet came up with
 * its textarea drawn as the focused field and the keyboard somewhere else, so
 * the person had to click into it before they could type. Measured on an
 * isolated instance, the keyboard was in the App Shell page while the sheet
 * stood, and it was a race rather than a missing call — the modal layer asked
 * for the keyboard exactly once, on the pass where it arrived, and
 * `placeKeyboardIn` declines while DevHub is not the front app. Whether a
 * sheet could be typed into therefore depended on where the window happened to
 * be at that instant, and nothing ever asked again.
 *
 * So what is asserted here is the state, not the call: whenever the layer is
 * on screen without the keyboard, the next pass puts it back — and when it
 * already has it, nothing moves.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeWebContents {
	focused = false;
	destroyed = false;
	readonly sent: unknown[] = [];
	isFocused(): boolean {
		return this.focused;
	}
	isDestroyed(): boolean {
		return this.destroyed;
	}
	send(_channel: string, payload: unknown): void {
		this.sent.push(payload);
	}
	on(): this {
		return this;
	}
	setWindowOpenHandler(): void {}
	loadURL(): Promise<void> {
		return Promise.resolve();
	}
}

class FakeWebContentsView {
	readonly webContents = new FakeWebContents();
	setBounds(): void {}
	setBackgroundColor(): void {}
}

vi.mock("../electron.js", () => ({
	electron: {
		WebContentsView: FakeWebContentsView,
		shell: { openExternal: () => {} },
	},
}));

const { ModalOverlay } = await import("./modalOverlay.js");

describe("the keyboard while a sheet stands", () => {
	let modals: InstanceType<typeof ModalOverlay>;
	/** Every contents `focusModal` was asked to put the keyboard in, in order. */
	let placed: FakeWebContents[];
	let added: number;
	let windowIsFront: boolean;

	beforeEach(() => {
		placed = [];
		added = 0;
		windowIsFront = true;
		modals = new ModalOverlay(
			{
				window: {
					once: () => undefined,
					isDestroyed: () => false,
					getContentSize: () => [800, 600],
					contentView: {
						addChildView: () => {
							added += 1;
						},
						removeChildView: () => undefined,
					},
				} as unknown as Electron.BrowserWindow,
				workbenchRect: () => ({ x: 0, y: 0, width: 100, height: 100 }),
				focusSurface: () => undefined,
				// The real gate: `ShellWindow.placeKeyboardIn` declines outright
				// while another window is in front, and says nothing about it.
				focusModal: (contents) => {
					const fake = contents as unknown as FakeWebContents;
					placed.push(fake);
					if (windowIsFront) fake.focused = true;
				},
				modalsChanged: () => modals.reposition(),
			},
			"preload.js",
			"devhub-app://shell/index.html?window=overlay",
		);
	});

	const overlay = (): FakeWebContents =>
		modals.contents() as unknown as FakeWebContents;

	it("places the keyboard in the layer when the first sheet opens", () => {
		modals.openModal({ kind: "chord-help", rows: [] });

		expect(placed).toEqual([overlay()]);
		expect(overlay().focused).toBe(true);
	});

	it("places it again for a sheet opened over another one", () => {
		modals.openModal({ kind: "chord-help", rows: [] });
		// What the losing order looks like: the layer is up, and something
		// outside it has the keyboard when the second sheet arrives. In the
		// Issue flow that something is the App Shell page, and the second sheet
		// is the prompt review opened while the wizard is still on screen.
		overlay().focused = false;

		modals.openModal({ kind: "tab-picker" });

		expect(placed).toHaveLength(2);
		expect(overlay().focused).toBe(true);
	});

	it("asks again on a later pass when the first ask was declined", () => {
		// DevHub is not the front app: the sheet goes up and the keyboard does
		// not move. This is the case that used to be unrecoverable.
		windowIsFront = false;
		modals.openModal({ kind: "chord-help", rows: [] });
		expect(overlay().focused).toBe(false);

		windowIsFront = true;
		modals.reposition();

		expect(placed).toHaveLength(2);
		expect(overlay().focused).toBe(true);
	});

	it("leaves the keyboard alone once the layer has it", () => {
		modals.openModal({ kind: "chord-help", rows: [] });
		const before = placed.length;

		// Every layout repositions the layer — a window resize, a sidebar drag,
		// a workbench being revealed behind the sheet.
		modals.reposition();
		modals.reposition();

		expect(placed).toHaveLength(before);
		expect(added).toBeGreaterThan(before);
	});

	it("stops asking once the last sheet is gone", () => {
		const id = modals.openModal({ kind: "chord-help", rows: [] });
		const before = placed.length;

		modals.closeModal(id);
		modals.reposition();

		expect(modals.isPresent()).toBe(false);
		expect(placed).toHaveLength(before);
	});
});
