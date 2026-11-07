/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: a workbench that is not on screen gives back its TextMate worker.
//
// The worker's Oniguruma heap is a WebAssembly memory: it grows to whatever
// the largest file it tokenized needed (70 MB resident after ~460 KB of
// TypeScript) and never shrinks, so a hidden workbench kept it for good.
// Ending the worker frees it; VS Code starts a new one when a model needs one
// (patches/vscode/0015-textmate-worker-can-be-released.patch).
//
// When:
//
// - Before a freeze: main asks `vscode:devhubActivity` of a hidden workbench
//   only on its way to freezing it (apps/desktop/src/main/shell/
//   workbenchPlan.ts, 3 s after it was hidden). Once per hiding, whatever the
//   worker was doing: a frozen worker does nothing anyway.
// - Hidden and idle: every `IDLE_MS` while the page is hidden, if the worker
//   has sent nothing for `IDLE_MS` — the workbench is not frozen (freezing is
//   off, or something keeps it awake), or it was thawed while still hidden and
//   an edit (an agent's, on disk) started a worker again.
//
// Never while the page is shown, and nothing at all for a hiding shorter than
// either. Shown again, only a model the released worker had not finished is
// bound to a new worker right away; every other one when it next needs one
// (an edit, lines it is asked for). The tokens on screen stay as they are.

import { IntervalTimer } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

/** Hidden this long, with the worker idle this long, the worker goes. */
export const IDLE_MS = 30_000;

/** What `ITextMateTokenizationService` offers for it. */
export interface TokenizerWorker {
	releaseTokenizerWorker(idleForMs: number): boolean;
	resumeTokenizerWorker(): void;
}

/** Whether the page is hidden (`document.visibilityState`), and when that changes. */
export interface PageVisibility {
	readonly hidden: boolean;
	readonly onDidChange: Event<void>;
}

export class HiddenTokenizerWorker extends Disposable {
	private hidden = false;
	/** The worker was released during this hiding: resume when shown. */
	private released = false;
	/** The probe before a freeze has released it during this hiding. */
	private releasedBeforeFreeze = false;
	private readonly idleCheck = this._register(new IntervalTimer());

	constructor(
		private readonly worker: TokenizerWorker,
		private readonly page: PageVisibility,
	) {
		super();
		this._register(page.onDidChange(() => this.update()));
		this.update();
	}

	/**
	 * Main is about to decide on freezing this workbench. Returns whether a
	 * worker was ended.
	 */
	beforeFreeze(): boolean {
		if (!this.page.hidden || this.releasedBeforeFreeze) {
			return false;
		}
		this.releasedBeforeFreeze = true;
		return this.release(0);
	}

	private update(): void {
		const hidden = this.page.hidden;
		if (hidden === this.hidden) {
			return;
		}
		this.hidden = hidden;
		if (hidden) {
			this.idleCheck.cancelAndSet(() => this.release(IDLE_MS), IDLE_MS);
			return;
		}
		this.idleCheck.cancel();
		this.releasedBeforeFreeze = false;
		if (this.released) {
			this.released = false;
			this.worker.resumeTokenizerWorker();
		}
	}

	private release(idleForMs: number): boolean {
		if (!this.page.hidden) {
			return false;
		}
		const released = this.worker.releaseTokenizerWorker(idleForMs);
		this.released ||= released;
		return released;
	}
}
