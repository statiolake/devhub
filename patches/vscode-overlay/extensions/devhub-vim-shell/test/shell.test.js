/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// node --test extensions/devhub-vim-shell/test/*.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const { test } = require('node:test');
const { runShell, writeTempFile } = require('../shell.js');

test('stdin in, stdout and stderr out, the exit code', async () => {
	const r = await runShell({ cmd: 'sort; echo oops >&2; exit 3', input: 'b\na\n', shell: '/bin/sh' });
	assert.deepStrictEqual([r.stdout, r.stderr, r.code, r.cancelled], ['a\nb\n', 'oops\n', 3, false]);
});

test('in the given directory, with $SHELL -c', async () => {
	const dir = fs.realpathSync(os.tmpdir());
	const r = await runShell({ cmd: 'pwd', cwd: dir, shell: '/bin/sh' });
	assert.strictEqual(r.stdout.trim(), dir);
	const s = await runShell({ cmd: 'echo "$0"', env: { ...process.env, SHELL: '/bin/sh' } });
	assert.strictEqual(s.code, 0);
});

test('a command that ignores its input, and one that is cancelled', async () => {
	const r = await runShell({ cmd: 'echo x', input: 'y'.repeat(1 << 20), shell: '/bin/sh' });
	assert.strictEqual(r.stdout, 'x\n');
	let cancel = () => { };
	// the whole pipeline goes, not just the shell
	const started = Date.now();
	const p = runShell({ cmd: 'sleep 10 | cat; echo after', shell: '/bin/sh' }, c => cancel = c);
	setTimeout(() => cancel(), 50);
	const c = await p;
	assert.strictEqual(c.cancelled, true);
	assert.strictEqual(c.stdout, '');
	assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test('the temp file for :w !cmd holds the text, readable by the user only', () => {
	const f = writeTempFile('a\nb\n');
	assert.strictEqual(fs.readFileSync(f, 'utf8'), 'a\nb\n');
	assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
	fs.rmSync(require('path').dirname(f), { recursive: true });
});
