/**
 * Every DevHub modal, one layer above everything else.
 *
 * A `WebContentsView` always paints above the window's own document, so a
 * modal drawn by the App Shell page is invisible behind a workbench while
 * still holding the keyboard. Taking the workbench off screen for the duration
 * — or painting a snapshot of it under the sheet — reconstructs the stacking
 * by hand, and has to be redone for every new kind of thing the viewport can
 * hold.
 *
 * So DevHub does not reconstruct it. There is one transparent view, the last
 * child of the window and therefore the topmost, whose page draws the modals
 * and nothing else.
 *
 * The view is built once, at startup, never destroyed, and never taken out
 * of the window. What follows the modals is *where* it is: over the window
 * (or one workbench) while something is asked, and parked all but one
 * pixel outside the window's corner while nothing is, where it takes no click
 * but is still laid out at the window's size and still painting. It used to be added and
 * removed instead, and a view out of the window is a hidden page that paints
 * nothing: the first question of a session waited for a first layout, and
 * every later one opened on a frame of the previous sheet. See `parkedRect`
 * in `windowLayout.ts`.
 *
 * The dim behind a question is the view's own background, not something the
 * page draws — see `scrimColor`.
 *
 * Main owns the set that is open, because two unrelated things open modals —
 * the App Shell page, and a workbench asking its own question through Electron
 * — and each answer has to find its way back to whichever asked.
 */

import { randomUUID } from "node:crypto";
import { electron } from "../electron.js";
import { sendLinksToTheBrowser } from "./externalLinks.js";
import {
	CHANNELS,
	type ModalRequest,
	type OpenModal,
} from "../../ipc/contract.js";
import type { PickerScope } from "./windowLayout.js";

export interface PickerViewHost {
	readonly window: Electron.BrowserWindow;
	/**
	 * Put the keyboard back where it belongs, and say so.
	 *
	 * The window's one answer to "where do the keys go" — the workbench on
	 * screen, or the App Shell page when none is. Asking the window rather
	 * than remembering who was focused when the modal opened is what makes
	 * this correct: Electron reports no focused `webContents` for a child view
	 * at all, so "put back what I took" quietly meant "give it to the page",
	 * and typing after closing a sheet went nowhere near the editor.
	 *
	 * It is the whole of `focusSurface` rather than just the contents to
	 * focus, because moving the keyboard and reporting that it moved are one
	 * act everywhere else in this window, and a layer that did only the first
	 * half left every workbench believing a modal still stood in front of it.
	 */
	focusSurface(): void;
	/**
	 * Put the keyboard in the modal layer itself.
	 *
	 * Through the window rather than by calling `focus()` here, because
	 * `webContents.focus()` makes the window key on macOS: a sheet opening is
	 * a reason to type into this window, never a reason to pull it in front of
	 * the Settings window or another app. See
	 * `ShellWindow.placeKeyboardIn`.
	 */
	focusModal(contents: Electron.WebContents): void;
	/**
	 * The set that is open has changed.
	 *
	 * The window lays itself out again, because what a modal is *over* is part
	 * of that layout: a workbench under its own question stays on screen.
	 */
	modalsChanged(): void;
}

/** The layer's background while nothing is asked. */
const CLEAR = "#00000000";

/** A workbench's question, waiting for the button the person presses. */
type Settle = (response: number) => void;

/**
 * What makes two modals the same question.
 *
 * Asking the same thing twice is not two questions: a second question from one
 * editor replaces the first, exactly as VS Code's own serial dialogs do, and a
 * second "close this workspace?" is the same confirmation being re-raised
 * while the first is still up. Without this a double click leaves two sheets
 * stacked on one answer.
 */
function identity(request: ModalRequest): string {
	switch (request.kind) {
		case "workbench-dialog":
			return `${request.kind}:${request.surfaceKey}`;
		case "agent-rename":
			return `${request.kind}:${request.agentId}`;
		// One sheet per intent, not per agent. Two messages queued for one agent
		// are two different sentences to agree to, and answering the second by
		// throwing the first away would send whichever survived without anybody
		// having read it.
		case "injection-review":
			return `${request.kind}:${request.injectionId}`;
		case "agent-picker":
			return `${request.kind}:${request.workspaceId}`;
		default:
			return request.kind;
	}
}

export class PickerView {
	private readonly view: Electron.WebContentsView;
	private readonly pageUrl: string;
	private present = false;
	private background: string = CLEAR;
	private readonly open: OpenModal[] = [];
	private readonly pending = new Map<string, Settle>();
	private published: string | undefined;

	constructor(preloadPath: string, pageUrl: string) {
		this.view = new electron.WebContentsView({
			webPreferences: {
				preload: preloadPath,
				sandbox: false,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});
		// The layer is a hole with modals in it: everything the person can see
		// through it is a real, live workbench, not a picture of one. The dim
		// is added while a question stands; see `place`.
		this.view.setBackgroundColor(CLEAR);
		// This page draws DevHub's own modals and nothing else; a link in one
		// leaves through the browser like every other link. Every child page
		// needs this — a page that forgets it can mint a second window wearing
		// DevHub's preload. See `externalLinks.ts`.
		sendLinksToTheBrowser(this.view.webContents);
		this.view.webContents.on("did-finish-load", () => {
			// The page starts empty and is told what to draw; a reload has to
			// be told again, or the layer is up with nothing on it.
			this.published = undefined;
			this.publish(this.open);
		});
		this.pageUrl = pageUrl;
	}

	/**
	 * Run the page. Not at construction: the window owns when its pages run,
	 * and runs them all at once, when everything they ask for exists — see
	 * `ShellWindow.openPage`.
	 */
	openPage(): void {
		void this.view.webContents.loadURL(this.pageUrl);
	}

	/**
	 * Set the host after construction.
	 *
	 * The window builds this view in its own constructor, so there is no
	 * window to hand it yet. Nothing here touches the window before a modal
	 * opens, and a modal cannot open before the window exists.
	 */
	private host: PickerViewHost | undefined;
	adopt(host: PickerViewHost): void {
		this.host = host;
	}

	//#region the set that is open

	/** Put a modal on screen; the id is what closes it again. */
	openModal(request: ModalRequest): string {
		const id = randomUUID();
		const same = identity(request);
		this.closeWhere((modal) => identity(modal.request) === same);
		this.open.push({ id, request });
		this.host?.modalsChanged();
		return id;
	}

	/**
	 * Take one modal off screen.
	 *
	 * `response` is the button a workbench's question was answered with. A
	 * modal that asked nothing carries nothing, and a workbench's question that
	 * is closed without one is answered with its own cancel button — the same
	 * thing Electron does when a native sheet is dismissed.
	 */
	closeModal(id: string, response?: number): void {
		const index = this.open.findIndex((modal) => modal.id === id);
		if (index === -1) return;
		const [modal] = this.open.splice(index, 1);
		const settle = this.pending.get(id);
		if (settle && modal?.request.kind === "workbench-dialog") {
			this.pending.delete(id);
			settle(response ?? modal.request.cancelId);
		}
		this.host?.modalsChanged();
	}

	/** Close every modal a predicate matches — used when its subject is gone. */
	closeWhere(matches: (modal: OpenModal) => boolean): void {
		for (const modal of [...this.open]) {
			if (matches(modal)) this.closeModal(modal.id);
		}
	}

	/**
	 * The workbench that is waiting for an answer, if one is.
	 *
	 * That workbench is put on screen for as long as its question stands, and
	 * this is what the window asks to know it. Leaving the question to reappear
	 * "when you come back to that editor" reads well and dead-ends: a workspace
	 * being closed is exactly the one that asks about unsaved work, and a
	 * workspace in the middle of closing cannot be selected — so the question
	 * could never be shown again and the close waited for it for ever
	 * (reproduced: the workspace sat in `closing` with no way to answer).
	 *
	 * Everything outside that workbench's own rectangle stays live, so looking
	 * at another workspace in the sidebar, or at its agents, still works.
	 */
	askingSurfaceKey(): string | undefined {
		for (const modal of this.open) {
			if (modal.request.kind === "workbench-dialog") {
				return modal.request.surfaceKey;
			}
		}
		return undefined;
	}

	/** Ask a workbench's question and wait for the person to answer it. */
	async ask(
		request: Extract<ModalRequest, { kind: "workbench-dialog" }>,
	): Promise<number> {
		const id = this.openModal(request);
		return new Promise<number>((resolve) => {
			this.pending.set(id, resolve);
			// Nobody is left to answer once the window is gone; the question is
			// settled with its own cancel button rather than left hanging.
			this.host?.window.once("closed", () => {
				this.closeModal(id);
			});
		});
	}

	//#endregion

	//#region presentation

	/**
	 * How much of the window this layer covers, for the owner to place it.
	 *
	 * A workbench's question covers that workbench and nothing else, so the
	 * sidebar and every other workspace stay both visible *and* clickable — the
	 * view simply does not extend over them. Everything else is the application
	 * asking, and covers the window.
	 */
	scope(): PickerScope {
		if (this.open.length === 0) return "none";
		return this.open.some((modal) => modal.request.kind !== "workbench-dialog")
			? "window"
			: "workbench";
	}

	/**
	 * Put the layer where the owner says: over what is being asked about when
	 * `asking`, parked in the window's corner when not.
	 *
	 * Called from the one place that decides what is on screen, so there is no
	 * arrangement of reveals, resizes and modal opens that leaves the overlay
	 * at stale bounds or over the window with nothing to show.
	 *
	 * `scrim` is the dim, as a colour: it is the view's background, and the
	 * page draws none of its own.
	 */
	place(rect: Electron.Rectangle, asking: boolean, scrim: string): void {
		const host = this.host;
		if (!host || host.window.isDestroyed()) return;
		const view = this.view;
		// Clear while parked: the one pixel of it inside the window is not
		// something to dim.
		const background = asking ? scrim : CLEAR;
		if (background !== this.background) {
			this.background = background;
			view.setBackgroundColor(background);
		}
		// Told before it moves, so a sheet closing is painted away while the
		// layer is still over the window rather than never.
		this.publish(asking ? this.open : []);
		view.setBounds(rect);
		// Re-adding an existing child moves it to the end of the list, which is
		// the top of the stack. Nothing else establishes that order, and the
		// whole point of this layer is that it is above everything.
		//
		// It is re-added on *every* pass, not only when a question arrives.
		// The owner places every child in its own order, and it does so
		// whenever anything about the arrangement moves — a window resize, a
		// sidebar drag, the split divider, a second modal opening. Raising this
		// layer once meant the first such layout after a modal opened put the
		// workbench back on top of it: the sheet still held the keyboard, but
		// the editor was what was drawn and what took the clicks over the
		// content area, which is a picker that cannot be used and an editor
		// that looks like it activates itself.
		host.window.contentView.addChildView(view);
		if (!asking) {
			if (!this.present) return;
			this.present = false;
			host.focusSurface();
			return;
		}
		this.present = true;
		// The keyboard is placed *after* the view is over the window, and on
		// every pass rather than only on the one where the layer arrived.
		//
		// It used to be only that one, and whether a sheet could be typed into
		// was decided by whether the window happened to be key at that single
		// instant: `placeKeyboardIn` declines outright while anything else is
		// in front, and nothing asked again. Measured on an isolated instance
		// (`webContents.isFocused()` in main, `document.hasFocus()` in the
		// overlay page):
		//
		// - a sheet opened while DevHub was not the front app never received
		//   the keyboard at all — `focusModal` was called and declined;
		// - a sheet standing when DevHub was switched away from and back got
		//   the keyboard given to the *App Shell page* instead, because the
		//   window's `focus` event asks `focusSurface`, which stands aside for
		//   a modal (`placeTheKeyboard`) rather than serving one.
		//
		// Both are the same missing sentence, so it is said once here as a
		// state rather than as an event: while a question stands, this layer
		// has the keyboard, and any pass that finds it elsewhere puts it back.
		// Asking first is what keeps that idempotent — re-adding a child view
		// does not disturb focus (measured), so a pass that changes nothing
		// moves nothing.
		if (!view.webContents.isFocused()) {
			host.focusModal(view.webContents);
		}
	}

	private publish(modals: readonly OpenModal[]): void {
		const view = this.view;
		if (view.webContents.isDestroyed()) return;
		const wire = JSON.stringify(modals);
		if (wire === this.published) return;
		this.published = wire;
		view.webContents.send(CHANNELS.modalsChanged, modals);
	}

	/**
	 * The modals that are open, for a test to assert against.
	 *
	 * Exposed so a test can state the invariant — one modal per question — and
	 * not the calls that happen to produce it today.
	 */
	openModals(): readonly OpenModal[] {
		return this.open;
	}

	/** The id of the workbench question waiting for an answer, if one is. */
	askingId(): string {
		const modal = this.open.find(
			(candidate) => candidate.request.kind === "workbench-dialog",
		);
		if (!modal) throw new Error("no workbench question is waiting");
		return modal.id;
	}

	/** Whether a question is over the window right now. */
	isPresent(): boolean {
		return this.present;
	}

	/**
	 * The overlay page, once it exists.
	 *
	 * The projections the App Shell page mirrors — the snapshot, the
	 * appearance, the agent profiles — are the same ones the modals are drawn
	 * from, so they are pushed here too rather than being fetched a second way.
	 */
	contents(): Electron.WebContents | undefined {
		return this.view.webContents.isDestroyed()
			? undefined
			: this.view.webContents;
	}

	//#endregion
}
