/**
 * Where a streaming answer stops being final.
 *
 * An assistant entry that is still streaming grows at its end and nowhere
 * else, so its Markdown is two parts: a prefix whose blocks can no longer
 * change, and a tail that the next delta may still rewrite. The prefix is
 * drawn once and kept; only the tail is parsed again on every delta. And a
 * code block is highlighted only once it is in the prefix — a fence still
 * open would be tokenized again on every delta, and would flicker between
 * colourings as its grammar state moved under it.
 *
 * A block is settled once a line after it proves it has ended: a blank line
 * outside a fence, or the fence's own closing line. Only lines that have
 * ended count, because the last line of a delta may still be growing — "```"
 * becomes "``` js" and stops closing anything.
 */

interface Fence {
  readonly marker: "`" | "~";
  readonly length: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function fenceOpening(line: string): Fence | undefined {
  const match = FENCE.exec(line);
  if (!match) return undefined;
  const run = match[1]!;
  const marker = run[0] as "`" | "~";
  // CommonMark: a backtick fence's info string cannot contain a backtick.
  if (marker === "`" && match[2]!.includes("`")) return undefined;
  return { marker, length: run.length };
}

function closes(line: string, open: Fence): boolean {
  const match = FENCE.exec(line);
  if (!match) return false;
  const run = match[1]!;
  return (
    run[0] === open.marker &&
    run.length >= open.length &&
    match[2]!.trim() === ""
  );
}

/** The length of the prefix of `markdown` whose blocks are final. */
export function settledLength(markdown: string): number {
  let settled = 0;
  let open: Fence | undefined;
  let start = 0;
  for (;;) {
    const newline = markdown.indexOf("\n", start);
    // An unterminated last line is still being written.
    if (newline < 0) return settled;
    const line = markdown.slice(start, newline);
    const end = newline + 1;
    if (open) {
      if (closes(line, open)) {
        open = undefined;
        settled = end;
      }
    } else if (line.trim() === "") {
      settled = end;
    } else {
      open = fenceOpening(line);
    }
    start = end;
  }
}
