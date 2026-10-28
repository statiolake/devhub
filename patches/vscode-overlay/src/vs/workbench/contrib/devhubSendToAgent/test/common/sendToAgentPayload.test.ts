/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: what "Send to Agent…" tells DevHub about the editor.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { documentPath, SendToAgentDocument, sendToAgentPayload } from '../../common/sendToAgentPayload.js';

/** A document of `lines`, read as a text model reads a range. */
function documentOf(uri: URI, lines: readonly string[], languageId = 'typescript'): SendToAgentDocument {
	return {
		uri,
		getLanguageId: () => languageId,
		getValueInRange: (range: IRange) => {
			const picked = lines.slice(range.startLineNumber - 1, range.endLineNumber);
			if (picked.length === 1) {
				return picked[0].slice(range.startColumn - 1, range.endColumn - 1);
			}
			const first = picked[0].slice(range.startColumn - 1);
			const last = picked[picked.length - 1].slice(0, range.endColumn - 1);
			return [first, ...picked.slice(1, -1), last].join('\n');
		},
	};
}

function range(startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number): IRange {
	return { startLineNumber, startColumn, endLineNumber, endColumn };
}

const LINES = ['import a from "a";', '', 'export function f() {', '\treturn a;', '}', ''];

suite('DevHub: Send to Agent payload', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a selection is its lines and its text, with the file and its language', () => {
		const uri = URI.file('/Users/me/src/app/src/a.ts');
		assert.deepStrictEqual(sendToAgentPayload(documentOf(uri, LINES), [range(3, 1, 5, 2)]), {
			version: 1,
			uri: uri.toString(),
			path: '/Users/me/src/app/src/a.ts',
			languageId: 'typescript',
			ranges: [{ startLine: 3, endLine: 5, text: 'export function f() {\n\treturn a;\n}' }],
		});
	});

	test('a selection that ends at the start of a line does not take that line', () => {
		const payload = sendToAgentPayload(documentOf(URI.file('/r/a.ts'), LINES), [range(3, 1, 5, 1)]);
		assert.deepStrictEqual(payload.ranges, [{ startLine: 3, endLine: 4, text: 'export function f() {\n\treturn a;\n' }]);
	});

	test('a bare cursor is its line, with no text', () => {
		const payload = sendToAgentPayload(documentOf(URI.file('/r/a.ts'), LINES), [range(4, 3, 4, 3)]);
		assert.deepStrictEqual(payload.ranges, [{ startLine: 4, endLine: 4, text: '' }]);
	});

	test('several selections are sent in document order, each once', () => {
		const payload = sendToAgentPayload(documentOf(URI.file('/r/a.ts'), LINES), [range(4, 2, 4, 8), range(1, 1, 1, 7), range(4, 2, 4, 8)]);
		assert.deepStrictEqual(payload.ranges, [
			{ startLine: 1, endLine: 1, text: 'import' },
			{ startLine: 4, endLine: 4, text: 'return' },
		]);
	});

	test('a file has a path on its machine, here or remote; anything else has none', () => {
		assert.strictEqual(documentPath(URI.file('/Users/me/a.ts')), '/Users/me/a.ts');
		assert.strictEqual(documentPath(URI.parse('vscode-remote://ssh-remote%2Bbox/home/me/a.ts')), '/home/me/a.ts');
		assert.strictEqual(documentPath(URI.parse('untitled:Untitled-1')), undefined);
		assert.strictEqual(documentPath(URI.parse('output:extension-output-1')), undefined);
	});
});
