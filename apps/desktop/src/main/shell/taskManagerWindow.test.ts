/**
 * The Task Manager window: made once, brought forward, put away by the same
 * command when it is in front — as Settings is — and what each row's action
 * reaches in main.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskSnapshotWire } from "../../ipc/taskManager.js";

class FakeWindow {
	static made: FakeWindow[] = [];
	destroyed = false;
	focused = false;
	shown = 0;
	focuses = 0;
	closes = 0;
	url = "";
	readonly options: Electron.BrowserWindowConstructorOptions;
	readonly webContents = {
		send: vi.fn(),
		isDestroyed: () => false,
		on: vi.fn(),
		once: vi.fn(),
		getURL: () => "",
	};
	private readonly handlers = new Map<string, () => void>();

	constructor(options: Electron.BrowserWindowConstructorOptions) {
		this.options = options;
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
	setBackgroundColor = vi.fn();
	loadURL(url: string): Promise<void> {
		this.url = url;
		return Promise.resolve();
	}
	on(event: string, handler: () => void): void {
		this.handlers.set(event, handler);
	}
	once(event: string, handler: () => void): void {
		this.handlers.set(event, handler);
	}
}

const handlers = new Map<
	string,
	(event: unknown, ...args: unknown[]) => unknown
>();
const showMessageBox = vi.fn();
const writeText = vi.fn();

vi.mock("../electron.js", () => ({
	electron: {
		BrowserWindow: FakeWindow,
		ipcMain: {
			handle: (
				channel: string,
				handler: (event: unknown, ...args: unknown[]) => unknown,
			) => {
				handlers.set(channel, handler);
			},
		},
		dialog: { showMessageBox },
		clipboard: { writeText },
	},
}));

const {
	installTaskManagerWindow,
	openTaskManagerWindow,
	taskManagerWindowIsFocused,
	applyTaskManagerPalette,
} = await import("./taskManagerWindow.js");
const { TASK_MANAGER_CHANNELS } = await import("../../ipc/taskManager.js");

const SNAPSHOT: TaskSnapshotWire = {
	takenAt: 0,
	memoryMetric: "rss",
	system: {
		totalBytes: 16 * 1024 ** 3,
		usedBytes: 8 * 1024 ** 3,
		breakdown: {
			appBytes: 5 * 1024 ** 3,
			wiredBytes: 2 * 1024 ** 3,
			compressedBytes: 1024 ** 3,
			compressorStoredBytes: 3 * 1024 ** 3,
			cachedBytes: 4 * 1024 ** 3,
			freeBytes: 4 * 1024 ** 3,
		},
		swapUsedBytes: 0,
		swapTotalBytes: 0,
		pressure: "normal",
		pressureSource: "test",
	},
	total: {
		memoryBytes: 300 * 1024 ** 2,
		residentBytes: 300 * 1024 ** 2,
		cpuPercent: 50,
		processCount: 2,
	},
	rows: [
		{
			id: "workspace:w1",
			kind: "workspace",
			label: "widget",
			memoryBytes: 300 * 1024 ** 2,
			residentBytes: 300 * 1024 ** 2,
			cpuPercent: 50,
			processCount: 2,
			actions: ["reveal"],
			workspaceId: "w1",
			children: [
				{
					id: "pid:122",
					kind: "process",
					label: "rust-analyzer",
					detail: "/x/rust-analyzer",
					pid: 122,
					memoryBytes: 200 * 1024 ** 2,
					residentBytes: 200 * 1024 ** 2,
					cpuPercent: 48,
					processCount: 1,
					actions: ["kill"],
					children: [],
				},
				{
					id: "pid:120",
					kind: "process",
					label: "Renderer",
					detail: "/x/Helper --type=renderer",
					pid: 120,
					memoryBytes: 100 * 1024 ** 2,
					residentBytes: 100 * 1024 ** 2,
					cpuPercent: 2,
					processCount: 1,
					actions: [],
					children: [],
				},
			],
		},
	],
};

const host = {
	preloadPath: "/preload/taskManager.js",
	snapshot: vi.fn(() => Promise.resolve(SNAPSHOT)),
	commandOf: vi.fn(
		(): Promise<string | undefined> => Promise.resolve("/x/rust-analyzer"),
	),
	stopAgent: vi.fn(),
	reveal: vi.fn(),
	signal: vi.fn(),
};
installTaskManagerWindow(host);

const call = (channel: string, ...args: unknown[]) =>
	handlers.get(channel)!({}, ...args);

beforeEach(() => {
	FakeWindow.made.find((one) => !one.destroyed)?.close();
	FakeWindow.made = [];
	vi.clearAllMocks();
});

describe("opening the Task Manager", () => {
	it("makes its own window, with its own page and preload", () => {
		openTaskManagerWindow();
		expect(FakeWindow.made).toHaveLength(1);
		const [window] = FakeWindow.made;
		expect(window!.url).toBe("devhub-app://shell/task-manager.html");
		expect(window!.options.title).toBe("DevHub Task Manager");
		expect(window!.options.webPreferences?.preload).toBe(
			"/preload/taskManager.js",
		);
	});

	it("brings an open one forward rather than making a second", () => {
		openTaskManagerWindow();
		openTaskManagerWindow();
		expect(FakeWindow.made).toHaveLength(1);
		expect(FakeWindow.made[0]!.focuses).toBe(1);
	});

	it("closes it when it is the window in front, and makes a fresh one after", () => {
		openTaskManagerWindow();
		FakeWindow.made[0]!.focused = true;
		expect(taskManagerWindowIsFocused()).toBe(true);
		openTaskManagerWindow();
		expect(FakeWindow.made[0]!.closes).toBe(1);
		openTaskManagerWindow();
		expect(FakeWindow.made).toHaveLength(2);
	});

	it("wears a new theme, its ground and its page", () => {
		openTaskManagerWindow();
		applyTaskManagerPalette({ canvas: "#123456" } as never);
		const [window] = FakeWindow.made;
		expect(window!.setBackgroundColor).toHaveBeenCalledWith("#123456");
		expect(window!.webContents.send).toHaveBeenCalledWith(
			"devhub:theme-changed",
			{ canvas: "#123456" },
		);
	});
});

describe("what a row can do", () => {
	it("hands Stop and Show to the paths DevHub already has", async () => {
		await call(TASK_MANAGER_CHANNELS.stopAgent, "a1");
		await call(TASK_MANAGER_CHANNELS.reveal, { kind: "agent", agentId: "a1" });
		expect(host.stopAgent).toHaveBeenCalledWith("a1");
		expect(host.reveal).toHaveBeenCalledWith({ kind: "agent", agentId: "a1" });
	});

	it("ends a process only after asking, with SIGTERM to that one pid", async () => {
		openTaskManagerWindow();
		await call(TASK_MANAGER_CHANNELS.snapshot);
		showMessageBox.mockResolvedValueOnce({ response: 0 });
		await expect(call(TASK_MANAGER_CHANNELS.kill, 122)).resolves.toBe(true);
		expect(showMessageBox).toHaveBeenCalledTimes(1);
		expect(showMessageBox.mock.calls[0]![1].message).toBe(
			"End “rust-analyzer”?",
		);
		expect(host.signal).toHaveBeenCalledWith(122);
	});

	it("ends nothing when the person says no", async () => {
		await call(TASK_MANAGER_CHANNELS.snapshot);
		showMessageBox.mockResolvedValueOnce({ response: 1 });
		await expect(call(TASK_MANAGER_CHANNELS.kill, 122)).resolves.toBe(false);
		expect(host.signal).not.toHaveBeenCalled();
	});

	it("never ends a process its row did not offer it for — DevHub's own", async () => {
		await call(TASK_MANAGER_CHANNELS.snapshot);
		await expect(call(TASK_MANAGER_CHANNELS.kill, 120)).rejects.toThrow(
			"not one the Task Manager may end",
		);
		await expect(call(TASK_MANAGER_CHANNELS.kill, 999)).rejects.toThrow();
		expect(showMessageBox).not.toHaveBeenCalled();
		expect(host.signal).not.toHaveBeenCalled();
	});

	it("leaves a pid alone that runs something else by the time it is answered", async () => {
		await call(TASK_MANAGER_CHANNELS.snapshot);
		showMessageBox.mockResolvedValueOnce({ response: 0 });
		host.commandOf.mockResolvedValueOnce("/usr/bin/somebody-else");
		await expect(call(TASK_MANAGER_CHANNELS.kill, 122)).rejects.toThrow(
			"running something else now",
		);
		expect(host.signal).not.toHaveBeenCalled();
	});

	it("copies the table as text", async () => {
		await call(TASK_MANAGER_CHANNELS.snapshot);
		await call(TASK_MANAGER_CHANNELS.copy);
		const [text] = writeText.mock.calls[0] as [string];
		expect(text).toContain("DevHub Task Manager");
		expect(text).toContain("rust-analyzer [122]");
	});
});
