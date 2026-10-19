/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { KEYWORD_CLASS_SOURCES, ScriptClass, ScriptWordBoundaries, scriptClassAt } from '../../../common/core/scriptWordBoundaries.js';

suite('DevHub: script classes and word boundaries between scripts', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => ScriptWordBoundaries.setEnabled(true));
	teardown(() => ScriptWordBoundaries.setEnabled(false));

	/** The words of a line with space / tab as the only separators. */
	const words = (line: string) => ScriptWordBoundaries.wordsOnLine(line, c => c !== 0x20 && c !== 0x09, null).map(s => s.segment);
	/** Every UTF-16 index of `text`. */
	const indices = (text: string) => Array.from({ length: text.length }, (_, i) => i);
	const classes = (line: string) => indices(line).map(i => scriptClassAt(line, i));

	test('classes', () => {
		const Blank = ScriptClass.Blank, Punctuation = ScriptClass.Punctuation, Word = ScriptClass.Word, Emoji = ScriptClass.Emoji, CjkPunctuation = ScriptClass.CjkPunctuation;
		const Hiragana = ScriptClass.Hiragana, Katakana = ScriptClass.Katakana, Kanji = ScriptClass.Kanji, FullwidthAlnum = ScriptClass.FullwidthAlnum, Hangul = ScriptClass.Hangul;
		assert.deepStrictEqual(classes('漢ひカＡ１a_ -'), [Kanji, Hiragana, Katakana, FullwidthAlnum, FullwidthAlnum, Word, Word, Blank, Punctuation]);
		assert.deepStrictEqual(classes('、。「」・'), [CjkPunctuation, CjkPunctuation, CjkPunctuation, CjkPunctuation, CjkPunctuation]);
		assert.deepStrictEqual(classes('々〆ーｰ한　'), [Kanji, Kanji, Katakana, Katakana, Hangul, Blank]);
		// both halves of a pair are the pair; a ZWJ sequence and a modifier are one emoji
		assert.deepStrictEqual(classes('😀'), [Emoji, Emoji]);
		assert.ok(classes('👨‍👩‍👧👍🏽').every(c => c === Emoji));
		// a combining mark is its base character's; ー after hiragana is hiragana
		assert.deepStrictEqual(classes('é'), [Word, Word]);
		assert.deepStrictEqual(classes('すごーい'), [Hiragana, Hiragana, Hiragana, Hiragana]);
		assert.strictEqual(scriptClassAt('a', 1), Blank, 'past the end');
	});

	test('words: 漢字ひらがな, カタカナ漢字, 全角英数, mixed ASCII, punctuation, emoji', () => {
		assert.deepStrictEqual(words('漢字ひらがな'), ['漢字', 'ひらがな']);
		assert.deepStrictEqual(words('カタカナ漢字'), ['カタカナ', '漢字']);
		assert.deepStrictEqual(words('全角ＡＢＣ１２３です'), ['全角', 'ＡＢＣ１２３', 'です']);
		assert.deepStrictEqual(words('fooバーbaz_qux 日本'), ['foo', 'バー', 'baz_qux', '日本']);
		assert.deepStrictEqual(words('漢字、。「かな」'), ['漢字', '、。「', 'かな', '」']);
		assert.deepStrictEqual(words('絵文字😀😀だ👨‍👩‍👧よ'), ['絵文字', '😀😀', 'だ', '👨‍👩‍👧', 'よ']);
		assert.deepStrictEqual(words('人々は東京へ'), ['人々', 'は', '東京', 'へ']);
		assert.deepStrictEqual(words('abc　def'), ['abc', 'def'], 'the ideographic space is a blank');
		assert.deepStrictEqual(words('éàü日本'), ['éàü', '日本']);
	});

	test('words leave separators to the classifier and refine Intl.Segmenter\'s words', () => {
		const sep = (line: string) => ScriptWordBoundaries.wordsOnLine(line, c => c !== 0x20 && c !== 0x2e && c !== 0x306e /* の */, null).map(s => s.segment);
		assert.deepStrictEqual(sep('日本語の文章.txt'), ['日本語', '文章', 'txt']);
		const line = '東京都ではカタカナ';
		const intl = [{ segment: '東京都', index: 0 }, { segment: 'では', index: 3 }, { segment: 'カタカナ', index: 5 }];
		assert.deepStrictEqual(ScriptWordBoundaries.wordsOnLine(line, () => true, intl).map(s => s.segment), ['東京都', 'では', 'カタカナ']);
		assert.deepStrictEqual(ScriptWordBoundaries.wordsOnLine('漢字かな', () => true, [{ segment: '漢字かな', index: 0 }]).map(s => s.segment), ['漢字', 'かな']);
	});

	test('boundaries: only where a CJK script, an emoji or a blank is on one side', () => {
		const at = (text: string) => indices(text).filter(i => ScriptWordBoundaries.isBoundary(text, i));
		assert.deepStrictEqual(at('foo-bar'), [], 'ASCII is wordSeparators\' business');
		assert.deepStrictEqual(at('éa-b'), []);
		assert.deepStrictEqual(at('漢字ひらがな'), [2]);
		assert.deepStrictEqual(at('a😀b'), [1, 3], 'never inside the pair');
		assert.deepStrictEqual(at('foo、bar'), [3, 4]);
		ScriptWordBoundaries.setEnabled(false);
		assert.deepStrictEqual(at('漢字ひらがな'), []);
	});

	test('narrowWord: the run at the cursor, the last one at the end', () => {
		const narrow = (word: string, column: number) => ScriptWordBoundaries.narrowWord({ word, startColumn: 1, endColumn: word.length + 1 }, column).word;
		assert.strictEqual(narrow('漢字ひらがなカナ', 1), '漢字');
		assert.strictEqual(narrow('漢字ひらがなカナ', 2), '漢字');
		assert.strictEqual(narrow('漢字ひらがなカナ', 3), 'ひらがな');
		assert.strictEqual(narrow('漢字ひらがなカナ', 9), 'カナ');
		assert.strictEqual(narrow('foo_bar', 3), 'foo_bar');
	});

	test('the keyword classes partition [\\p{L}\\p{N}_] as scriptClassAt does', () => {
		const res = KEYWORD_CLASS_SOURCES.map(s => new RegExp(`^(?:${s})$`, 'u'));
		for (const ch of ['漢', 'ひ', 'カ', 'ー', 'Ａ', '１', 'a', '_', 'é', '한', '々']) {
			assert.strictEqual(res.filter(r => r.test(ch)).length, 1, ch);
		}
	});
});
