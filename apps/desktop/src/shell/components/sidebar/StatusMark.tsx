/**
 * What an Agent is doing, drawn as the Agent row's leading glyph.
 *
 * The vocabulary is not invented here. It is VS Code's, taken from the sibling
 * extension `vscode-herdr-switcher` (`src/agentPresentation.ts`), so that the
 * same Agent means the same thing in the editor sidebar and in DevHub's:
 *
 *   DevHub status    means                       theme colour   extension case
 *   working          it is going somewhere       charts.yellow  working
 *   waiting          it has stopped to ask you   charts.blue    done
 *   idle             nothing is wrong here       iconPassed     idle
 *   error            it was read and came back   iconFailed     blocked
 *                    wrong
 *   unknown          nobody can read this one    (muted ink)    unknown
 *
 * DevHub's `waiting` is the extension's `blocked` and DevHub's `error` is a
 * status that was read and came back wrong; the pairing is by what a mark
 * means, not by the name it came from.
 *
 * What is *not* inherited is the drawing. Those were codicon outlines carried
 * verbatim, and a codicon is drawn for a 16-pixel box: at the fourteen the
 * Sidebar renders, `loading` was a hairline crescent and `question` was a grey
 * smudge, and `circle-filled` was the same blue disc as the unread mark
 * sixteen pixels to its left. The silhouettes are DevHub's own now and they
 * live with every other Sidebar mark in `icons.tsx`, on one grid at one
 * weight. The colours are still the extension's, carried by the `--status-*`
 * tokens, which is where the mapping from a VS Code theme colour to DevHub ink
 * is written.
 *
 * Shape carries the whole meaning: a ring, a bubble, a check, a triangle and a
 * dash are five different silhouettes, so the status survives greyscale,
 * Increase Contrast and a colour-blind reader, and the colour is the second
 * telling and never the only one.
 *
 * The status is the glyph, not a dot beside it: a row has one leading mark,
 * and what an Agent is doing is the thing worth putting there.
 */

import type { AgentStatus } from "../../../ipc/appShell";
import type { GlyphName } from "./icons";
import { Glyph } from "./icons";
import { statusLabel } from "./status";

const GLYPH_FOR: Record<AgentStatus, GlyphName> = {
  working: "statusWorking",
  waiting: "statusWaiting",
  idle: "statusIdle",
  error: "statusError",
  unknown: "statusUnknown",
};

export interface StatusMarkProps {
  readonly status: AgentStatus;
  /**
   * The status this Agent went into while nobody was watching, or nothing.
   *
   * It is drawn by this mark and by nothing else. See `unreadShows`.
   */
  readonly unread?: AgentStatus | undefined;
}

/**
 * Whether being unread is what this mark should say.
 *
 * Unread used to be a second element — a dot in the row's leading rail, beside
 * the status glyph — and the two were about the same Agent at the same moment
 * saying two different things. That is one mark too many in a column 16 pixels
 * wide, and it was the wrong one: *unread* only adds anything while the Agent
 * is idle. An Agent that is working, waiting, in error or unreadable is already
 * asking to be looked at, and its own mark says so in its own colour; putting
 * a dot beside it says "and also look at it".
 *
 * So there is one mark, and this is the whole rule: idle and unread is drawn as
 * the unread mark, everything else is drawn as its status. Nothing else in the
 * Sidebar draws `unread` — the model's rule for when an Agent *becomes* unread
 * is untouched, this is only what it looks like.
 */
export function unreadShows(
  status: AgentStatus,
  unread: AgentStatus | undefined,
): boolean {
  return status === "idle" && unread !== undefined;
}

export function StatusMark({ status, unread }: StatusMarkProps) {
  const showsUnread = unreadShows(status, unread);
  const label = showsUnread
    ? `${statusLabel(status)}, unread`
    : statusLabel(status);
  return (
    <span
      className={`status-mark status-mark-${status}${showsUnread ? " is-unread" : ""}`}
      data-status={status}
      data-unread={showsUnread ? "true" : undefined}
      data-tooltip={label}
      aria-label={label}
      role="img"
    >
      <Glyph
        name={showsUnread ? "statusUnread" : GLYPH_FOR[status]}
        className="status-glyph"
      />
    </span>
  );
}
