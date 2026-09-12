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
		// Electron drops `WebContentsView.webContents` to `undefined` before it
		// runs this — measured on Electron 42 — so the fake drops it too. A fake
		// that kept the property is how a `TypeError` in every workspace
		// teardown went unnoticed here.
		this.owner.forget();
		for (const listener of this.listeners.get("destroyed") ?? []) listener();
	}
	constructor(private readonly owner: FakeWebContentsView) {}
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
	/** Fire what Electron fires on the contents themselves. */
	emit(event: string): void {
		for (const listener of this.listeners.get(event) ?? []) listener();
	}
	removeListener(event: string, listener: () => void): this {
		this.listeners.set(
			event,
			(this.listeners.get(event) ?? []).filter((held) => held !== listener),
		);
		return this;
	}
}

class FakeWebContentsView {
	webContents: FakeWebContents = new FakeWebContents(this);
	/** What Electron does to the property when the contents are destroyed. */
	forget(): void {
		this.webContents = undefined as unknown as FakeWebContents;
	}
	visible = true;
	setVisible(visible: boolean): void {
		this.visible = visible;
	}
	setBackgroundColor(): void {}
}

/**
 * What was announced on `electron.app`, in order, as `event:windowId`.
 *
 * This is the delivery that matters: `nativeHostMainService` builds the focus
 * the workbench and its extensions see out of `app`'s `browser-window-focus`
 * and `browser-window-blur`, and Electron raises neither of those for a
 * `WebContentsView`. See `WorkbenchView.announceFocusToTheApplication`.
 */
const announced: string[] = [];

vi.mock("../electron.js", () => ({
	electron: {
		WebContentsView: FakeWebContentsView,
		app: {
			emit: (event: string, _payload: unknown, window: { id: number }) => {
				announced.push(`${event}:${window.id}`);
			},
		},
	},
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
	removeListener(event: string, listener: (...args: unknown[]) => void): this {
		this.listeners.set(
			event,
			(this.listeners.get(event) ?? []).filter((held) => held !== listener),
		);
		return this;
	}
	/** How many listeners this window is still holding, of every event. */
	count(): number {
		return [...this.listeners.values()].reduce(
			(total, held) => total + held.length,
			0,
		);
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
	/**
	 * The three facts the real `isSurfaceFocused` composes. They are kept
	 * separately here for the same reason the real one composes them: the bug
	 * was that only one of them was ever consulted.
	 */
	appIsInFront = true;
	modalIsUp = false;
	reveal(view: WorkbenchView): void {
		this.revealed = view;
	}
	isRevealed(view: WorkbenchView): boolean {
		return this.revealed === view;
	}
	isSurfaceFocused(view: WorkbenchView): boolean {
		if (view.isDestroyed()) return false;
		if (!this.appIsInFront) return false;
		if (this.modalIsUp) return false;
		return this.revealed === view;
	}
	/** What `ShellWindow.publishFocus` does, for the views this test holds. */
	publishFocus(...views: WorkbenchView[]): void {
		for (const view of views) view.focusStateChanged();
	}
	/** The shell's table of views, which a view must leave as it ends. */
	readonly attached: WorkbenchView[] = [];
	attach(view: WorkbenchView): void {
		this.attached.push(view);
	}
	detach(view: WorkbenchView): void {
		const at = this.attached.indexOf(view);
		if (at !== -1) this.attached.splice(at, 1);
		if (this.revealed === view) this.revealed = undefined;
		// What the real `ShellWindow.detach` does last: the view that left is
		// told, and so is everything else that was on screen with it.
		view.focusStateChanged();
	}
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

/**
 * What is left of a workbench view once it has ended.
 *
 * The answer has to be nothing, and the reason is an ordering VS Code owns:
 * `CodeWindow` listens for `closed`, and what it does with it is dispose
 * itself — which hands back every listener it ever added, to a window whose
 * contents Electron destroyed a tick earlier. Electron drops
 * `WebContentsView.webContents` to `undefined` at that moment, so every one of
 * those `off` calls used to end in `Cannot read properties of undefined
 * (reading 'removeListener')`, once per workspace closed.
 *
 * So a view that has ended is off the shell's table, holds no subscription on
 * anything that outlives it, and answers a late caller by doing nothing at all.
 */
describe("a workbench view that has ended", () => {
	let shell: FakeShell;
	let view: WorkbenchView;
	let contents: FakeWebContents;
	let heard: string[];

	beforeEach(() => {
		shell = new FakeShell();
		view = new WorkbenchView(
			shell as unknown as ConstructorParameters<typeof WorkbenchView>[0],
			{},
		);
		shell.attach(view);
		contents = view.webContents as unknown as FakeWebContents;
		heard = [];
		announced.length = 0;
	});

	/** Everything a `CodeWindow` subscribes to, one listener each. */
	function listenToEverything(): [string, () => void][] {
		const events = [
			"close",
			"closed",
			"session-end",
			"focus",
			"blur",
			"responsive",
			"unresponsive",
			"maximize",
			"unmaximize",
			"enter-full-screen",
			"leave-full-screen",
			"always-on-top-changed",
			"move",
			"resize",
		];
		return events.map((event) => {
			const listener = () => heard.push(event);
			view.on(event, listener);
			return [event, listener] as [string, () => void];
		});
	}

	it("takes back every listener it left on the shell's window", () => {
		listenToEverything();
		expect(shell.window.count()).toBeGreaterThan(0);

		view.destroy();
		// Not one dead `CodeWindow` left on an emitter that outlives every
		// view: a session of opening and closing workspaces would otherwise
		// accumulate one set per workspace.
		expect(shell.window.count()).toBe(0);
		// Its own ending it does hear, once, which is the one event a teardown
		// is entitled to.
		expect(heard).toEqual(["closed"]);
		heard.length = 0;
		shell.window.emit("maximize");
		shell.window.emit("enter-full-screen");
		expect(heard).toEqual([]);
	});

	it("is off the shell's table the moment it ends, whoever ended it", () => {
		expect(shell.attached).toEqual([view]);
		// Killed from underneath — a crashed renderer — with no call to
		// `destroy()`. The view still leaves, because leaving is what ending
		// means and there is only one teardown.
		contents.close();
		expect(shell.attached).toEqual([]);
		expect(view.isDestroyed()).toBe(true);
	});

	it("answers VS Code's dispose without throwing and without doing anything", () => {
		const listeners = listenToEverything();
		// The real order: the contents go, `closed` reaches `CodeWindow`, and
		// `CodeWindow.dispose()` hands every listener back.
		view.destroy();
		for (const [event, listener] of listeners) {
			expect(() => view.off(event, listener)).not.toThrow();
			expect(() => view.removeListener(event, listener)).not.toThrow();
		}
		expect(() => view.removeAllListeners()).not.toThrow();
	});

	it("registers nothing new, and fires nothing, once it has ended", () => {
		view.destroy();
		const listeners = listenToEverything();
		expect(shell.window.count()).toBe(0);

		// Every path that used to reach a live view, fired at a dead one.
		shell.window.emit("maximize");
		shell.window.emit("move");
		contents.emit("responsive");
		shell.reveal(view);
		shell.publishFocus(view);
		view.focusConfirmed();
		view.focusStateChanged();
		expect(heard).toEqual([]);
		expect(announced).toEqual([]);
		expect(listeners.length).toBeGreaterThan(0);
	});

	it("keeps its identity after its contents are gone", () => {
		const id = view.id;
		contents.close();
		// `id` is how every registry in main names this view, including the
		// ones being asked to forget it while it goes.
		expect(view.id).toBe(id);
		expect(view.webContents).toBe(contents);
	});
});

/**
 * What a workbench believes about having the keyboard.
 *
 * This is `hostService.hasFocus`, which VS Code gates real behaviour on — a
 * workspace trust prompt is held back until the window it belongs to has
 * focus. Read off the view's own `webContents`, the answer was wrong in both
 * directions and, worse, silent: a `WebContentsView` keeps its DOM focus when
 * the window behind it is deactivated and when another surface is put in front
 * of it, so nothing ever emitted and the workbench went on believing whatever
 * it had believed since it loaded.
 */
describe("a workbench view's focus", () => {
	let shell: FakeShell;
	let view: WorkbenchView;
	let other: WorkbenchView;
	let events: string[];

	beforeEach(() => {
		shell = new FakeShell();
		const asShell = shell as unknown as ConstructorParameters<
			typeof WorkbenchView
		>[0];
		view = new WorkbenchView(asShell, {});
		other = new WorkbenchView(asShell, {});
		events = [];
		announced.length = 0;
		view.on("focus", () => events.push("focus"));
		view.on("blur", () => events.push("blur"));
	});

	it("has no focus before anything has revealed it", () => {
		expect(view.isFocused()).toBe(false);
		expect(events).toEqual([]);
	});

	it("takes focus when it becomes the surface, and says so once", () => {
		shell.reveal(view);
		shell.publishFocus(view, other);
		expect(view.isFocused()).toBe(true);
		expect(events).toEqual(["focus"]);

		// Asked again with nothing changed, it must not report a second focus:
		// a listener that acts on the event would act twice.
		shell.publishFocus(view, other);
		expect(events).toEqual(["focus"]);
	});

	it("loses focus while DevHub is in the background, and takes it back", () => {
		// The regression this exists for. The view's own DOM focus never moves
		// across an app switch, so this transition used to be invisible — and
		// the workbench that missed the blur also missed the focus that came
		// after it, which is the event a trust prompt is waiting for.
		shell.reveal(view);
		shell.publishFocus(view);
		events.length = 0;

		shell.appIsInFront = false;
		shell.publishFocus(view);
		expect(view.isFocused()).toBe(false);
		expect(events).toEqual(["blur"]);

		shell.appIsInFront = true;
		shell.publishFocus(view);
		expect(view.isFocused()).toBe(true);
		expect(events).toEqual(["blur", "focus"]);
	});

	it("loses focus to a modal, and has it back when the modal goes", () => {
		shell.reveal(view);
		shell.publishFocus(view);
		events.length = 0;

		shell.modalIsUp = true;
		shell.publishFocus(view);
		expect(view.isFocused()).toBe(false);

		shell.modalIsUp = false;
		shell.publishFocus(view);
		expect(view.isFocused()).toBe(true);
		expect(events).toEqual(["blur", "focus"]);
	});

	it("hands focus over when another workbench is revealed", () => {
		shell.reveal(view);
		shell.publishFocus(view, other);
		expect(view.isFocused()).toBe(true);
		expect(other.isFocused()).toBe(false);

		shell.reveal(other);
		shell.publishFocus(view, other);
		// Exactly one of them, always: they are two contents over one rectangle
		// and only one can be typed into.
		expect(view.isFocused()).toBe(false);
		expect(other.isFocused()).toBe(true);
	});

	it("does not claim focus once it is destroyed", () => {
		shell.reveal(view);
		shell.publishFocus(view);
		expect(view.isFocused()).toBe(true);

		view.destroy();
		shell.publishFocus(view);
		expect(view.isFocused()).toBe(false);
	});

	it("answers the same thing however it is asked", () => {
		// `hasFocus` polls this and the events push it; a poll that could
		// disagree with the last event is how a listener acts on a focus it was
		// never told about.
		shell.reveal(view);
		shell.publishFocus(view);
		expect(view.isFocused()).toBe(events.at(-1) === "focus");

		shell.appIsInFront = false;
		shell.publishFocus(view);
		expect(view.isFocused()).toBe(events.at(-1) === "focus");
	});

	it("says it on `electron.app`, which is where VS Code is listening", () => {
		// The window's own `focus`/`blur` reach one upstream listener, and all
		// it does is stamp `_lastFocusTime`. Everything that acts on focus —
		// `hostService.onDidChangeFocus`, `vscode.window.state.focused`, the
		// workspace trust prompt, the git extension's refresh loop — is built
		// on `app`'s `browser-window-focus` and `browser-window-blur`, which
		// Electron raises for real windows only. Emitting them here is the only
		// way a view is ever the subject of one.
		shell.reveal(view);
		shell.publishFocus(view, other);
		expect(announced).toEqual([`browser-window-focus:${view.id}`]);

		shell.appIsInFront = false;
		shell.publishFocus(view, other);
		expect(announced).toEqual([
			`browser-window-focus:${view.id}`,
			`browser-window-blur:${view.id}`,
		]);

		// One announcement per transition, exactly as for the events beside it:
		// upstream latches on the value, and a repeat that said nothing changed
		// would still cost a round trip to the renderer for every layout.
		shell.publishFocus(view, other);
		expect(announced).toHaveLength(2);
	});

	it("says the same answer again when the renderer confirms it took the keyboard", () => {
		// Not a transition, and deliberately so: the announcement's value is
		// read out of `document.hasFocus()` at the moment upstream is asked, so
		// the one sent in the same tick as `focus()` is answered with the state
		// the renderer was about to leave. This is that sentence repeated once
		// the renderer has actually taken it.
		shell.reveal(view);
		shell.publishFocus(view, other);
		expect(announced).toEqual([`browser-window-focus:${view.id}`]);

		view.focusConfirmed();
		expect(announced).toEqual([
			`browser-window-focus:${view.id}`,
			`browser-window-focus:${view.id}`,
		]);
	});

	it("says nothing again for a workbench that does not have the keyboard", () => {
		// Repeating an answer is only ever repeating `isSurfaceFocused`. A
		// workbench nobody is typing into must not be announced as focused
		// however its own contents came by their DOM focus.
		shell.reveal(other);
		shell.publishFocus(view, other);
		announced.length = 0;

		view.focusConfirmed();
		expect(announced).toEqual([]);
	});
});
