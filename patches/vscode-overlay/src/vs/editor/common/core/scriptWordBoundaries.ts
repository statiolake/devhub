/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: word boundaries between scripts (`devhub.editor.wordBoundariesByScript`).
//
// Japanese is written without spaces, so to VS Code `日本語の文章をカタカナで`
// is one word: Alt+Left / Alt+Right, Alt+Backspace / Alt+Delete, a double
// click, Cmd+D and the word highlight take the whole run. Vim splits it where
// the script changes (`:help utf_class`: kanji, hiragana and katakana are
// classes of their own, as punctuation and blanks are), which is how a
// Japanese reader sees the words too: 日本語 / の / 文章 / を / カタカナ / で.
//
// This file is that rule, for both: the classes (`scriptClassAt`), and where
// the editor's word operations ask for words, the boundaries:
//
// * WordCharacterClassifier (wordCharacterClassifier.ts), the classifier
//   behind `editor.wordSeparators` that cursor word moves, word deletes and
//   double-click selection use, gets the words of a line from `wordsOnLine`:
//   its runs of word characters split where the script changes. VS Code
//   already reads those as it reads `editor.wordSegmenterLocales`' words
//   (Intl.Segmenter), so nothing else in the word operations changes; with
//   locales set, their segments are split at the script changes too.
// * getWordAtText (wordHelper.ts), the language's word definition behind the
//   word under the cursor (Cmd+D, the word highlight, the find widget's
//   seed, completion's word), narrows the word it found to the script run at
//   the cursor (`narrowWord`).
// * A whole-word match (textModelSearch.ts isValidMatch: Cmd+D's next match,
//   the highlight's occurrences, find with "Match Whole Word") also ends where
//   the script changes (`isBoundary`).
// * DevHub's Vim (src/vs/workbench/contrib/devhubVim/common/vimText.ts
//   charClassAt) takes the classes of its `w b e ge iw aw * \< \>` from
//   `scriptClassAt`, as Vim's utf_class (punctuation of every script is one
//   class there, and every class change is a boundary).
//
// What is a boundary for the editor: two neighbouring characters of
// different classes where at least one is CJK (kanji, hiragana, katakana,
// fullwidth letters and digits, CJK punctuation, hangul) or an emoji. A
// change between ASCII / Latin letters and ASCII punctuation is no boundary
// here: that stays `editor.wordSeparators`' and the language's word
// definition's (so `foo-bar` in CSS and `a.b` are what they were). A line
// with no character past ASCII is left entirely to VS Code.
//
// The switch is global (one setting for every editor). It is off here, so
// the editor without DevHub's workbench (and VS Code's own tests) is VS
// Code's; the workbench (src/vs/workbench/contrib/devhubWordBoundaries) turns
// it on at startup, before any editor exists, unless the setting (on by
// default) says otherwise.

export const enum ScriptClass {
	Blank = 0,
	Punctuation = 1,
	Word = 2,
	Emoji = 3,
	CjkPunctuation = 4,
	Hiragana = 5,
	Katakana = 6,
	Kanji = 7,
	FullwidthAlnum = 8,
	Hangul = 9,
}

// Each class as a regular expression character class (with the `u` flag); the
// order of `CLASSES` is the order they are tried in.
const BLANK = '[\\s\\u00a0\\u3000]';
/** Combining marks, ZWJ, emoji modifiers and variation selectors: the class of the character before. */
const INHERIT = '[\\p{M}\\u200d\\p{Emoji_Modifier}]';
const HIRAGANA = '\\p{Script=Hiragana}';
// ー ｰ (the long vowel mark) and the halfwidth voiced marks are Common, but katakana's
// (ー after hiragana is hiragana's, scriptClassAt)
const KATAKANA = '[\\p{Script=Katakana}\\u30fc\\uff70\\uff9e\\uff9f]';
// 々 〇 are Han; 〆 is not, but is written as a kanji
const KANJI = '[\\p{Script=Han}\\u3006]';
const FULLWIDTH_ALNUM = '[\\uff10-\\uff19\\uff21-\\uff3a\\uff41-\\uff5a]';
const HANGUL = '\\p{Script=Hangul}';
const EMOJI = '[\\p{Extended_Pictographic}\\p{Regional_Indicator}]';
const CJK_PUNCTUATION = '[\\u3001-\\u303f\\u30a0\\u30fb\\ufe30-\\ufe4f\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65]';
const WORD = '[\\p{L}\\p{N}_]';

const INHERIT_RE = new RegExp(INHERIT, 'u');
const CLASSES: readonly [RegExp, ScriptClass][] = [
	[new RegExp(BLANK, 'u'), ScriptClass.Blank],
	[new RegExp(EMOJI, 'u'), ScriptClass.Emoji],
	[new RegExp(HIRAGANA, 'u'), ScriptClass.Hiragana],
	[new RegExp(KATAKANA, 'u'), ScriptClass.Katakana],
	[new RegExp(KANJI, 'u'), ScriptClass.Kanji],
	[new RegExp(HANGUL, 'u'), ScriptClass.Hangul],
	[new RegExp(FULLWIDTH_ALNUM, 'u'), ScriptClass.FullwidthAlnum],
	[new RegExp(CJK_PUNCTUATION, 'u'), ScriptClass.CjkPunctuation],
	[new RegExp(WORD, 'u'), ScriptClass.Word],
];

/**
 * The keyword classes as regular expression sources (for a pattern with the
 * `u` flag): every keyword character (`[\p{L}\p{N}_]`) is in exactly one.
 * DevHub Vim's `\<` / `\>` end a word where the class changes, as Vim's do.
 */
export const KEYWORD_CLASS_SOURCES: readonly string[] = [
	HIRAGANA, KATAKANA, KANJI, HANGUL, FULLWIDTH_ALNUM,
	`(?!${HIRAGANA}|${KATAKANA}|${KANJI}|${HANGUL}|${FULLWIDTH_ALNUM})${WORD}`,
];

function classOfCodePoint(cp: number): ScriptClass | undefined {
	if (cp < 0x80) {
		if (cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d) {
			return ScriptClass.Blank;
		}
		return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f ? ScriptClass.Word : ScriptClass.Punctuation;
	}
	const ch = String.fromCodePoint(cp);
	if (INHERIT_RE.test(ch)) {
		return undefined;
	}
	for (const [re, cls] of CLASSES) {
		if (re.test(ch)) {
			return cls;
		}
	}
	return ScriptClass.Punctuation;
}

/** The code point the UTF-16 unit at `index` belongs to, and where it starts. */
function codePointAt(text: string, index: number): { cp: number; start: number } {
	const unit = text.charCodeAt(index);
	if (unit >= 0xdc00 && unit <= 0xdfff && index > 0) {
		const high = text.charCodeAt(index - 1);
		if (high >= 0xd800 && high <= 0xdbff) {
			return { cp: text.codePointAt(index - 1)!, start: index - 1 };
		}
	}
	return { cp: text.codePointAt(index)!, start: index };
}

/**
 * The class of the character at UTF-16 `index` of `text` (either half of a
 * surrogate pair is the pair; a combining mark is its base character's).
 * Past the end it is Blank.
 */
export function scriptClassAt(text: string, index: number): ScriptClass {
	let i = index;
	while (i >= 0 && i < text.length) {
		const { cp, start } = codePointAt(text, i);
		const cls = classOfCodePoint(cp);
		if (cls === ScriptClass.Katakana && (cp === 0x30fc || cp === 0xff70) && start > 0 && scriptClassAt(text, start - 1) === ScriptClass.Hiragana) {
			return ScriptClass.Hiragana; // ー lengthens the kana before it: すごーい is one word
		}
		if (cls !== undefined) {
			return cls;
		}
		i = start - 1;
	}
	return i < 0 && index < text.length ? ScriptClass.Word : ScriptClass.Blank;
}

function isCjk(cls: ScriptClass): boolean {
	return cls !== ScriptClass.Word && cls !== ScriptClass.Punctuation && cls !== ScriptClass.Blank;
}

/** Whether the editor's words end between characters of classes `a` and `b` (a blank always ends one). */
function separates(a: ScriptClass, b: ScriptClass): boolean {
	return a !== b && (isCjk(a) || isCjk(b) || a === ScriptClass.Blank || b === ScriptClass.Blank);
}

function hasNonAscii(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) >= 0x80) {
			return true;
		}
	}
	return false;
}

/** A word of a line, the shape WordCharacterClassifier reads Intl.Segmenter's in. */
export interface IScriptWordSegment {
	readonly segment: string;
	readonly index: number;
	readonly input: string;
	readonly isWordLike: true;
}

class ScriptWordBoundariesImpl {

	private _enabled = false;

	get enabled(): boolean {
		return this._enabled;
	}

	/** The workbench, from `devhub.editor.wordBoundariesByScript`. */
	setEnabled(enabled: boolean): void {
		this._enabled = enabled;
	}

	/** Whether the rule has anything to say about `line` (it is on, and the line is not all ASCII). */
	appliesTo(line: string): boolean {
		return this._enabled && hasNonAscii(line);
	}

	/**
	 * WordCharacterClassifier: the words of `line`, in order. `isWordChar` is
	 * the classifier's own test (not a separator, not whitespace); `segments`,
	 * when given, are Intl.Segmenter's word-like segments
	 * (`editor.wordSegmenterLocales`), which are split further. Without them
	 * the words are the runs of word characters. Either way a word ends where
	 * the script changes, and blanks other than space and tab (the ideographic
	 * space) end it too.
	 */
	wordsOnLine(line: string, isWordChar: (charCode: number) => boolean, segments: readonly { segment: string; index: number }[] | null): IScriptWordSegment[] {
		const out: IScriptWordSegment[] = [];
		const split = (from: number, to: number) => {
			let start = -1;
			let prev = ScriptClass.Blank;
			for (let i = from; i < to; i++) {
				const unit = line.charCodeAt(i);
				if (unit >= 0xdc00 && unit <= 0xdfff && i > from && start >= 0) {
					continue; // the second half of a pair: the pair's class was taken
				}
				const cls = scriptClassAt(line, i);
				const inWord = cls !== ScriptClass.Blank && (segments !== null || isWordChar(unit));
				if (start >= 0 && (!inWord || separates(prev, cls))) {
					out.push({ segment: line.substring(start, i), index: start, input: line, isWordLike: true });
					start = -1;
				}
				if (inWord && start < 0) {
					start = i;
				}
				prev = cls;
			}
			if (start >= 0) {
				out.push({ segment: line.substring(start, to), index: start, input: line, isWordLike: true });
			}
		};
		if (segments) {
			for (const s of segments) {
				split(s.index, s.index + s.segment.length);
			}
		} else {
			split(0, line.length);
		}
		return out;
	}

	/**
	 * getWordAtText: the part of `word` (found by the language's word
	 * definition) in one script, the one at `column` (the character after the
	 * caret; at the word's end, its last part).
	 */
	narrowWord<T extends { readonly word: string; readonly startColumn: number; readonly endColumn: number }>(word: T, column: number): T | { word: string; startColumn: number; endColumn: number } {
		const text = word.word;
		if (!this.appliesTo(text)) {
			return word;
		}
		const at = Math.max(0, Math.min(text.length, column - word.startColumn));
		let start = 0;
		let end = text.length;
		for (let i = 1; i < text.length; i++) {
			if (this.isBoundary(text, i)) {
				if (i <= at) {
					start = i;
				} else {
					end = i;
					break;
				}
			}
		}
		return start === 0 && end === text.length ? word : { word: text.substring(start, end), startColumn: word.startColumn + start, endColumn: word.startColumn + end };
	}

	/** Whether a word ends between UTF-16 units `index - 1` and `index` of `text` because the script changes there. */
	isBoundary(text: string, index: number): boolean {
		if (!this._enabled || index <= 0 || index >= text.length) {
			return false;
		}
		const unit = text.charCodeAt(index);
		if (unit >= 0xdc00 && unit <= 0xdfff) {
			const high = text.charCodeAt(index - 1);
			if (high >= 0xd800 && high <= 0xdbff) {
				return false; // inside a surrogate pair
			}
		}
		if (text.charCodeAt(index - 1) < 0x80 && unit < 0x80) {
			return false;
		}
		return separates(scriptClassAt(text, index - 1), scriptClassAt(text, index));
	}
}

export const ScriptWordBoundaries = new ScriptWordBoundariesImpl();
