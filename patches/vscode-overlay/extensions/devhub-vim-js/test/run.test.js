/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// node --test extensions/devhub-vim-js/test/*.test.js

const assert = require('assert');
const { test } = require('node:test');
const { runJs } = require('../run.js');

const doc = { uri: { toString: () => 'file:///a.ts' }, lineCount: 3, getText: () => 'x' };
const editor = { document: doc, selection: { start: 1 } };
const fakeVscode = { window: { visibleTextEditors: [editor], activeTextEditor: undefined }, workspace: { textDocuments: [doc] }, version: '1.0' };
const base = { uri: 'file:///a.ts', mode: 'normal', registers: { a: { text: 'reg a', type: 'char' } } };

test(':jsdo is :luado: the body of (line, linenr) => { body }; return replaces; undefined / null leave the line', async () => {
	const r = await runJs(fakeVscode, { ...base, kind: 'do', code: 'if (linenr % 2) return line.toUpperCase()', lines: ['a', 'b', 'c'], firstLine: 5 });
	assert.deepStrictEqual(r, { lines: ['A', null, 'C'], registers: {} });
	const n = await runJs(fakeVscode, { ...base, kind: 'do', code: 'return null', lines: ['a'], firstLine: 1 });
	assert.deepStrictEqual(n.lines, [null]);
	// several statements, ; between them
	const s = await runJs(fakeVscode, { ...base, kind: 'do', code: 'const n = line.length; return `${linenr}:${n}`', lines: ['ab', 'c'], firstLine: 1 });
	assert.deepStrictEqual(s.lines, ['1:2', '2:1']);
	// no special expression form: a bare expression returns nothing
	const e = await runJs(fakeVscode, { ...base, kind: 'do', code: 'line + "!"', lines: ['a'], firstLine: 1 });
	assert.deepStrictEqual(e.lines, [null]);
});

test(':jsdo errors: another type, a line break, a throw, bad syntax; the lines before stay', async () => {
	const t = await runJs(fakeVscode, { ...base, kind: 'do', code: 'return linenr === 2 ? 42 : "ok"', lines: ['a', 'b', 'c'], firstLine: 1 });
	assert.deepStrictEqual(t.lines, ['ok']);
	assert.match(t.error, /^E5108: Error executing JS: the function returned a number, not a string, undefined or null \(line 2\)$/);
	const nl = await runJs(fakeVscode, { ...base, kind: 'do', code: 'return "a\\nb"', lines: ['a'], firstLine: 1 });
	assert.match(nl.error, /line break/);
	const th = await runJs(fakeVscode, { ...base, kind: 'do', code: 'throw new TypeError("nope")', lines: ['a'], firstLine: 3 });
	assert.strictEqual(th.error, 'E5108: Error executing JS: TypeError: nope (line 3)');
	const sy = await runJs(fakeVscode, { ...base, kind: 'do', code: 'return (', lines: ['a'], firstLine: 1 });
	assert.match(sy.error, /^E5107: Error loading JS/);
});

test(':js runs the code with await; :js = pretty-prints; the helpers', async () => {
	assert.deepStrictEqual(await runJs(fakeVscode, { ...base, kind: 'exec', code: 'await new Promise(r => setTimeout(r, 1)); vim.registers.set("b", vim.registers.get("a") + "!", "line")' }), { registers: { b: { text: 'reg a!', type: 'line' } } });
	assert.deepStrictEqual(await runJs(fakeVscode, { ...base, kind: 'eval', code: '1 + 1' }), { value: '2', registers: {} });
	assert.deepStrictEqual(await runJs(fakeVscode, { ...base, kind: 'eval', code: '"s"' }), { value: '"s"', registers: {} });
	assert.deepStrictEqual(await runJs(fakeVscode, { ...base, kind: 'eval', code: '[doc.lineCount, sel.start, editor === vscode.window.visibleTextEditors[0], vim.mode]' }), { value: "[ 3, 1, true, 'normal' ]", registers: {} });
	assert.deepStrictEqual(await runJs(fakeVscode, { ...base, kind: 'eval', code: 'await Promise.resolve({ a: 1 })' }), { value: '{ a: 1 }', registers: {} });
	const big = await runJs(fakeVscode, { ...base, kind: 'eval', code: 'Object.fromEntries(Array.from({ length: 30 }, (_, i) => ["key" + i, "value " + i]))' });
	assert.ok(big.value.includes('\n'));
	assert.strictEqual((await runJs(fakeVscode, { ...base, kind: 'exec', code: 'throw new Error("boom")' })).error, 'E5108: Error executing JS: boom');
	assert.match((await runJs(fakeVscode, { ...base, kind: 'exec', code: 'vim.registers.set("??", "x")' })).error, /invalid register name/);
});
