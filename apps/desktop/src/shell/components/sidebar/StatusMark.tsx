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
}

export function StatusMark({ status }: StatusMarkProps) {
  const label = statusLabel(status);
  return (
    <span
      className={`status-mark status-mark-${status}`}
      data-status={status}
      title={label}
      aria-label={label}
      role="img"
    >
      <Glyph name={GLYPH_FOR[status]} className="status-glyph" />
    </span>
  );
}
