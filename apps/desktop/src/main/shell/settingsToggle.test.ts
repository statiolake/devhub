/**
 * `Cmd+Q Shift+,` opens Settings, and closes it when Settings is in front.
 *
 * Before this the window had no keyboard way out at all: nothing in the menu
 * bar carries an accelerator (see `menu.ts`), no `role: "close"` item exists so
 * macOS's own `Cmd+W` does nothing, and the chord only ever showed and focused.
 * One chord, one command — the key that puts the window on screen is the key
 * that puts it away.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeWindow {
	static made: FakeWindow[] = [];
	destroyed = false;
	focused = false;
	shown = 0;
	focuses = 0;
	closes = 0;
	readonly webContents = { send: vi.fn(), isDestroyed: () => false };
	private readonly handlers = new Map<string, () => void>();

	constructor() {
		FakeWindow.made.push(this);
	}
	isDestroyed(): boolean {
		return this.destroyed;
	}
	isFocused(): boolean {
		return this.focused;
	}
	show(): void {
		this.shown += 1;
	}
	focus(): void {
		this.focuses += 1;
	}
	close(): void {
		this.closes += 1;
		this.destroyed = true;
		this.handlers.get("closed")?.();
	}
	loadURL(): Promise<void> {
		return Promise.resolve();
	}
	on(event: string, handler: () => void): void {
		this.handlers.set(event, handler);
	}
	once(event: string, handler: () => void): void {
		this.handlers.set(event, handler);
	}
}

vi.mock("../electron.js", () => ({
	electron: {
		BrowserWindow: FakeWindow,
		ipcMain: { handle: () => undefined },
	},
}));

const { installSettingsWindow, openSettingsWindow, settingsWindowIsFocused } =
	await import("./settingsWindow.js");

installSettingsWindow({
	preloadPath: "/preload.js",
} as unknown as Parameters<typeof installSettingsWindow>[0]);

beforeEach(() => {
	// Every case starts from no window, which is where the app starts.
	const open = FakeWindow.made.find((one) => !one.destroyed);
	open?.close();
	FakeWindow.made = [];
});

describe("the Settings chord", () => {
	it("makes the window the first time", () => {
		openSettingsWindow();
		expect(FakeWindow.made).toHaveLength(1);
		expect(FakeWindow.made[0].destroyed).toBe(false);
	});

	it("brings a window that is open but behind to the front", () => {
		openSettingsWindow();
		const window = FakeWindow.made[0];
		window.focused = false;

		openSettingsWindow();
		expect(FakeWindow.made).toHaveLength(1);
		expect(window.shown).toBe(1);
		expect(window.focuses).toBe(1);
		expect(window.closes).toBe(0);
	});

	it("closes the window when the window is the one in front", () => {
		openSettingsWindow();
		const window = FakeWindow.made[0];
		window.focused = true;

		openSettingsWindow();
		expect(window.closes).toBe(1);
		expect(settingsWindowIsFocused()).toBe(false);
	});

	it("opens a fresh one after that, rather than nothing", () => {
		openSettingsWindow();
		FakeWindow.made[0].focused = true;
		openSettingsWindow();

		openSettingsWindow();
		expect(FakeWindow.made).toHaveLength(2);
		expect(FakeWindow.made[1].destroyed).toBe(false);
	});
});
