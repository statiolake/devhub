/**
 * Which dollar signs and backslash brackets in an answer are math.
 *
 * `remark-math` reads `$…$` as math wherever a second `$` follows, so "$5 and
 * $10" would become a formula. This rewrites the source first, outside code,
 * with pandoc's rules: an opening `$` is followed by a non-space, a closing
 * one is preceded by a non-space and not followed by a digit. A `$` that
 * opens nothing is escaped (`\$`), and `\(…\)` / `\[…\]` become `$…$` /
 * `$$…$$`, which are the delimiters `remark-math` knows. Fenced blocks, inline
 * code and existing `$$…$$` spans are copied as they are. A delimiter still
 * waiting for its partner (a streaming answer) is left as text.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

/** The end of the code span opened by the backtick run at `i`, or just past the run. */
function codeSpanEnd(text: string, i: number): number {
  let end = i;
  while (text[end] === "`") end++;
  const length = end - i;
  let at = end;
  while (at < text.length) {
    if (text[at] !== "`") {
      at++;
      continue;
    }
    let stop = at;
    while (text[stop] === "`") stop++;
    if (stop - at === length) return stop;
    at = stop;
  }
  return end;
}

/** A paragraph that is one `$$…$$` is a display block, not inline math. */
function display(text: string): string {
  const m = /^(\s*)\$\$([^$]+)\$\$\s*$/.exec(text);
  return m ? `${m[1]}$$\n${m[2]!.trim()}\n$$` : text;
}

function paragraph(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === "(" || next === "[") {
        const close = text.indexOf(next === "(" ? "\\)" : "\\]", i + 2);
        const inner = close < 0 ? "" : text.slice(i + 2, close).trim();
        if (close >= 0 && inner !== "") {
          out += next === "(" ? `$${inner}$` : `$$${inner}$$`;
          i = close + 2;
          continue;
        }
      }
      out += text.slice(i, i + 2);
      i += 2;
    } else if (ch === "`") {
      const stop = codeSpanEnd(text, i);
      out += text.slice(i, stop);
      i = stop;
    } else if (ch === "$") {
      if (text[i + 1] === "$") {
        const close = text.indexOf("$$", i + 2);
        const stop = close < 0 ? i + 2 : close + 2;
        out += text.slice(i, stop);
        i = stop;
        continue;
      }
      let close = -1;
      if (!isSpace(text[i + 1])) {
        for (let j = i + 1; j < text.length; j++) {
          if (text[j] === "\\") {
            j++;
            continue;
          }
          if (text[j] !== "$" || text[j + 1] === "$") continue;
          if (!isSpace(text[j - 1]) && !/\d/.test(text[j + 1] ?? "")) {
            close = j;
            break;
          }
        }
      }
      if (close < 0) {
        out += "\\$";
        i++;
      } else {
        out += text.slice(i, close + 1);
        i = close + 1;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export function normalizeMath(source: string): string {
  if (!source.includes("$") && !source.includes("\\")) return source;
  const out: string[] = [];
  let prose: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  const flush = () => {
    if (prose.length > 0) out.push(display(paragraph(prose.join("\n"))));
    prose = [];
  };
  for (const line of source.split("\n")) {
    const m = FENCE.exec(line);
    if (fence) {
      out.push(line);
      if (
        m &&
        m[1]![0] === fence.marker &&
        m[1]!.length >= fence.length &&
        line.trim() === m[1]
      ) {
        fence = undefined;
      }
    } else if (m) {
      flush();
      fence = { marker: m[1]![0]!, length: m[1]!.length };
      out.push(line);
    } else if (line.trim() === "") {
      flush();
      out.push(line);
    } else if (/^( {4}|\t)/.test(line) && prose.length === 0) {
      out.push(line); // indented code
    } else {
      prose.push(line);
    }
  }
  flush();
  return out.join("\n");
}
