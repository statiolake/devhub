/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The test hosts' search: VS Code's own find (TextModel.findMatches /
// findNextMatch / findPreviousMatch) on a TextModel of the test's lines, as
// the workbench host runs it on the editor's model.

import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { USUAL_WORD_SEPARATORS } from '../../../../../editor/common/core/wordHelper.js';
import { FindMatch, ITextModel } from '../../../../../editor/common/model.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import type { IVimHost, VimMatch, VimPos, VimRange, VimSearchQuery } from '../../common/vimEngine.js';

function toVimMatch(m: FindMatch): VimMatch {
	const r = m.range;
	return { range: { start: { line: r.startLineNumber - 1, col: r.startColumn - 1 }, end: { line: r.endLineNumber - 1, col: r.endColumn - 1 } }, groups: m.matches ?? [] };
}

function withModel<T>(lines: readonly string[], fn: (m: ITextModel) => T): T {
	const m = createTextModel(lines.join('\n'));
	try {
		return fn(m);
	} finally {
		m.dispose();
	}
}

/** findMatches / findNextMatch / replaceString of an IVimHost over `lines()`. */
export function vimFindHost(lines: () => readonly string[]): Pick<IVimHost, 'findMatches' | 'findNextMatch' | 'replaceString'> {
	const sep = (q: VimSearchQuery) => q.wholeWord ? USUAL_WORD_SEPARATORS : null;
	return {
		findMatches: (q: VimSearchQuery, within: VimRange, limit: number) => withModel(lines(), m =>
			m.findMatches(q.pattern, new Range(within.start.line + 1, within.start.col + 1, within.end.line + 1, within.end.col + 1), true, q.matchCase, sep(q), true, limit).map(toVimMatch)),
		findNextMatch: (q: VimSearchQuery, from: VimPos, backwards: boolean) => {
			const at = new Position(from.line + 1, from.col + 1);
			const r = withModel(lines(), m => backwards ? m.findPreviousMatch(q.pattern, at, true, q.matchCase, sep(q), true) : m.findNextMatch(q.pattern, at, true, q.matchCase, sep(q), true));
			return r ? toVimMatch(r) : undefined;
		},
		// the find widget's replace string, simply ($n $& \n \t); the real one is tested in test/browser/vimSubstitute.test.ts
		replaceString: (rep: string, m: VimMatch) => rep.replace(/\\([nt\\])|\$(\d|&)/g, (_, esc: string | undefined, g: string | undefined) =>
			esc ? (esc === 'n' ? '\n' : esc === 't' ? '\t' : '\\') : (m.groups[g === '&' ? 0 : Number(g)] ?? '')),
	};
}
