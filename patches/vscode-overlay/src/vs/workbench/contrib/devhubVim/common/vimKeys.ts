/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: the few keydowns the editor reads itself, the mode ->
// cursor style rule, and the `<C-w>` window prefix. Imports nothing, so the
// tests run it as they run the engine.
//
// Vim's keys are keybindings (common/vimKeymap.ts); the editor's own keydown
// only takes the key after a command that waits for a character (f t r " q
// @), and the keys typed into the `:` `/` prompt. Those are characters, not
// commands, so no keybinding could bind them all.

/** The parts of a KeyboardEvent the mapping reads. */
export interface VimKeyEvent {
	readonly key: string;
	readonly keyCode: number;
	readonly isComposing: boolean;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly altKey: boolean;
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS', 'AltGraph']);

function isImeKey(e: VimKeyEvent): boolean {
	return e.isComposing || e.keyCode === 229 || e.key === 'Process';
}

/**
 * A keydown taken as a character argument or prompt input: the character
 * typed, `<CR>` `<BS>` `<Esc>` `<Tab>` `<Up>` `<Down>`, `<C-x>` for Ctrl and a
 * character, or `<Other>` for any other key (it cancels a waiting command).
 * Undefined leaves the key alone: a lone modifier, a Cmd/Alt chord (Cmd-S
 * still saves) and a key that belongs to an IME,
 * whose committed text arrives separately (VimEngine.handleText).
 */
export function captureKey(e: VimKeyEvent): string | undefined {
	if (isImeKey(e) || MODIFIER_KEYS.has(e.key) || e.metaKey || e.altKey) {
		return undefined;
	}
	if (e.ctrlKey) {
		// CTRL-x in the prompt (CTRL-U, CTRL-W, CTRL-R ...) or after f / r (it cancels them)
		return Array.from(e.key).length === 1 ? `<C-${e.key.toLowerCase()}>` : undefined;
	}
	switch (e.key) {
		case 'Enter': return '<CR>';
		case 'Backspace': return '<BS>';
		case 'Escape': return '<Esc>';
		case 'Tab': return '<Tab>';
		case 'ArrowUp': return '<Up>';
		case 'ArrowDown': return '<Down>';
	}
	return Array.from(e.key).length === 1 ? e.key : '<Other>';
}

/** A keydown that types one character, with no Cmd/Ctrl/Alt and no IME. */
export function typedChar(e: VimKeyEvent): string | undefined {
	if (isImeKey(e) || e.metaKey || e.ctrlKey || e.altKey) {
		return undefined;
	}
	return Array.from(e.key).length === 1 ? e.key : undefined;
}

export type VimCursorStyle = 'line' | 'block' | 'underline' | 'line-thin' | 'block-outline' | 'underline-thin';

/**
 * The one rule for the caret: the user's own style in insert mode, an
 * underline in replace mode, a block in every other Vim mode, a thin underline while the `<C-w>` prefix waits for
 * its key. Computed from the state each time (never toggled), so no
 * sequence of events can leave a stale style behind.
 */
export function vimCursorStyle(mode: string, nav: boolean, insertStyle: VimCursorStyle): VimCursorStyle {
	if (nav) {
		return 'underline-thin';
	}
	// Neovim's 'guicursor': a block, the insert caret in insert mode, a horizontal bar in replace mode
	return mode === 'insert' ? insertStyle : mode === 'replace' ? 'underline' : 'block';
}

/** Where the keyboard focus is when the `<C-w>` prefix is pressed. */
export type VimNavFocus =
	/** a Vim editor in normal or visual mode, nothing pending */
	| 'normal'
	/** a Vim editor with keys pending (an operator, a count, the `:` `/` prompt) */
	| 'pending'
	/** a Vim editor in insert mode */
	| 'insert'
	/** a plain input (search view, find widget, ...): it has no normal mode */
	| 'input'
	| 'terminal'
	/** a list, tree or anything else that is not text */
	| 'other';

/** What the workbench does with a keydown while the prefix waits. */
export type VimNavKeyAction =
	/** run the command the keybindings bind the key to while nav waits, whatever it is */
	| 'run'
	/** the key is not the prefix's: it does what it does anyway */
	| 'pass'
	/** eat the key: it only cancels the prefix */
	| 'swallow'
	/** a lone modifier: keep waiting for the key it modifies */
	| 'wait';

/**
 * Vim's window prefix, workbench wide: `<C-w>` then one key, as in Vim's
 * `<C-w>h` / `<C-w>j` / `<C-w>k` / `<C-w>l`. It is one-shot: whatever the next
 * key is, the prefix is over afterwards, so there is no mode to get stuck in
 * and Esc never has anything to do with it except cancel it.
 *
 * Esc is not a way in. Vim users press Esc by habit, any number of times,
 * and the promise is that it always lands in plain normal mode.
 */
export class VimNavPrefix {

	private _active = false;

	get active(): boolean {
		return this._active;
	}

	/**
	 * The prefix key. Returns whether it now waits for its key. Refused where
	 * `<C-w>` means something else: in a Vim editor's insert mode (delete the
	 * word before the caret, as in Vim), with Vim keys pending (Vim's `<C-w>`
	 * aborts an operator; the caller cancels them) and in the terminal (the
	 * shell's delete-word).
	 */
	enter(focus: VimNavFocus): boolean {
		if (focus === 'insert' || focus === 'pending' || focus === 'terminal') {
			return false;
		}
		this._active = true;
		return true;
	}

	/**
	 * A keydown while the prefix waits; `command` is the command the
	 * keybindings bind it to here (`devhubVim.mode == 'nav'` holds): a
	 * `devhubVim.nav.*` one (h j k l by default), a user's binding with that
	 * `when`, or any other binding that applies here. No key is filtered: the
	 * editor's keys that type or erase a character (Backspace, Tab, Enter ...)
	 * do not apply while nav waits (EditorContextKeys.devhubVimAllowsTyping),
	 * so they resolve to nothing. Every key but a lone modifier ends the
	 * prefix, also one that runs a command. A key nothing binds cancels it and
	 * is eaten, as in Vim; Cmd chords and IME keys are let through (Cmd-W
	 * still closes the editor).
	 */
	key(e: { readonly key: string; readonly keyCode: number; readonly isComposing: boolean; readonly metaKey: boolean }, command: string | undefined): VimNavKeyAction {
		if (!this._active) {
			return 'pass';
		}
		if (MODIFIER_KEYS.has(e.key)) {
			return 'wait';
		}
		this._active = false;
		if (e.isComposing || e.keyCode === 229 || e.key === 'Process') {
			return 'pass';
		}
		if (command) {
			return 'run';
		}
		return e.metaKey ? 'pass' : 'swallow';
	}

	/** A click, a focus change, a window switch: the prefix is forgotten. */
	cancel(): void {
		this._active = false;
	}
}
