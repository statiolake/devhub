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
 * rest — maximize, full screen, move, resize — are facts about the shell.
 */
const VIEW_EVENTS = new Set(["focus", "blur", "responsive", "unresponsive"]);

/** `BrowserWindow`'s 'closed' is `WebContents`' 'destroyed'. */
const EVENT_ALIAS: Readonly<Record<string, string>> = { closed: "destroyed" };

export class WorkbenchView {
	readonly view: Electron.WebContentsView;

	private destroyed = false;

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
		return VIEW_EVENTS.has(event) || event === "closed"
			? this.view.webContents
			: this.shell.window;
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
		this.shell.reveal(this);
	}

	showInactive(): void {
		this.shell.reveal(this);
	}

	hide(): void {
		this.view.setVisible(false);
	}

	focus(): void {
		this.shell.window.focus();
		this.view.webContents.focus();
	}

	blur(): void {
		this.shell.window.blur();
	}

	close(): void {
		this.destroy();
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

	isVisible(): boolean {
		return !this.destroyed && this.shell.isRevealed(this);
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

	isDocumentEdited(): boolean {
		return false;
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
	setDocumentEdited(): void {}
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
