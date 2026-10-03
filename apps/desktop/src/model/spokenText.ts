/**
 * Where dictated words meet other words, and whether a space goes between.
 *
 * Two places join text that was spoken: main, joining the segments Whisper
 * cut a recording into (`main/voice/whisper.ts`), and the composer, putting a
 * transcript in among what was already typed (`shell/conversation/dictation.ts`).
 * Both follow one rule, so it is written once: Latin text meets with a space,
 * and wherever either side is Japanese (or Chinese) it meets with none,
 * because those scripts have no spaces to put back. Text that already has
 * whitespace at the seam needs no more.
 */

const CJK_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Han, kana, and the CJK punctuation and full-width forms written with them. */
export function isCjk(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    CJK_SCRIPTS.test(character) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/** Whether `before` (a character) and `after` (a character) meet with a space. */
export function needsSpace(before: string, after: string): boolean {
  if (before === "" || after === "") return false;
  return !isCjk(before) && !isCjk(after) && !/\s/u.test(before + after);
}
