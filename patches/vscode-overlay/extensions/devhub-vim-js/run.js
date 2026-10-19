/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check

// DevHub Vim's `:js` and `:jsdo` (contrib/devhubVim/browser/vimJs.ts calls
// `_devhubVim.js.run`), as Neovim's `:lua`, `:lua =` and `:luado`:
//
//   :js {code}        the code, as the body of an async function: `await` works,
//                     its value is not shown
//   :js ={expr}       the expression's value, pretty-printed (util.inspect)
//   :[range]jsdo {body}
//                     exactly :luado: {body} is the body of the function
//                     `(line, linenr) => { body }`, called for each line of
//                     the range (linenr 1-based); `return` a string to put in
//                     the line's place; undefined or null leaves it; any other
//                     value is an error (as is a line break in the string).
//                     The lines before the error stay changed, as in Neovim.
//
// In scope: `vscode` (the API), `editor` (the editor the line came from, if
// it is visible), `doc` (its document), `sel` (its selection), `vim`:
// `vim.mode`, `vim.registers.get(name)`, `vim.registers.set(name, text,
// type?)` (written back to Vim's registers when the code is done).

const util = require('util');

/** @typedef {{ text: string; type: 'char' | 'line' | 'block' }} Register */

/**
 * @param {any} vscode
 * @param {string | undefined} uri
 */
function scope(vscode, uri) {
	const editors = /** @type {any[]} */ (vscode.window.visibleTextEditors ?? []);
	const editor = (uri && editors.find(e => e.document?.uri?.toString() === uri)) || (!uri ? vscode.window.activeTextEditor : undefined);
	const doc = editor?.document ?? (uri ? (vscode.workspace.textDocuments ?? []).find((/** @type {any} */ d) => d.uri.toString() === uri) : undefined);
	return { editor, doc, sel: editor?.selection };
}

/**
 * @param {{ mode?: string; registers?: Record<string, Register> }} args
 * @param {Record<string, Register>} written
 */
function vimHelper(args, written) {
	const registers = { ...(args.registers ?? {}) };
	return {
		mode: args.mode ?? 'normal',
		registers: {
			/** @param {string} name */
			get(name) {
				const r = written[name] ?? registers[name];
				return r?.text;
			},
			/**
			 * @param {string} name
			 * @param {string} text
			 * @param {'char' | 'line' | 'block'} [type]
			 */
			set(name, text, type) {
				if (typeof name !== 'string' || !/^[a-zA-Z0-9"+*\-]$/.test(name)) {
					throw new Error(`invalid register name: ${String(name)}`);
				}
				written[name] = { text: String(text), type: type === 'line' || type === 'block' ? type : 'char' };
			},
		},
	};
}

/** @param {unknown} e */
function message(e) {
	return e instanceof Error ? `${e.name === 'Error' ? '' : e.name + ': '}${e.message}` : String(e);
}

const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;

/**
 * @param {any} vscode
 * @param {{ kind: 'exec' | 'eval' | 'do'; code: string; uri?: string; mode?: string; registers?: Record<string, Register>; lines?: string[]; firstLine?: number }} args
 * @returns {Promise<{ value?: string; lines?: (string | null)[]; registers: Record<string, Register>; error?: string }>}
 */
async function runJs(vscode, args) {
	/** @type {Record<string, Register>} */
	const written = {};
	const { editor, doc, sel } = scope(vscode, args.uri);
	const vim = vimHelper(args, written);
	const names = ['vscode', 'editor', 'doc', 'sel', 'vim'];
	const values = [vscode, editor, doc, sel, vim];
	if (args.kind === 'do') {
		/** @type {(line: string, linenr: number) => unknown} */
		let fn;
		try {
			fn = new Function(...names, `return (line, linenr) => {\n${args.code}\n};`)(...values);
		} catch (e) {
			return { registers: written, error: `E5107: Error loading JS: ${message(e)}` };
		}
		/** @type {(string | null)[]} */
		const out = [];
		const lines = args.lines ?? [];
		const first = args.firstLine ?? 1;
		for (let i = 0; i < lines.length; i++) {
			let r;
			try {
				r = fn(lines[i], first + i);
			} catch (e) {
				return { lines: out, registers: written, error: `E5108: Error executing JS: ${message(e)} (line ${first + i})` };
			}
			if (r === undefined || r === null) {
				out.push(null);
			} else if (typeof r === 'string' && !/[\r\n]/.test(r)) {
				out.push(r);
			} else {
				return { lines: out, registers: written, error: `E5108: Error executing JS: ${typeof r === 'string' ? 'the string has a line break' : `the function returned a ${typeof r}, not a string, undefined or null`} (line ${first + i})` };
			}
		}
		return { lines: out, registers: written };
	}
	/** @type {(...a: unknown[]) => Promise<unknown>} */
	let fn;
	try {
		fn = new AsyncFunction(...names, args.kind === 'eval' ? `return (\n${args.code}\n);` : args.code);
	} catch (e) {
		return { registers: written, error: `E5107: Error loading JS: ${message(e)}` };
	}
	try {
		const v = await fn(...values);
		return args.kind === 'eval' ? { value: typeof v === 'string' ? JSON.stringify(v) : util.inspect(v, { depth: 4, breakLength: 100 }), registers: written } : { registers: written };
	} catch (e) {
		return { registers: written, error: `E5108: Error executing JS: ${message(e)}` };
	}
}

module.exports = { runJs };
