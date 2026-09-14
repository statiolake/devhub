/**
 * Where a dialog is attached, and what happens when there is nowhere.
 *
 * The rule under test is one sentence: whatever this service hands Electron as
 * a parent window is a real window. It is a rule and not a detail because
 * Electron does not refuse a `WorkbenchView` — `dialog.show*` decides from the
 * shape of its first argument whether it was given a parent or an options
 * object, reads the options off the view, and throws `TypeError: Invalid
 * message box type` from inside the dialog queue, uncaught, in main.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** What a view looks like to this module: whatever `workbenchViewOf` claims. */
interface FakeView {
	readonly id: number;
	readonly dead: boolean;
	isDestroyed(): boolean;
}

function fakeView(id: number, dead = false): FakeView {
	return { id, dead, isDestroyed: () => dead };
}

const SHELL_WINDOW = { shell: true } as unknown as Electron.BrowserWindow;

/** Every parent upstream's dialog service was handed, in order. */
const parents: unknown[] = [];
/** Every dialog drawn over a workbench, as `surfaceKey`. */
const overWorkbench: string[] = [];
/** Which surface key each view has, or none. */
const surfaceKeys = new Map<number, string>();

vi.mock(
	"code-oss-dev/out/vs/platform/dialogs/electron-main/dialogMainService.js",
	() => ({
		DialogMainService: class {
			showMessageBox(_options: unknown, window?: unknown): Promise<unknown> {
				parents.push(window);
				return Promise.resolve({ response: 99, checkboxChecked: false });
			}
			showSaveDialog(_options: unknown, window?: unknown): Promise<unknown> {
				parents.push(window);
				return Promise.resolve({ canceled: false });
			}
			showOpenDialog(_options: unknown, window?: unknown): Promise<unknown> {
				parents.push(window);
				return Promise.resolve({ canceled: false });
			}
		},
	}),
);
vi.mock("../shell/shellWindow.js", () => ({
	shellWindowIfCreated: () => ({ window: SHELL_WINDOW }),
}));
vi.mock("../shell/workbenchDialogs.js", () => ({
	askWorkbenchDialog: (_options: unknown, surfaceKey: string) => {
		overWorkbench.push(surfaceKey);
		return Promise.resolve({ response: 1, checkboxChecked: false });
	},
}));
vi.mock("../shell/appController.js", () => ({
	appController: () => ({
		editorSurfaceKeyForView: (id: number) => surfaceKeys.get(id),
	}),
}));
vi.mock("../shell/workbenchView.js", () => ({
	// The real one answers from the object's own identity; the stand-in answers
	// the same question the same way, which is all this module asks of it.
	workbenchViewOf: (window: unknown) =>
		window && (window as { isDestroyed?: unknown }).isDestroyed
			? (window as FakeView)
			: undefined,
}));

const { DevHubDialogMainService } = await import(
	"./devhubDialogMainService.js"
);

// The base class is mocked, so the real constructor's injected services are
// not there to be passed — and are not what this test is about.
const Service = DevHubDialogMainService as unknown as new () => unknown;

const service = () =>
	new Service() as {
		showMessageBox(
			options: Electron.MessageBoxOptions,
			window?: Electron.BrowserWindow,
		): Promise<Electron.MessageBoxReturnValue>;
		showOpenDialog(
			options: Electron.OpenDialogOptions,
			window?: Electron.BrowserWindow,
		): Promise<Electron.OpenDialogReturnValue>;
	};

const asWindow = (view: FakeView) => view as unknown as Electron.BrowserWindow;

beforeEach(() => {
	parents.length = 0;
	overWorkbench.length = 0;
	surfaceKeys.clear();
});

describe("a dialog about a workbench", () => {
	it("is drawn over the workbench it is about", async () => {
		const view = fakeView(1000002);
		surfaceKeys.set(view.id, "editor:a");
		await service().showMessageBox({ message: "save?" }, asWindow(view));
		expect(overWorkbench).toEqual(["editor:a"]);
		expect(parents).toEqual([]);
	});

	it("never reaches Electron with the view as its parent", async () => {
		// The view is alive but DevHub has not bound it to a surface yet — the
		// gap between upstream making the window and DevHub naming it. There is
		// no workbench to draw over, so it falls through, and what falls through
		// must be the real window.
		const view = fakeView(1000003);
		await service().showMessageBox({ message: "hm" }, asWindow(view));
		expect(parents).toEqual([SHELL_WINDOW]);
	});

	it("is declined when the workbench has gone", async () => {
		// Upstream asks "the window terminated unexpectedly — reopen it?" of a
		// window nobody ever saw, about a failure the Workspace's own row already
		// carries. The answer it gets back is the dialog's own cancel, so nothing
		// is told a refusal succeeded.
		const view = fakeView(1000004, true);
		const answer = await service().showMessageBox(
			{ message: "terminated", cancelId: 2 },
			asWindow(view),
		);
		expect(answer).toEqual({ response: 2, checkboxChecked: false });
		expect(parents).toEqual([]);
		expect(overWorkbench).toEqual([]);
	});

	it("takes a file picker to the one real window too", async () => {
		// A picker is genuinely the application asking, and it is the same rule
		// about parents: a view must not be one.
		await service().showOpenDialog({}, asWindow(fakeView(1000005)));
		expect(parents).toEqual([SHELL_WINDOW]);
	});

	it("leaves a real window exactly where it was", async () => {
		const real = { real: true } as unknown as Electron.BrowserWindow;
		await service().showMessageBox({ message: "about DevHub" }, real);
		expect(parents).toEqual([real]);
	});
});
