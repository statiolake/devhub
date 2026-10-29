/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub Vim: normal mode wherever the focus is not text entry, webviews
// included. The webview host frame (webview/browser/pre/index.html, as
// patches/vscode/0008-devhub-vim.patch has it) tells with each key and each
// focus move whether its page's focused element takes typing; WebviewElement
// records it (webviewTextEntry.ts); DevHub Vim's isTextEntry reads it.

import assert from 'assert';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { WebviewTextEntry } from '../../../webview/browser/webviewTextEntry.js';
import { isTextEntry } from '../../browser/devhubVim.contribution.js';

declare const __readFileInTests: (path: string) => Promise<string>;

/** The host frame's page, as the build copies it next to its scripts. */
async function hostFrame(): Promise<string> {
	return __readFileInTests(FileAccess.asFileUri('vs/workbench/contrib/webview/browser/pre/index.html').fsPath);
}

/** Its one inline script (the module the page runs). */
function script(html: string): string {
	const m = /<script async type="module">([\s\S]*?)<\/script>/.exec(html);
	assert.ok(m, 'the host frame has its inline module');
	return m[1];
}

interface HostFunctions {
	devhubTextEntry(doc: Document | null | undefined): boolean;
	devhubDocumentOf(target: unknown): Document;
}

/** The host frame's DevHub functions, taken out of its script as they are and run here. */
function hostFunctions(source: string): HostFunctions {
	const start = source.indexOf('const devhubNonTextInputs');
	const end = source.indexOf('/** @type {boolean | undefined} */', start);
	assert.ok(start > 0 && end > start, 'the functions are in the script');
	return new Function(`${source.slice(start, end)}\nreturn { devhubTextEntry, devhubDocumentOf };`)() as HostFunctions;
}

suite('DevHub Vim: text entry in webviews (the host frame says, Vim reads it)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the host frame\'s Content-Security-Policy hash is its script\'s: the page runs at all', async () => {
		const html = await hostFrame();
		const hash = /script-src 'sha256-([^']+)'/.exec(html)?.[1];
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script(html)));
		let binary = '';
		for (const b of new Uint8Array(digest)) {
			binary += String.fromCharCode(b);
		}
		assert.strictEqual(hash, btoa(binary));
	});

	test('every key it forwards says whether the page is being typed into, and so does every focus move in the page', async () => {
		const source = script(await hostFrame());
		assert.match(source, /isTrusted: e\.isTrusted,\s*devhubTextEntry: devhubTextEntry\(devhubDocumentOf\(e\.target\)\)\s*\};\s*hostMessaging\.postMessage\('did-keydown', data\);/);
		// both places that wire up the page's frame (the pending frame and the one loaded)
		assert.strictEqual(source.match(/addEventListener\('focusin', devhubHandleInnerFocus, true\)/g)?.length, 2);
		assert.strictEqual(source.match(/addEventListener\('focusout', devhubHandleInnerFocus, true\)/g)?.length, 2);
		assert.match(source, /hostMessaging\.postMessage\('did-devhub-text-entry', \{ textEntry \}\)/);
	});

	test('what the host frame counts as text entry: inputs that take text, textarea, select, contenteditable, role textbox / searchbox / combobox, a frame of its own; not buttons, links, checkboxes, the body', async () => {
		const host = hostFunctions(script(await hostFrame()));
		const frame = document.createElement('iframe');
		document.body.appendChild(frame);
		try {
			const doc = frame.contentDocument!;
			const add = (html: string) => {
				const wrap = doc.createElement('div');
				wrap.innerHTML = html;
				const el = wrap.firstElementChild as HTMLElement;
				doc.body.appendChild(el);
				el.focus();
				assert.strictEqual(doc.activeElement, el, html);
				return host.devhubTextEntry(doc);
			};
			assert.strictEqual(host.devhubTextEntry(doc), false, 'nothing focused (the body)');
			assert.strictEqual(add('<input type="text">'), true);
			assert.strictEqual(add('<input>'), true);
			assert.strictEqual(add('<input type="search">'), true);
			assert.strictEqual(add('<input type="number">'), true);
			assert.strictEqual(add('<textarea></textarea>'), true);
			assert.strictEqual(add('<select><option>a</option></select>'), true);
			assert.strictEqual(add('<div contenteditable="true" tabindex="0">x</div>'), true);
			assert.strictEqual(add('<div role="textbox" tabindex="0"></div>'), true);
			assert.strictEqual(add('<div role="searchbox" tabindex="0"></div>'), true);
			assert.strictEqual(add('<div role="combobox" tabindex="0"></div>'), true);
			assert.strictEqual(add('<iframe></iframe>'), true, 'a frame it cannot look into');
			assert.strictEqual(add('<input type="checkbox">'), false);
			assert.strictEqual(add('<input type="button" value="b">'), false);
			assert.strictEqual(add('<button>b</button>'), false);
			assert.strictEqual(add('<a href="#x">link</a>'), false);
			assert.strictEqual(add('<div tabindex="0">plain</div>'), false);
			// inside a shadow root: the element focused in it
			const hostEl = doc.createElement('div');
			doc.body.appendChild(hostEl);
			const shadow = hostEl.attachShadow({ mode: 'open' });
			const inner = doc.createElement('input');
			shadow.appendChild(inner);
			inner.focus();
			assert.strictEqual(host.devhubTextEntry(doc), true, 'an input in a shadow root');
			const button = doc.createElement('button');
			shadow.appendChild(button);
			button.focus();
			assert.strictEqual(host.devhubTextEntry(doc), false, 'a button in a shadow root');
			// designMode: the whole document takes typing
			doc.designMode = 'on';
			assert.strictEqual(host.devhubTextEntry(doc), true);
			doc.designMode = 'off';
			// the document of a key's target: an element's, or the document itself
			assert.strictEqual(host.devhubDocumentOf(button), doc);
			assert.strictEqual(host.devhubDocumentOf(doc), doc);
			assert.strictEqual(host.devhubDocumentOf(undefined), document);
		} finally {
			frame.remove();
		}
	});

	test('DevHub Vim: a webview is text entry while its page says so, or has said nothing; normal mode once it says its focus is not in a field', () => {
		const webview = document.createElement('iframe');
		assert.strictEqual(isTextEntry(webview), true, 'nothing said yet: the page keeps its keys');
		WebviewTextEntry.set(webview, false);
		assert.strictEqual(isTextEntry(webview), false, 'the page outside its fields: normal mode');
		WebviewTextEntry.set(webview, true);
		assert.strictEqual(isTextEntry(webview), true, 'a field of the page has the focus');
		let changes = 0;
		const listener = WebviewTextEntry.onDidChange(() => changes++);
		WebviewTextEntry.set(webview, true);
		WebviewTextEntry.set(webview, false);
		listener.dispose();
		assert.strictEqual(changes, 1, 'only a change is an event');
	});

	test('DevHub Vim: text entry in the workbench is what types; lists, buttons and the rest are normal mode', () => {
		const wrap = document.body.appendChild(document.createElement('div'));
		const make = (html: string) => {
			wrap.innerHTML = html;
			return wrap.firstElementChild!;
		};
		for (const html of ['<input>', '<input type="checkbox">', '<textarea></textarea>', '<select></select>', '<div contenteditable="true"></div>', '<div role="textbox"></div>', '<div role="searchbox"></div>', '<object></object>']) {
			assert.strictEqual(isTextEntry(make(html)), true, html);
		}
		for (const html of ['<div class="monaco-list-row" role="treeitem"></div>', '<button></button>', '<a href="#"></a>', '<div role="tab"></div>', '<div tabindex="0"></div>']) {
			assert.strictEqual(isTextEntry(make(html)), false, html);
		}
		assert.strictEqual(isTextEntry(document.body), false, 'nothing focused');
		wrap.remove();
	});
});
