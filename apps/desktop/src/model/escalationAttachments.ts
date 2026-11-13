/**
 * An escalation's `--attach` pictures, read back out of its Markdown.
 *
 * Main writes them as the `## 添付` section the question ends with
 * (`writeEscalationAttachments`, `main/orchestrator/attachments.ts`): each
 * picture under its caption, or its name, pointing at its copy in the
 * escalation's own folder. That section is what `escalation show` prints and
 * what the board's card takes its thumbnail from, so it stays the record;
 * the task view draws it the way the conversation draws the pictures
 * attached to a message (a row of thumbnails, `ImageStrip`) instead of as
 * Markdown, and only when the whole section is in exactly that shape — a
 * section written by hand, or anything after it, is left to the renderer.
 */

/** The section's heading, as main writes it. */
export const ATTACHMENTS_HEADING = "添付";

export interface EscalationAttachment {
  /** The copy in the escalation's folder: absolute, on this Mac. */
  readonly path: string;
  /** The file's own name, as it was attached. */
  readonly name: string;
  /** What `--attach FILE=CAPTION` said of it. */
  readonly caption?: string;
}

const HEADING = new RegExp(`^## ${ATTACHMENTS_HEADING}[ \\t]*$`, "gmu");
const NAME_ONLY = /^\*([^*\n]+)\*$/u;
const CAPTIONED = /^\*\*([^\n]+?)\*\* — \*([^*\n]+)\*$/u;
const PICTURE = /^!\[[^\]\n]*\]\(<([^>\n]+)>\)$/u;

/**
 * The question's Markdown without its `## 添付` section, and the pictures
 * the section names, in order. No section in main's shape: the Markdown as
 * it is, and none.
 */
export function splitAttachments(markdown: string): {
  readonly body: string;
  readonly attachments: readonly EscalationAttachment[];
} {
  const whole = { body: markdown, attachments: [] };
  const last = [...markdown.matchAll(HEADING)].at(-1);
  if (last === undefined) return whole;
  const blocks = markdown
    .slice(last.index + last[0].length)
    .split(/\n[ \t]*\n/u)
    .map((block) => block.trim())
    .filter((block) => block !== "");
  if (blocks.length === 0 || blocks.length % 2 !== 0) return whole;
  const attachments: EscalationAttachment[] = [];
  for (let at = 0; at < blocks.length; at += 2) {
    const label = blocks[at]!;
    const picture = PICTURE.exec(blocks[at + 1]!);
    const captioned = CAPTIONED.exec(label);
    const named = captioned === null ? NAME_ONLY.exec(label) : null;
    if (picture === null || (captioned === null && named === null))
      return whole;
    attachments.push(
      captioned === null
        ? { path: picture[1]!, name: named![1]! }
        : { path: picture[1]!, name: captioned[2]!, caption: captioned[1]! },
    );
  }
  return {
    body: markdown.slice(0, last.index).replace(/\s+$/u, ""),
    attachments,
  };
}
