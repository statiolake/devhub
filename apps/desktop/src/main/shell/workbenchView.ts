/**
 * A workbench window that is not a window.
 *
 * VS Code's `CodeWindow` builds Electron `BrowserWindowConstructorOptions` and
 * does `new BrowserWindow(options)`. DevHub shows every workbench inside the
 * one App Shell window instead, so the shim in `browserWindowShim.ts` hands
 * `CodeWindow` a `WorkbenchView`: a `WebContentsView` parented to the shell,
 * wearing the part of the `BrowserWindow` surface the main process actually
 * uses.
 *
 * The contract below is the whole of it. Anything else the workbench reaches
 * for is *not* silently answered with a no-op — the proxy logs it once, by
 * name, at warn level, because a silent no-op is how a real breakage hides.
 */

import { EventEmitter } from "node:events";
import { electron } from "../electron.js";
import type { ShellWindow } from "./shellWindow.js";

/** Members the workbench asked for that this class does not implement. */
const unimplemented = new Set<string>();

/** The members already reported, so a hot path logs once, not every frame. */
export function unimplementedMembers(): readonly string[] {
	return [...unimplemented].sort();
}

/**
 * Events that describe the view itself rather than the window around it. The
 * rest — maximize, full screen, move, resize — are facts about the shell, and
 * a workbench is entitled to hear them because they are true of it too.
 */
const VIEW_EVENTS = new Set(["focus", "blur", "responsive", "unresponsive"]);

/**
 * Events about this window's *lifetime*, which are nobody else's.
 *
 * This is the important half of the table. Sharing a fact — the window was
 * maximized, the window moved — is harmless: the listener updates something.
 * Sharing an *ending* is not, because the listener acts on it, and VS Code's
 * lifecycle acts on `close` by unloading the workbench and destroying its
 * contents. Routed to the shell window, that meant the shell's own close
 * button ran VS Code's close for every workbench: the person clicked the red
 * button and watched their editors disappear out of a window that stayed.
 *
 * A workbench view therefore emits these for itself and only for itself —
 * when DevHub destroys it with its workspace, or when VS Code closes it.
 */
const LIFETIME_EVENTS = new Set(["close", "closed", "session-end"]);

/** `BrowserWindow`'s 'closed' is `WebContents`' 'destroyed'. */
const EVENT_ALIAS: Readonly<Record<string, string>> = { closed: "destroyed" };

export class WorkbenchView {
	readonly view: Electron.WebContentsView;

	private destroyed = false;
	/**
	 * Whether something asked this window to be hidden.
	 *
	 * Not the same question as "is this the view on screen right now". A
	 * workbench view exists inside DevHub's window from the moment it is
	 * created, so it is a shown window from that moment; selecting another
	 * workspace or another activity puts it *behind* what is on screen, which
	 * for a `BrowserWindow` is being occluded, not being hidden.
	 */
	private hidden = false;
	/**
	 * What this workbench last said about its unsaved work. False until it says
	 * otherwise, which is what a workbench with nothing open means: the
	 * renderer pushes this only when a working copy changes dirty.
	 */
	private documentEdited = false;
	/**
	 * This window's own lifetime events. Not the shell's, and not another
	 * view's: an ending is about exactly one window.
	 */
	private readonly lifetime = new EventEmitter();

	constructor(
		private readonly shell: ShellWindow,
		options: Electron.BrowserWindowConstructorOptions,
	) {
		this.view = new electron.WebContentsView({
			webPreferences: options.webPreferences,
		});
		if (options.backgroundColor) {
			this.view.setBackgroundColor(options.backgroundColor);
		}
	}

	/** The view's identity everywhere in the main process. `CodeWindow` reads
	 * `this._win.id` straight into `ICodeWindow.id`, so every `getWindowById`
	 * path resolves as long as this is the webContents id. */
	get id(): number {
		return this.view.webContents.id;
	}

	get webContents(): Electron.WebContents {
		return this.view.webContents;
	}

	//#region events

	private emitterFor(event: string): NodeJS.EventEmitter {
		if (event === "closed") return this.view.webContents;
		if (VIEW_EVENTS.has(event)) return this.view.webContents;
		if (LIFETIME_EVENTS.has(event)) return this.lifetime;
		return this.shell.window;
	}

	on(event: string, listener: (...args: unknown[]) => void): this {
		this.emitterFor(event).on(EVENT_ALIAS[event] ?? event, listener);
		return this;
	}

	addListener(event: string, listener: (...args: unknown[]) => void): this {
		return this.on(event, listener);
	}

	once(event: string, listener: (...args: unknown[]) => void): this {
		this.emitterFor(event).once(EVENT_ALIAS[event] ?? event, listener);
		return this;
	}

	off(event: string, listener: (...args: unknown[]) => void): this {
		this.emitterFor(event).removeListener(
			EVENT_ALIAS[event] ?? event,
			listener,
		);
		return this;
	}

	removeListener(event: string, listener: (...args: unknown[]) => void): this {
		return this.off(event, listener);
	}

	removeAllListeners(): this {
		return this;
	}

	//#endregion

	//#region lifecycle and visibility

	loadURL(url: string, options?: Electron.LoadURLOptions): Promise<void> {
		return this.view.webContents.loadURL(url, options);
	}

	reload(): void {
		this.view.webContents.reload();
	}

	/** The shell decides what is on screen; `show()` is a request to be it. */
	show(): void {
		this.hidden = false;
		this.shell.reveal(this);
	}

	showInactive(): void {
		this.hidden = false;
		this.shell.reveal(this);
	}

	hide(): void {
		this.hidden = true;
		this.view.setVisible(false);
	}

	blur(): void {
		this.shell.window.blur();
	}

	/**
	 * VS Code asking to close its window. DevHub declines.
	 *
	 * The window is not VS Code's. `workbench.action.closeWindow` — what
	 * Command-W falls through to once the last editor tab is gone — reaches
	 * `nativeHostMainService.closeWindow`, which is `window.win?.close()` and
	 * nothing more: it does not wait for the window to go and has no
	 * expectation that it did. So declining is a complete answer, and it costs
	 * nothing upstream, because the lifecycle's own close bookkeeping hangs off
	 * a `close` event that is simply never emitted.
	 *
	 * Restarting the workbench instead would be the wrong shape of correct:
	 * seconds of rebuilding, for a keypress that meant "close a tab" in a
	 * window that had no tabs left to close. Nothing happening is what happens
	 * in VS Code itself when a window has nothing left to close.
	 *
	 * DevHub's own teardown does not come through here — it destroys the view
	 * when its workspace goes — so declining takes nothing away from it.
	 */
	close(): void {
		// Deliberately empty, and deliberately not an error: a request that is
		// refused by policy is not a failure to report.
	}

	destroy(): void {
		if (this.destroyed) {
			return;
		}
		this.destroyed = true;
		this.shell.detach(this);
		this.view.webContents.close();
	}

	isDestroyed(): boolean {
		return this.destroyed || this.view.webContents.isDestroyed();
	}

	/**
	 * What `BrowserWindow.isVisible` means: shown, and not destroyed.
	 *
	 * It must not answer "is this the selected view", however tempting that
	 * reading is. When VS Code runs from sources it waits ten seconds after a
	 * window loads and, if the window is neither visible nor minimized, treats
	 * the start as failed — it forces the window up and opens its DevTools
	 * (`windowImpl.ts`, `RunOnceScheduler(..., 10000)`). Answering `false` for
	 * a workbench the person simply is not looking at made that fire for every
	 * deselected workspace, which is where the DevTools that opened by
	 * themselves came from.
	 */
	isVisible(): boolean {
		return !this.isDestroyed() && !this.hidden;
	}

	isFocused(): boolean {
		return this.shell.window.isFocused() && this.view.webContents.isFocused();
	}

	//#endregion

	//#region window state — a view is always a plain, normal, non-modal window

	isMinimized(): boolean {
		return false;
	}

	isMaximized(): boolean {
		return false;
	}

	isFullScreen(): boolean {
		return this.shell.window.isFullScreen();
	}

	isSimpleFullScreen(): boolean {
		return false;
	}

	isNormal(): boolean {
		return true;
	}

	isModal(): boolean {
		return false;
	}

	isResizable(): boolean {
		return true;
	}

	isMovable(): boolean {
		return false;
	}

	isClosable(): boolean {
		return true;
	}

	isMinimizable(): boolean {
		return false;
	}

	isMaximizable(): boolean {
		return false;
	}

	isFullScreenable(): boolean {
		return false;
	}

	isEnabled(): boolean {
		return true;
	}

	isAlwaysOnTop(): boolean {
		return false;
	}

	/**
	 * Whether this workbench holds unsaved work.
	 *
	 * VS Code's renderer pushes this whenever its working copies change dirty
	 * (`workbench/electron-browser/window.ts` → `nativeHostService
	 * .setDocumentEdited` → `CodeWindow.setDocumentEdited` → here), which makes
	 * it the one answer about unsaved editors that main can read without asking
	 * the page anything. A `BrowserWindow` keeps it because macOS draws it as
	 * the dot in the close button; a view has no close button, so it keeps it
	 * for DevHub's close inspection instead.
	 *
	 * This pair used to be a no-op setter and a `return false` getter. That is
	 * why "Unsaved editors: Could not verify editor state" was the only thing
	 * a close could ever say: nothing recorded the answer, so nothing could
	 * report it, and the inspection fell back to not knowing.
	 */
	isDocumentEdited(): boolean {
		return this.documentEdited;
	}

	restore(): void {}
	maximize(): void {}
	unmaximize(): void {}
	minimize(): void {}
	center(): void {}
	setFullScreen(): void {}
	setSimpleFullScreen(): void {}
	setAlwaysOnTop(): void {}
	setEnabled(): void {}
	setResizable(): void {}
	setMovable(): void {}
	setClosable(): void {}
	setMinimumSize(): void {}
	setAspectRatio(): void {}
	setDocumentEdited(edited: boolean): void {
		this.documentEdited = edited;
	}
	setRepresentedFilename(): void {}
	setTouchBar(): void {}
	setMenuBarVisibility(): void {}
	setAutoHideMenuBar(): void {}
	setSheetOffset(): void {}
	setTitleBarOverlay(): void {}
	setWindowButtonVisibility(): void {}
	setWindowButtonPosition(): void {}
	setProgressBar(): void {}
	setIcon(): void {}
	setSkipTaskbar(): void {}
	setVisibleOnAllWorkspaces(): void {}
	setOpacity(): void {}
	setContentProtection(): void {}
	setParentWindow(): void {}
	flashFrame(): void {}
	addTabbedWindow(): void {}
	invalidateShadow(): void {}

	getRepresentedFilename(): string {
		return "";
	}

	getParentWindow(): Electron.BaseWindow | null {
		return null;
	}

	getChildWindows(): Electron.BaseWindow[] {
		return [];
	}

	/** DevHub owns the whole window title; a view does not get to set it. */
	setTitle(): void {}

	getTitle(): string {
		return this.view.webContents.getTitle();
	}

	//#endregion

	//#region geometry — the shell lays the view out; the view only reports

	getBounds(): Electron.Rectangle {
		const shellBounds = this.shell.window.getBounds();
		const rect = this.shell.boundsOf(this);
		return {
			x: shellBounds.x + rect.x,
			y: shellBounds.y + rect.y,
			width: rect.width,
			height: rect.height,
		};
	}

	getNormalBounds(): Electron.Rectangle {
		return this.getBounds();
	}

	getContentBounds(): Electron.Rectangle {
		return this.getBounds();
	}

	setBounds(): void {}
	setContentBounds(): void {}
	setSize(): void {}
	setPosition(): void {}

	getSize(): [number, number] {
		const rect = this.shell.boundsOf(this);
		return [rect.width, rect.height];
	}

	getContentSize(): [number, number] {
		return this.getSize();
	}

	getPosition(): [number, number] {
		const bounds = this.getBounds();
		return [bounds.x, bounds.y];
	}

	/** The workbench reads this during startup, before it has been laid out. */
	getMinimumSize(): [number, number] {
		return [400, 270];
	}

	getMaximumSize(): [number, number] {
		return [0, 0];
	}

	//#endregion

	//#region the shell's own window, borrowed

	/**
	 * There is exactly one native window, so anything asking for a native
	 * handle or a capture target gets the shell's. Callers that would parent a
	 * native sheet to it (dialogs) go through `DevHubDialogMainService`, which
	 * passes the shell `BrowserWindow` itself rather than this object.
	 */
	getNativeWindowHandle(): Buffer {
		return this.shell.window.getNativeWindowHandle();
	}

	getMediaSourceId(): string {
		return this.shell.window.getMediaSourceId();
	}

	setBackgroundColor(color: string): void {
		this.view.setBackgroundColor(color);
	}

	capturePage(rect?: Electron.Rectangle): Promise<Electron.NativeImage> {
		return this.view.webContents.capturePage(rect);
	}

	moveTop(): void {
		this.shell.reveal(this);
	}

	//#endregion
}

/**
 * The object VS Code's main process holds instead of a `BrowserWindow`.
 *
 * The proxy exists for one reason: to name, out loud and exactly once, every
 * member of the real `BrowserWindow` surface the workbench uses that the class
 * above does not implement.
 */
const proxies = new WeakMap<WorkbenchView, Electron.BrowserWindow>();

export function asBrowserWindow(view: WorkbenchView): Electron.BrowserWindow {
	const existing = proxies.get(view);
	if (existing) {
		return existing;
	}

	const proxy = new Proxy(view, {
		get(target, property, receiver) {
			if (property in target) {
				return Reflect.get(target, property, receiver);
			}
			if (typeof property === "symbol") {
				return undefined;
			}
			if (!unimplemented.has(property)) {
				unimplemented.add(property);
				console.warn(
					`[devhub] WorkbenchView: unimplemented BrowserWindow member '${property}'`,
				);
			}
			return () => undefined;
		},
		set(target, property, value) {
			Reflect.set(target, property, value);
			return true;
		},
		has() {
			return true;
		},
	});

	const window = proxy as unknown as Electron.BrowserWindow;
	proxies.set(view, window);
	return window;
}
