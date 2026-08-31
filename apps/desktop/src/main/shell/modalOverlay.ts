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
 * and nothing else. It is added when a modal opens and removed when the last
 * one closes, so while nothing is being asked it is not there at all and
 * cannot take a click.
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

export interface ModalOverlayHost {
	readonly window: Electron.BrowserWindow;
	/** The rectangle a workbench's own question is clipped to. */
	workbenchRect(): Electron.Rectangle;
	/**
	 * What holds the keyboard when no modal does.
	 *
	 * The workbench on screen, or the App Shell page when none is. Asking the
	 * window rather than remembering who was focused when the modal opened is
	 * what makes this correct: Electron reports no focused `webContents` for a
	 * child view at all, so "put back what I took" quietly meant "give it to
	 * the page", and typing after closing a sheet went nowhere near the editor.
	 */
	focusTarget(): Electron.WebContents;
	/**
	 * The set that is open has changed.
	 *
	 * The window lays itself out again, because what a modal is *over* is part
	 * of that layout: a workbench under its own question stays on screen.
	 */
	modalsChanged(): void;
}

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
		case "agent-picker":
			return `${request.kind}:${request.workspaceId}`;
		default:
			return request.kind;
	}
}

export class ModalOverlay {
	private view: Electron.WebContentsView | undefined;
	private present = false;
	private readonly open: OpenModal[] = [];
	private readonly pending = new Map<string, Settle>();
	private published: string | undefined;

	constructor(
		private readonly host: ModalOverlayHost,
		private readonly preloadPath: string,
		private readonly pageUrl: string,
	) {}

	//#region the set that is open

	/** Put a modal on screen; the id is what closes it again. */
	openModal(request: ModalRequest): string {
		const id = randomUUID();
		const same = identity(request);
		this.closeWhere((modal) => identity(modal.request) === same);
		this.open.push({ id, request });
		this.host.modalsChanged();
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
		this.host.modalsChanged();
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
			this.host.window.once("closed", () => {
				this.closeModal(id);
			});
		});
	}

	//#endregion

	//#region presentation

	/**
	 * Where the overlay goes.
	 *
	 * A workbench's question covers that workbench and nothing else, so the
	 * sidebar and every other workspace stay both visible *and* clickable — the
	 * view simply does not extend over them. Everything else is the application
	 * asking, and covers the window.
	 */
	private boundsFor(modals: readonly OpenModal[]): Electron.Rectangle {
		const windowScoped = modals.some(
			(modal) => modal.request.kind !== "workbench-dialog",
		);
		if (!windowScoped) return this.host.workbenchRect();
		const [width, height] = this.host.window.getContentSize();
		return { x: 0, y: 0, width, height };
	}

	/**
	 * Bring the layer into line with the set that is open.
	 *
	 * Called from the one place that decides what is on screen, so there is no
	 * arrangement of reveals, resizes and modal opens that leaves the overlay
	 * at stale bounds or present with nothing to show.
	 */
	reposition(): void {
		if (this.host.window.isDestroyed()) return;
		const modals: readonly OpenModal[] = this.open;

		if (modals.length === 0) {
			this.withdraw();
			return;
		}

		const view = this.ensureView();
		view.setBounds(this.boundsFor(modals));
		if (!this.present) {
			// Re-adding an existing child moves it to the end of the list, which
			// is the top of the stack. Nothing else establishes that order, and
			// the whole point of this layer is that it is above everything.
			this.host.window.contentView.addChildView(view);
			this.present = true;
			view.webContents.focus();
		}
		this.publish(modals);
	}

	private withdraw(): void {
		this.publish([]);
		if (!this.present || !this.view) return;
		this.host.window.contentView.removeChildView(this.view);
		this.present = false;
		this.host.focusTarget().focus();
	}

	private ensureView(): Electron.WebContentsView {
		if (this.view && !this.view.webContents.isDestroyed()) return this.view;
		const view = new electron.WebContentsView({
			webPreferences: {
				preload: this.preloadPath,
				sandbox: false,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});
		// The layer is a hole with modals in it: everything the person can see
		// through it is a real, live workbench, not a picture of one.
		view.setBackgroundColor("#00000000");
		// The overlay draws DevHub's own page and nothing else; a link in a
		// modal leaves through the browser like every other link.
		sendLinksToTheBrowser(view.webContents);
		view.webContents.on("did-finish-load", () => {
			// The page starts empty and is told what to draw; a reload has to be
			// told again, or the layer is up with nothing on it.
			this.published = undefined;
			this.publish(this.open);
		});
		void view.webContents.loadURL(this.pageUrl);
		this.view = view;
		return view;
	}

	private publish(modals: readonly OpenModal[]): void {
		const view = this.view;
		if (!view || view.webContents.isDestroyed()) return;
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

	/** Whether the layer is in the window's child list right now. */
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
		const view = this.view;
		return view && !view.webContents.isDestroyed()
			? view.webContents
			: undefined;
	}

	//#endregion
}
