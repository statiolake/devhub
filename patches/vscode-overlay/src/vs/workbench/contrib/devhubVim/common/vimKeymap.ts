/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: the default keymap, as data - Neovim's defaults
// (`:help index`, `:help default-mappings`, `:help lsp-defaults`). Imports
// nothing.
//
// Every entry becomes an ordinary default keybinding (KeybindingsRegistry, in
// ../browser/devhubVim.contribution.ts): it is listed in the Keyboard
// Shortcuts editor, `keybindings.json` overrides it, and `-command` removes it.
// The tests resolve keys against this same table, so what is tested is what
// ships. Most entries run `devhubVim.*` engine commands (they compose with
// counts, operators, registers, `.` and macros); Vim commands that are VS Code
// features (folds, LSP, diagnostics, windows) run through `devhubVim.run`
// (visual mode), in `devhubVim.repeat` where a count repeats them (`3]d`), or are bound to the VS Code
// command directly where Vim has no grammar around them (insert-mode CTRL-S).
//
// The keymap targets the Apple JIS keyboard (macOS, JIS hardware). It is
// written below by character, in keybindings.json notation for a US layout
// (`shift+8` is `*`, `shift+;` is `:`), because that is how Vim's keys read;
// DEFAULT_KEYBINDINGS is that table with every punctuation key and shifted
// digit put on the physical JIS key that types the character, in scan-code
// notation (`*` -> `shift+[Quote]`, `^` -> `[Equal]`, `:` -> `[Quote]`,
// `g*` -> `g shift+[Quote]`; JIS_KEYS). Those are what is registered, shown
// in the Keyboard Shortcuts editor and resolved: there is no character
// fallback and no layout context key. Letters, digits and named keys are
// layout independent and stay as they are. On another layout, rebind the
// symbol keys by scan code (docs/vim.md, Keyboard layouts).

export interface VimKeybinding {
	/** keybindings.json notation; chords are separated by spaces ("g g", "g r n"). */
	readonly key: string;
	readonly command: string;
	readonly args?: Readonly<Record<string, unknown>>;
	/** A when clause. */
	readonly when: string;
	/**
	 * `override`: outranks workbench-wide defaults (Ctrl-R is Open Recent on macOS);
	 * `escape`: Esc's own weight outside insert mode, below every widget's Esc;
	 * `insertEscape`: Esc in insert / replace mode, above every editor widget's Esc
	 * (the widgets are closed by the escape itself, INSERT_ESCAPE_DISMISSES);
	 * `cmdline`: the `:` `/` `?` prompt's keys (vimCmdline.ts), above the
	 * suggest widget's Tab and every workbench default on the CTRL keys. See VIM_WEIGHTS.
	 */
	readonly weight?: 'override' | 'escape' | 'insertEscape' | 'cmdline';
}

/**
 * A Vim editor has the keyboard focus. `textInputFocus`, not `editorTextFocus`:
 * VS Code sets `editorTextFocus` for full editors only, never for a simple
 * widget (the SCM commit message, the debug console input, chat and comment
 * inputs), which are Vim editors too; `devhubVim.active` already says the
 * focused editor is one (DevhubVim.focused).
 */
const BASE = 'textInputFocus && devhubVim.active';
const MOTION = `${BASE} && devhubVim.acceptsMotion`;

/** The when clauses the defaults use; copy them for your own bindings. */
export const VIM_WHEN = {
	/** normal, visual and operator-pending mode, nothing else pending (count/register/operator allowed) */
	motion: MOTION,
	/** as `motion`, but only when nothing is pending: arrows are the editor's own once an operator waits */
	arrow: `${MOTION} && !devhubVim.pending`,
	normal: `${MOTION} && devhubVim.mode == 'normal'`,
	/** normal or visual, not operator-pending */
	normalOrVisual: `${MOTION} && devhubVim.mode != 'operatorPending'`,
	/** normal or operator-pending, not visual */
	notVisual: `${MOTION} && !devhubVim.visual`,
	/** any visual mode (characterwise, linewise, blockwise) */
	visual: `${MOTION} && devhubVim.visual`,
	operatorPending: `${MOTION} && devhubVim.mode == 'operatorPending'`,
	/** where `i` / `a` start a text object */
	textObjectPrefix: `${MOTION} && devhubVim.mode != 'normal'`,
	/** after `i` / `a`: the key names the object */
	textObject: `${BASE} && devhubVim.textObjectPending`,
	countZero: `${MOTION} && devhubVim.hasCount`,
	lineStart: `${MOTION} && !devhubVim.hasCount`,
	recording: `${MOTION} && devhubVim.mode == 'normal' && devhubVim.recording`,
	notRecording: `${MOTION} && devhubVim.mode == 'normal' && !devhubVim.recording`,
	/** insert and replace mode (not while CTRL-R waits for its register) */
	insert: `${BASE} && devhubVim.insert && !devhubVim.awaitingChar`,
	replace: `${BASE} && devhubVim.mode == 'replace' && !devhubVim.awaitingChar`,
	escape: `devhubVim.active && devhubVim.mode != 'nav'`,
	/**
	 * every mode of a Vim editor but insert and replace (and nav): where a key
	 * that types or erases a character is a Vim command or nothing, because the
	 * editor's own ones do not apply (EditorContextKeys.devhubVimAllowsTyping)
	 */
	notTyping: `${BASE} && !devhubVim.insert && devhubVim.mode != 'nav'`,
} as const;

const W = VIM_WHEN;

/** `when` for a key that is the second half of a doubled operator (`gUU`, `gcc`, `gqq`). */
function pendingOp(name: string): string {
	return `${W.operatorPending} && devhubVim.pendingOperator == '${name}'`;
}

function notPendingOp(name: string, when: string = W.motion): string {
	return `${when} && devhubVim.pendingOperator != '${name}'`;
}

function motion(key: string, name: string, when: string = W.motion): VimKeybinding {
	return { key, command: 'devhubVim.motion', args: { motion: name }, when };
}

function awaitChar(key: string, command: string, args: Record<string, unknown> | undefined, when: string, weight?: 'override'): VimKeybinding {
	return { key, command: 'devhubVim.awaitChar', args: { then: args ? { command, args } : { command } }, when, ...(weight ? { weight } : {}) };
}

function action(key: string, name: string, when: string, weight?: 'override'): VimKeybinding {
	return { key, command: 'devhubVim.action', args: { action: name }, when, ...(weight ? { weight } : {}) };
}

function operator(key: string, name: string, when: string = W.motion): VimKeybinding {
	return { key, command: 'devhubVim.operator', args: { operator: name }, when };
}

function mode(key: string, to: string, at: string | undefined, when: string, weight?: 'override'): VimKeybinding {
	return { key, command: 'devhubVim.mode', args: at ? { to, at } : { to }, when, ...(weight ? { weight } : {}) };
}

function textObject(key: string, object: string, when: string = W.textObject): VimKeybinding {
	return { key, command: 'devhubVim.textObject', args: { object }, when };
}

function scroll(key: string, args: Record<string, unknown>, when: string = W.normalOrVisual, weight?: 'override'): VimKeybinding {
	return { key, command: 'devhubVim.scroll', args, when, ...(weight ? { weight } : {}) };
}

function insert(key: string, name: string, when: string = W.insert): VimKeybinding {
	return { key, command: 'devhubVim.insert', args: { action: name }, when, weight: 'override' };
}

/**
 * A VS Code command as a Vim command: `devhubVim.run` (in visual mode it runs
 * on the selection), wrapped in `devhubVim.repeat` with `"count": "${count}"`
 * so a count repeats it (`3]d`); `{ count: 'ignore' }`: run once, the count is
 * dropped (`3K`).
 */
function run(key: string, command: string, when: string = W.normal, extra: { count?: 'ignore' } = {}): VimKeybinding {
	return extra.count === 'ignore'
		? { key, command: 'devhubVim.run', args: { command }, when }
		: { key, command: 'devhubVim.repeat', args: { command: 'devhubVim.run', args: { command }, count: '${count}' }, when };
}

function ex(key: string, command: string, when: string = W.normal): VimKeybinding {
	return { key, command: 'devhubVim.ex', args: { command }, when };
}

const OVERRIDE = 'override';

/** The keymap by character, in US notation (see the top of the file). DEFAULT_KEYBINDINGS is what is registered. */
const KEYMAP_BY_CHARACTER: readonly VimKeybinding[] = [
	// Outside insert mode Esc cancels one thing and an editor widget's Esc
	// (hover, peek, find, the marker widget, a snippet) comes first. In insert and
	// replace mode one Esc is always back in normal mode: it outranks the widgets'
	// Esc and closes the transient ones itself (INSERT_ESCAPE_DISMISSES).
	{ key: 'escape', command: 'devhubVim.escape', when: `${W.escape} && !devhubVim.insert`, weight: 'escape' },
	// CTRL-[ is no widget's key, but on Windows / Linux VS Code's Outdent Lines (EditorContrib)
	{ key: 'ctrl+[', command: 'devhubVim.escape', when: `${W.escape} && !devhubVim.insert`, weight: OVERRIDE },
	{ key: 'ctrl+c', command: 'devhubVim.escape', args: { interrupt: true }, when: `${W.escape} && !devhubVim.insert`, weight: 'escape' },
	{ key: 'escape', command: 'devhubVim.escape', when: `${W.escape} && devhubVim.insert`, weight: 'insertEscape' },
	{ key: 'ctrl+[', command: 'devhubVim.escape', when: `${W.escape} && devhubVim.insert`, weight: 'insertEscape' },
	{ key: 'ctrl+c', command: 'devhubVim.escape', args: { interrupt: true }, when: `${W.escape} && devhubVim.insert`, weight: 'insertEscape' },

	// ---- motions (they compose with a count, an operator and visual mode) ----
	motion('h', 'left'), motion('left', 'left', W.arrow),
	motion('backspace', 'charBackward'), motion('ctrl+h', 'charBackward', W.motion),
	motion('j', 'down'), motion('down', 'down', W.arrow), motion('ctrl+j', 'down'), motion('ctrl+n', 'down'),
	motion('k', 'up'), motion('up', 'up', W.arrow), motion('ctrl+p', 'up'),
	motion('l', 'right'), motion('right', 'right', W.arrow), motion('space', 'charForward'),
	motion('g j', 'displayDown'), motion('g down', 'displayDown'), motion('g k', 'displayUp'), motion('g up', 'displayUp'),
	motion('w', 'wordForward', notPendingOp('formatKeep')), motion('shift+w', 'WORDForward'),
	motion('b', 'wordBackward'), motion('shift+b', 'WORDBackward'),
	motion('e', 'wordEnd'), motion('shift+e', 'WORDEnd'),
	motion('g e', 'wordEndBackward'), motion('g shift+e', 'WORDEndBackward'),
	motion('0', 'lineStart', W.lineStart), motion('home', 'lineStart', W.arrow),
	motion('shift+6', 'firstNonBlank'),
	motion('shift+4', 'lineEnd'), motion('end', 'lineEnd', W.arrow),
	motion('g shift+-', 'lastNonBlank'),
	motion('shift+\\', 'column'),
	motion('g shift+m', 'middleOfLine'),
	motion('g g', 'fileStart'), motion('shift+g', 'fileEnd'),
	motion('enter', 'nextLineStart'), motion('shift+=', 'nextLineStart'),
	motion('-', 'previousLineStart'), motion('shift+-', 'currentLineStart'),
	motion('shift+h', 'screenTop'), motion('shift+m', 'screenMiddle'), motion('shift+l', 'screenBottom'),
	motion('shift+5', 'matchBracket'),
	motion(';', 'repeatFind'), motion(',', 'repeatFindReverse'),
	motion('n', 'searchNext'), motion('shift+n', 'searchPrevious'),
	motion('shift+8', 'searchWordForward', W.notVisual), motion('shift+3', 'searchWordBackward', W.notVisual),
	motion('g shift+8', 'searchWordForwardPartial', W.notVisual), motion('g shift+3', 'searchWordBackwardPartial', W.notVisual),
	motion('shift+9', 'sentenceBackward'), motion('shift+0', 'sentenceForward'),
	motion('shift+[', 'paragraphBackward'), motion('shift+]', 'paragraphForward'),
	motion('[ [', 'sectionBackward'), motion('] ]', 'sectionForward'), motion('[ ]', 'sectionEndBackward'), motion('] [', 'sectionEndForward'),
	motion('[ shift+9', 'unmatchedParenBackward'), motion('] shift+0', 'unmatchedParenForward'),
	motion('[ shift+[', 'unmatchedBraceBackward'), motion('] shift+]', 'unmatchedBraceForward'),
	motion('g d', 'localDeclaration'), motion('g shift+d', 'globalDeclaration'),
	awaitChar('f', 'devhubVim.motion', { motion: 'findForward' }, W.motion),
	awaitChar('t', 'devhubVim.motion', { motion: 'tillForward' }, W.motion),
	awaitChar('shift+f', 'devhubVim.motion', { motion: 'findBackward' }, W.motion),
	awaitChar('shift+t', 'devhubVim.motion', { motion: 'tillBackward' }, W.motion),
	awaitChar('`', 'devhubVim.motion', { motion: 'mark' }, W.motion),
	awaitChar('\'', 'devhubVim.motion', { motion: 'markLine' }, W.motion),
	{ key: '/', command: 'devhubVim.cmdline', args: { kind: '/' }, when: W.motion },
	{ key: 'shift+/', command: 'devhubVim.cmdline', args: { kind: '?' }, when: notPendingOp('rot13') },

	// ---- counts: `0` is a count digit only after another digit ----
	...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d): VimKeybinding => ({ key: d, command: 'devhubVim.count', args: { digit: Number(d) }, when: W.motion })),
	{ key: '0', command: 'devhubVim.count', args: { digit: 0 }, when: W.countZero },

	// ---- registers and marks ----
	awaitChar('shift+\'', 'devhubVim.register', undefined, W.normalOrVisual),
	awaitChar('m', 'devhubVim.mark', undefined, W.normalOrVisual),

	// ---- operators (twice for lines: dd cc yy >> << == gUU guu g~~ g?? gqq gww gcc) ----
	operator('d', 'delete'), operator('c', 'change', notPendingOp('comment')), operator('y', 'yank'),
	operator('shift+.', 'indent'), operator('shift+,', 'outdent'), operator('=', 'reindent'),
	operator('g u', 'lowercase'), operator('u', 'lowercase', pendingOp('lowercase')),
	operator('g shift+u', 'uppercase'), operator('shift+u', 'uppercase', pendingOp('uppercase')),
	operator('g shift+`', 'toggleCase'), operator('shift+`', 'toggleCase', pendingOp('toggleCase')),
	operator('g shift+/', 'rot13'), operator('shift+/', 'rot13', pendingOp('rot13')),
	operator('g q', 'format'), operator('q', 'format', pendingOp('format')),
	operator('g w', 'formatKeep'), operator('w', 'formatKeep', pendingOp('formatKeep')),
	operator('g c', 'comment', W.normalOrVisual), operator('c', 'comment', pendingOp('comment')),
	operator('z f', 'fold', W.normalOrVisual),
	// `dv` `dV` `d<C-v>`: force the motion characterwise / linewise / blockwise
	{ key: 'v', command: 'devhubVim.forceMotion', args: { type: 'char' }, when: W.operatorPending },
	{ key: 'shift+v', command: 'devhubVim.forceMotion', args: { type: 'line' }, when: W.operatorPending },
	{ key: 'ctrl+v', command: 'devhubVim.forceMotion', args: { type: 'block' }, when: W.operatorPending, weight: OVERRIDE },

	// ---- text objects: `i` / `a` after an operator or in visual mode, then the object ----
	{ key: 'i', command: 'devhubVim.textObjectPrefix', args: { kind: 'inner' }, when: W.textObjectPrefix },
	{ key: 'a', command: 'devhubVim.textObjectPrefix', args: { kind: 'around' }, when: W.textObjectPrefix },
	textObject('w', 'word'), textObject('shift+w', 'WORD'), textObject('s', 'sentence'), textObject('p', 'paragraph'),
	textObject('shift+\'', 'doubleQuote'), textObject('\'', 'singleQuote'), textObject('`', 'backtick'),
	textObject('shift+9', 'paren'), textObject('shift+0', 'paren'), textObject('b', 'paren'),
	textObject('shift+[', 'brace'), textObject('shift+]', 'brace'), textObject('shift+b', 'brace'),
	textObject('[', 'bracket'), textObject(']', 'bracket'),
	textObject('shift+,', 'angle'), textObject('shift+.', 'angle'), textObject('t', 'tag'),
	// v_an / v_in (Neovim 0.12): the enclosing / inner syntax node, as VS Code's smart select
	textObject('n', 'syntaxNode', `${W.textObject} && devhubVim.visual`),
	// o_gc: the commented lines around the cursor (`dgc`, `gcgc`)
	{ key: 'g c', command: 'devhubVim.textObject', args: { object: 'comment', kind: 'around' }, when: W.operatorPending },
	// gn / gN: the next search match, as a text object or a visual selection (`cgn` then `.`)
	{ key: 'g n', command: 'devhubVim.textObject', args: { object: 'searchMatch', kind: 'inner' }, when: W.motion },
	{ key: 'g shift+n', command: 'devhubVim.textObject', args: { object: 'searchMatchBackward', kind: 'inner' }, when: W.motion },

	// ---- insert, replace and visual mode ----
	mode('i', 'insert', 'before', W.normal), mode('a', 'insert', 'after', W.normal),
	mode('shift+i', 'insert', 'firstNonBlank', W.normal), mode('shift+a', 'insert', 'lineEnd', W.normal),
	mode('g shift+i', 'insert', 'lineStart', W.normal), mode('g i', 'insert', 'lastInsert', W.normal),
	mode('o', 'insert', 'lineBelow', W.normal), mode('shift+o', 'insert', 'lineAbove', W.normal),
	mode('shift+r', 'replace', undefined, W.normal),
	mode('v', 'visual', undefined, W.normalOrVisual), mode('shift+v', 'visualLine', undefined, W.normalOrVisual),
	mode('ctrl+v', 'visualBlock', undefined, W.normalOrVisual, OVERRIDE),

	// ---- changes (in visual mode the same keys act on the selection) ----
	action('x', 'deleteChar', W.normalOrVisual), action('delete', 'deleteChar', W.normalOrVisual), action('shift+x', 'deleteCharBefore', W.normalOrVisual),
	action('shift+d', 'deleteToLineEnd', W.normalOrVisual), action('shift+c', 'changeToLineEnd', W.normalOrVisual),
	action('s', 'substituteChar', W.normalOrVisual), action('shift+s', 'substituteLine', W.normalOrVisual),
	// Neovim: Y is y$ (Y-default); in visual mode Y yanks the lines
	action('shift+y', 'yankToLineEnd', W.normal), action('shift+y', 'yankLine', W.visual),
	action('p', 'put', W.normalOrVisual), action('shift+p', 'putBefore', W.normalOrVisual),
	action('g p', 'putAfterCursorEnd', W.normal), action('g shift+p', 'putBeforeCursorEnd', W.normal),
	action('] p', 'putIndented', W.normal), action('[ p', 'putIndentedBefore', W.normal),
	action('] shift+p', 'putIndentedBefore', W.normal), action('[ shift+p', 'putIndentedBefore', W.normal),
	action('shift+`', 'toggleCase', W.normalOrVisual),
	action('shift+j', 'joinLines', W.normalOrVisual), action('g shift+j', 'joinLinesRaw', W.normalOrVisual),
	awaitChar('r', 'devhubVim.action', { action: 'replaceChar' }, W.normalOrVisual),
	action('ctrl+a', 'increment', W.normalOrVisual, OVERRIDE), action('ctrl+x', 'decrement', W.normalOrVisual, OVERRIDE),
	action('g ctrl+a', 'incrementProgressive', W.visual, OVERRIDE), action('g ctrl+x', 'decrementProgressive', W.visual, OVERRIDE),
	action('[ space', 'blankLineAbove', W.normal), action('] space', 'blankLineBelow', W.normal),
	action('u', 'undo', W.normal), action('ctrl+r', 'redo', W.normal, OVERRIDE),
	action('.', 'repeat', W.normal),
	action('shift+7', 'repeatSubstitute', W.normal), action('g shift+7', 'repeatSubstituteAll', W.normal),
	{ key: 'shift+;', command: 'devhubVim.cmdline', args: { kind: ':' }, when: W.normalOrVisual },
	ex('shift+z shift+z', 'x'), ex('shift+z shift+q', 'q!'),

	// ---- visual mode ----
	action('u', 'lowercase', W.visual), action('shift+u', 'uppercase', W.visual),
	action('o', 'swapVisualEnds', W.visual), action('shift+o', 'swapVisualCorner', W.visual),
	action('shift+r', 'substituteLine', W.visual),
	action('shift+i', 'visualInsert', W.visual), action('shift+a', 'visualAppend', W.visual),
	action('g v', 'reselect', W.normalOrVisual),
	// Neovim: v_* / v_# search for the selected text (v_star-default)
	action('shift+8', 'visualSearchForward', W.visual), action('shift+3', 'visualSearchBackward', W.visual),
	// Neovim: v_@ runs the register on every selected line (v_@-default)
	awaitChar('shift+2', 'devhubVim.action', { action: 'visualPlayMacro' }, W.visual),

	// ---- jumps, marks, the change list ----
	action('ctrl+o', 'jumpBack', W.normal, OVERRIDE), action('ctrl+i', 'jumpForward', W.normal, OVERRIDE), action('tab', 'jumpForward', W.normal, OVERRIDE),
	// <Tab> elsewhere and <S-Tab> are no Vim commands: they do nothing (a pending
	// operator is cancelled), and do not move the focus out of the editor
	action('tab', 'ignore', `${W.notTyping} && devhubVim.mode != 'normal'`, OVERRIDE), action('shift+tab', 'ignore', W.notTyping, OVERRIDE),
	action('g ;', 'changeOlder', W.normal), action('g ,', 'changeNewer', W.normal),

	// ---- macros ----
	awaitChar('q', 'devhubVim.action', { action: 'recordMacro' }, W.notRecording),
	action('q', 'stopMacro', W.recording),
	awaitChar('shift+2', 'devhubVim.action', { action: 'playMacro' }, W.normal),
	// Neovim: Q repeats the last recorded register
	action('shift+q', 'playLastRecorded', W.normal),

	// ---- scrolling ----
	scroll('ctrl+e', { by: 'line', direction: 'down' }, W.normalOrVisual, OVERRIDE), scroll('ctrl+y', { by: 'line', direction: 'up' }, W.normalOrVisual, OVERRIDE),
	scroll('ctrl+d', { by: 'halfPage', direction: 'down' }, W.normalOrVisual, OVERRIDE), scroll('ctrl+u', { by: 'halfPage', direction: 'up' }, W.normalOrVisual, OVERRIDE),
	scroll('ctrl+f', { by: 'page', direction: 'down' }, W.normalOrVisual, OVERRIDE), scroll('ctrl+b', { by: 'page', direction: 'up' }, W.normalOrVisual, OVERRIDE),
	scroll('pagedown', { by: 'page', direction: 'down' }, W.arrow), scroll('pageup', { by: 'page', direction: 'up' }, W.arrow),
	scroll('z t', { to: 'top' }), scroll('z z', { to: 'center' }), scroll('z b', { to: 'bottom' }),
	scroll('z enter', { to: 'top', firstNonBlank: true }), scroll('z .', { to: 'center', firstNonBlank: true }), scroll('z -', { to: 'bottom', firstNonBlank: true }),
	// Neovim: CTRL-L also clears the search highlighting (CTRL-L-default)
	action('ctrl+l', 'noHighlight', W.normalOrVisual, OVERRIDE),

	// ---- folds (VS Code's folding) ----
	run('z o', 'editor.unfold', W.normalOrVisual), run('z shift+o', 'editor.unfoldRecursively', W.normalOrVisual),
	run('z c', 'editor.fold', W.normalOrVisual), run('z shift+c', 'editor.foldRecursively', W.normalOrVisual),
	run('z a', 'editor.toggleFold', W.normalOrVisual), run('z shift+a', 'editor.toggleFoldRecursively', W.normalOrVisual),
	run('z v', 'editor.unfold', W.normalOrVisual),
	run('z shift+r', 'editor.unfoldAll', W.normalOrVisual, { count: 'ignore' }), run('z shift+m', 'editor.foldAll', W.normalOrVisual, { count: 'ignore' }),
	run('z j', 'editor.gotoNextFold', W.normal), run('z k', 'editor.gotoPreviousFold', W.normal),
	run('[ z', 'editor.gotoParentFold', W.normal),
	run('z shift+e', 'editor.removeManualFoldingRanges', W.normal, { count: 'ignore' }), run('z d', 'editor.removeManualFoldingRanges', W.normal, { count: 'ignore' }),

	// ---- Neovim LSP defaults (`:help lsp-defaults`) as VS Code language features ----
	run('shift+k', 'editor.action.showHover', W.normalOrVisual, { count: 'ignore' }),
	run('g r n', 'editor.action.rename', W.normal, { count: 'ignore' }),
	run('g r a', 'editor.action.quickFix', W.normalOrVisual, { count: 'ignore' }),
	run('g r r', 'editor.action.goToReferences', W.normal, { count: 'ignore' }),
	run('g r i', 'editor.action.goToImplementation', W.normal, { count: 'ignore' }),
	run('g r t', 'editor.action.goToTypeDefinition', W.normal, { count: 'ignore' }),
	run('g r x', 'codelens.showLensesInCurrentLine', W.normal, { count: 'ignore' }),
	run('g shift+o', 'workbench.action.gotoSymbol', W.normal, { count: 'ignore' }),
	// 'tagfunc' is the language server's: CTRL-] goes to the definition, CTRL-T back
	run('ctrl+]', 'editor.action.revealDefinition', W.normal, { count: 'ignore' }),
	run('ctrl+t', 'workbench.action.navigateBack', W.normal),
	run('g x', 'editor.action.openLink', W.normalOrVisual, { count: 'ignore' }),
	// ]d [d ]D [D: diagnostics (Neovim's vim.diagnostic.jump); ]D / [D wrap from the other end to the last / first
	run('] d', 'editor.action.marker.next'), run('[ d', 'editor.action.marker.prev'),
	{ key: '] shift+d', command: 'devhubVim.run', args: { commands: [{ command: 'devhubVim.motion', args: { motion: 'fileStart' } }, { command: 'editor.action.marker.prev' }] }, when: W.normal },
	{ key: '[ shift+d', command: 'devhubVim.run', args: { commands: [{ command: 'devhubVim.motion', args: { motion: 'fileEnd' } }, { command: 'editor.action.marker.next' }] }, when: W.normal },
	// [q ]q (:cprevious / :cnext): problems across files; [b ]b [B ]B (:bprevious ...): editors
	run('] q', 'editor.action.marker.nextInFiles'), run('[ q', 'editor.action.marker.prevInFiles'),
	run('] b', 'workbench.action.nextEditor'), run('[ b', 'workbench.action.previousEditor'),
	run('] shift+b', 'workbench.action.lastEditorInGroup', W.normal, { count: 'ignore' }), run('[ shift+b', 'workbench.action.firstEditorInGroup', W.normal, { count: 'ignore' }),
	// gt gT: tab pages are editors here
	run('g t', 'workbench.action.nextEditor'), run('g shift+t', 'workbench.action.previousEditor'),
	// CTRL-^: the alternate file
	run('ctrl+6', 'workbench.action.openPreviousRecentlyUsedEditorInGroup', W.normal, { count: 'ignore' }),

	// ---- insert mode ----
	// Neovim: i_CTRL-W / i_CTRL-U start a new undo step first (i_CTRL-W-default)
	insert('ctrl+w', 'deleteWordBefore'), insert('ctrl+u', 'deleteLineBefore'),
	insert('ctrl+t', 'indent'), insert('ctrl+d', 'outdent'),
	insert('ctrl+e', 'copyFromBelow', `${W.insert} && !suggestWidgetVisible`), insert('ctrl+y', 'copyFromAbove'),
	// Cancel only, stay in insert mode: CTRL-E closes the completion menu (Vim's
	// complete_CTRL-E), CTRL-] dismisses the inline suggestion / next edit
	// (copilot.vim's <Plug>(copilot-dismiss)); elsewhere CTRL-E is i_CTRL-E and
	// CTRL-] stays VS Code's (indent lines).
	{ key: 'ctrl+e', command: 'hideSuggestWidget', when: `${W.insert} && suggestWidgetVisible`, weight: OVERRIDE },
	{ key: 'ctrl+]', command: 'editor.action.inlineSuggest.hide', when: `${W.insert} && (inlineSuggestionVisible || inlineEditIsVisible)`, weight: OVERRIDE },
	insert('ctrl+a', 'insertLastInserted'), insert('ctrl+o', 'oneCommand'),
	awaitChar('ctrl+r', 'devhubVim.insert', { action: 'insertRegister' }, W.insert, OVERRIDE),
	insert('backspace', 'backspace', W.replace), insert('ctrl+h', 'backspace', W.replace),
	{ key: 'ctrl+h', command: 'deleteLeft', when: `${W.insert} && devhubVim.mode == 'insert' && !editorReadonly`, weight: OVERRIDE },
	// Neovim: i_CTRL-S is signature help (lsp-defaults)
	{ key: 'ctrl+s', command: 'editor.action.triggerParameterHints', when: W.insert, weight: OVERRIDE },
	// CTRL-N / CTRL-P complete (VS Code's suggestions), and move in the menu once it is open
	{ key: 'ctrl+n', command: 'editor.action.triggerSuggest', when: `${W.insert} && !suggestWidgetVisible`, weight: OVERRIDE },
	{ key: 'ctrl+p', command: 'editor.action.triggerSuggest', when: `${W.insert} && !suggestWidgetVisible`, weight: OVERRIDE },
	{ key: 'ctrl+n', command: 'selectNextSuggestion', when: `${W.insert} && suggestWidgetVisible`, weight: OVERRIDE },
	{ key: 'ctrl+p', command: 'selectPrevSuggestion', when: `${W.insert} && suggestWidgetVisible`, weight: OVERRIDE },
	{ key: 'ctrl+x ctrl+o', command: 'editor.action.triggerSuggest', when: W.insert, weight: OVERRIDE },
];

/**
 * What leaving insert mode (Esc, CTRL-[, CTRL-C) closes first, each where its
 * `when` holds in the editor: the completion menu, the inline suggestion /
 * next edit, signature help and an editor message. Not a snippet session
 * (it is not a widget: its placeholders stay, and it ends by its own rules
 * when the caret leaves them, as LuaSnip's and Neovim's vim.snippet do), not
 * the find widget or a peek (they stay until an Esc in normal mode, as
 * there).
 */
export const INSERT_ESCAPE_DISMISSES: readonly { readonly command: string; readonly when: string }[] = [
	{ command: 'hideSuggestWidget', when: 'suggestWidgetVisible' },
	{ command: 'editor.action.inlineSuggest.hide', when: 'inlineSuggestionVisible || inlineEditIsVisible' },
	{ command: 'closeParameterHints', when: 'parameterHintsVisible' },
	{ command: 'leaveEditorMessage', when: 'messageVisible' },
	// linked editing (an HTML tag pair) is typing in two places: it ends with the insert
	{ command: 'cancelLinkedEditingInput', when: 'LinkedEditingInputVisible' },
];

/**
 * The weights the entries are registered with (KeybindingWeight: EditorCore 0,
 * EditorContrib 100, WorkbenchContrib 200; devhubVim.contribution.ts checks).
 * `insertEscape` is above every Esc an editor widget binds while the editor has
 * text focus: hideSuggestWidget and editor.action.inlineSuggest.hide
 * (EditorContrib + 90), cancelLinkedEditingInput (+ 99), closeParameterHints
 * (+ 75), closeMarkersNavigation (+ 50), leaveSnippet and leaveEditorMessage
 * (+ 30), closeFindWidget (+ 5), closeReferenceSearch (WorkbenchContrib + 50).
 */
export const VIM_WEIGHTS = {
	default: 100,
	override: 250,
	escape: 50,
	insertEscape: 260,
	/** KeybindingWeight.WorkbenchContrib + 55: the prompt's keys, while it has the focus (CMDLINE_KEYBINDINGS). */
	cmdline: 255,
} as const;

/** What a US key types with Shift, for the digits and punctuation keys. */
const US_SHIFTED: Readonly<Record<string, string>> = {
	'1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
	'`': '~', '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', '\'': '"', ',': '<', '.': '>', '/': '?',
};
const US_PUNCTUATION = '`-=[]\\;\',./';

/**
 * Apple JIS (macOS): the physical key, in scan-code notation, that types each
 * ASCII symbol. The row of digits types `! " # $ % & ' ( )` with Shift; then
 * `- =`, `^ ~`, `¥ |`; `@ \``, `[ {`; `; +`, `: *`, `] }`; `, <`, `. >`,
 * `/ ?`, and `_` on the ろ key with or without Shift. `\` is Option-¥ (or ¥
 * itself with the Japanese input source's "¥ key types \" setting).
 */
export const JIS_KEYS: Readonly<Record<string, readonly string[]>> = {
	'!': ['shift+[Digit1]'], '"': ['shift+[Digit2]'], '#': ['shift+[Digit3]'], '$': ['shift+[Digit4]'], '%': ['shift+[Digit5]'],
	'&': ['shift+[Digit6]'], '\'': ['shift+[Digit7]'], '(': ['shift+[Digit8]'], ')': ['shift+[Digit9]'],
	'-': ['[Minus]'], '=': ['shift+[Minus]'], '^': ['[Equal]'], '~': ['shift+[Equal]'], '|': ['shift+[IntlYen]'], '\\': ['alt+[IntlYen]', '[IntlYen]'],
	'@': ['[BracketLeft]'], '`': ['shift+[BracketLeft]'], '[': ['[BracketRight]'], '{': ['shift+[BracketRight]'],
	';': ['[Semicolon]'], '+': ['shift+[Semicolon]'], ':': ['[Quote]'], '*': ['shift+[Quote]'], ']': ['[Backslash]'], '}': ['shift+[Backslash]'],
	',': ['[Comma]'], '<': ['shift+[Comma]'], '.': ['[Period]'], '>': ['shift+[Period]'], '/': ['[Slash]'], '?': ['shift+[Slash]'],
	'_': ['[IntlRo]', 'shift+[IntlRo]'],
};

/** The JIS keys for one chord in US notation (`shift+8` -> `shift+[Quote]`, `ctrl+[` -> `ctrl+[BracketRight]`); others as they are. */
function jisChord(chord: string): readonly string[] {
	const parts = chord.split('+');
	const base = parts[parts.length - 1] === '' ? '+' : parts[parts.length - 1];
	const mods = parts.slice(0, parts[parts.length - 1] === '' ? -2 : -1);
	const shift = mods.includes('shift');
	const ch = shift && US_SHIFTED[base] !== undefined ? US_SHIFTED[base] : !shift && base.length === 1 && US_PUNCTUATION.includes(base) ? base : undefined;
	const keys = ch === undefined ? undefined : JIS_KEYS[ch];
	if (!keys) {
		return [chord];
	}
	const others = mods.filter(m => m !== 'shift');
	return keys.map(k => [...others, k].join('+'));
}

/** Every JIS key sequence for a key sequence in US notation. */
export function jisKeys(key: string): string[] {
	let out: string[] = [''];
	for (const chord of key.split(' ')) {
		out = out.flatMap(prefix => jisChord(chord).map(c => prefix ? `${prefix} ${c}` : c));
	}
	return out;
}

/** The default keymap as registered: KEYMAP_BY_CHARACTER on the Apple JIS keys. */
export const DEFAULT_KEYBINDINGS: readonly VimKeybinding[] = KEYMAP_BY_CHARACTER.flatMap(b => jisKeys(b.key).map(key => key === b.key ? b : { ...b, key }));

/** The keymap's notation for typing `ch` on Apple JIS ('$' -> 'shift+[Digit4]', 'G' -> 'shift+g', ' ' -> 'space'). */
export function keyForChar(ch: string): string | undefined {
	if (ch === ' ') {
		return 'space';
	}
	if (/^[a-z0-9]$/.test(ch)) {
		return ch;
	}
	if (/^[A-Z]$/.test(ch)) {
		return `shift+${ch.toLowerCase()}`;
	}
	return JIS_KEYS[ch]?.[0];
}

// ---- when clauses and key notation, for :normal and the tests ----------------

/** Evaluate the subset of the when-clause language the keymap uses (`&&`, `||`, `!`, `==`, `!=`, parentheses). Unknown keys are undefined (false). */
export function evaluateWhen(when: string, ctx: Readonly<Record<string, unknown>>): boolean {
	const tokens = when.match(/\(|\)|&&|\|\||!=|==|!|'[^']*'|[\w.]+/g) ?? [];
	let i = 0;
	const value = (t: string): unknown => t.startsWith('\'') ? t.slice(1, -1) : t === 'true' ? true : t === 'false' ? false : ctx[t];
	const primary = (): unknown => {
		const t = tokens[i++];
		if (t === '(') {
			const v = or();
			i++; // ')'
			return v;
		}
		if (t === '!') {
			return !primary();
		}
		const v = t === 'true' ? true : t === 'false' ? false : ctx[t];
		if (tokens[i] === '==' || tokens[i] === '!=') {
			const op = tokens[i++];
			const rhs = value(tokens[i++]);
			return op === '==' ? v === rhs : v !== rhs;
		}
		return v;
	};
	const and = (): unknown => {
		let v = primary();
		while (tokens[i] === '&&') {
			i++;
			const r = primary();
			v = !!v && !!r;
		}
		return v;
	};
	const or = (): unknown => {
		let v = and();
		while (tokens[i] === '||') {
			i++;
			const r = and();
			v = !!v || !!r;
		}
		return v;
	};
	return !!or();
}

/** A key in Vim notation (`<CR>`, `<C-w>`, `x`) as the keymap writes it (`enter`, `ctrl+w`, `x` on its JIS key); undefined when it has none. */
export function keybindingForVimKey(k: string): string | undefined {
	const named: Record<string, string> = {
		'<Esc>': 'escape', '<CR>': 'enter', '<BS>': 'backspace', '<Tab>': 'tab', '<S-Tab>': 'shift+tab', '<Space>': 'space',
		'<Left>': 'left', '<Right>': 'right', '<Up>': 'up', '<Down>': 'down', '<S-Up>': 'shift+up', '<S-Down>': 'shift+down',
		'<Del>': 'delete', '<Home>': 'home', '<End>': 'end', '<PageUp>': 'pageup', '<PageDown>': 'pagedown',
	};
	if (named[k]) {
		return named[k];
	}
	const ctrl = /^<C-(.)>$/i.exec(k);
	if (ctrl) {
		const key = keyForChar(ctrl[1].toLowerCase());
		return key && `ctrl+${key}`;
	}
	return Array.from(k).length === 1 ? keyForChar(k) : undefined;
}

const NAMED_KEY = /^<(?:Esc|CR|BS|Tab|Space|Left|Right|Up|Down|Del|Home|End|PageUp|PageDown|lt|Bar|Bslash|NL|[CcSsAaMmDd]-[^>]+)>/;

/** Keys in Vim notation (`dw`, `<Esc>`, `<C-r>a`) one by one; `<lt>` is `<`, `<Bar>` `|`, `<Bslash>` `\`. */
export function keysOf(s: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < s.length;) {
		if (s[i] === '<') {
			const m = NAMED_KEY.exec(s.slice(i));
			if (m) {
				const k = m[0];
				out.push(k === '<lt>' ? '<' : k === '<Bar>' ? '|' : k === '<Bslash>' ? '\\' : k === '<NL>' ? '<C-j>' : k);
				i += k.length;
				continue;
			}
		}
		const cp = s.codePointAt(i)!;
		const ch = String.fromCodePoint(cp);
		out.push(ch);
		i += ch.length;
	}
	return out;
}
