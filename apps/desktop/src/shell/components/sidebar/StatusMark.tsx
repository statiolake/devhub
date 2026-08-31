/**
 * What an Agent is doing, drawn as the Agent row's leading glyph.
 *
 * The vocabulary is not invented here. It is VS Code's, taken from the sibling
 * extension `vscode-herdr-switcher` (`src/agentPresentation.ts`), so that the
 * same Agent looks the same in the editor sidebar and in DevHub's Sidebar:
 *
 *   DevHub status    codicon         theme colour         extension case
 *   working          loading (spun)  charts.yellow        working
 *   waiting          circle-filled   charts.blue          done
 *   idle             check           testing.iconPassed   idle
 *   error            warning         testing.iconFailed   blocked
 *   unknown          question        (muted ink)          unknown
 *
 * The right-hand column is where the two differ, and deliberately. DevHub's
 * `waiting` is the extension's `blocked` — an Agent that has stopped to ask
 * you something — and DevHub's `error` is a status that was read and came back
 * wrong. The extension's `done` disc is the "it wants you" mark and its
 * `blocked` warning is the "something is wrong" mark, so those are the marks
 * each DevHub status takes. The pairing is by what the mark means, not by the
 * name it came from.
 *
 * The path data below is the codicon outline itself, on the codicon's own
 * 16-unit box, so the silhouettes are the extension's and not an approximation
 * of them; the theme colours are carried by the `--status-*` tokens, which is
 * where the mapping from a VS Code theme colour to DevHub ink is written.
 *
 * `unknown` is the mark for an Agent whose screen DevHub has no detector for —
 * a profile that names a command and no manifest. It is a permanent, correct
 * answer rather than a stage on the way to another one, so it gets the
 * extension's `unknown` glyph and muted ink: legible, and plainly not a claim
 * about what the Agent is doing.
 *
 * The status is the glyph, not a dot beside it: a row has one leading mark,
 * and what an Agent is doing is the thing worth putting there.
 */

import type { AgentStatus } from "../../../ipc/appShell";
import { statusLabel } from "./status";

function StatusIcon({ status }: { readonly status: AgentStatus }) {
  switch (status) {
    case "working":
      // codicon `loading`: an open arc, spun by the stylesheet.
      return (
        <path d="M13.5 8.5C13.224 8.5 13 8.276 13 8C13 5.243 10.757 3 8 3C5.243 3 3 5.243 3 8C3 8.276 2.776 8.5 2.5 8.5C2.224 8.5 2 8.276 2 8C2 4.691 4.691 2 8 2C11.309 2 14 4.691 14 8C14 8.276 13.776 8.5 13.5 8.5Z" />
      );
    case "waiting":
      // codicon `circle-filled`: the Agent has stopped to ask you something,
      // and a filled disc is the mark the extension puts on the Agent that
      // wants attention.
      return (
        <path d="M8 4C8.36719 4 8.72135 4.04818 9.0625 4.14453C9.40365 4.23828 9.72135 4.3724 10.0156 4.54688C10.3125 4.72135 10.582 4.93099 10.8242 5.17578C11.069 5.41797 11.2786 5.6875 11.4531 5.98438C11.6276 6.27865 11.7617 6.59635 11.8555 6.9375C11.9518 7.27865 12 7.63281 12 8C12 8.36719 11.9518 8.72135 11.8555 9.0625C11.7617 9.40365 11.6276 9.72266 11.4531 10.0195C11.2786 10.3138 11.069 10.5833 10.8242 10.8281C10.582 11.0703 10.3125 11.2786 10.0156 11.4531C9.72135 11.6276 9.40365 11.763 9.0625 11.8594C8.72135 11.9531 8.36719 12 8 12C7.63281 12 7.27865 11.9531 6.9375 11.8594C6.59635 11.763 6.27734 11.6276 5.98047 11.4531C5.6862 11.2786 5.41667 11.0703 5.17188 10.8281C4.92969 10.5833 4.72135 10.3138 4.54688 10.0195C4.3724 9.72266 4.23698 9.40365 4.14062 9.0625C4.04688 8.72135 4 8.36719 4 8C4 7.63281 4.04688 7.27865 4.14062 6.9375C4.23698 6.59635 4.3724 6.27865 4.54688 5.98438C4.72135 5.6875 4.92969 5.41797 5.17188 5.17578C5.41667 4.93099 5.6862 4.72135 5.98047 4.54688C6.27734 4.3724 6.59635 4.23828 6.9375 4.14453C7.27865 4.04818 7.63281 4 8 4Z" />
      );
    case "idle":
      // codicon `check`.
      return (
        <path d="M13.6572 3.13573C13.8583 2.9465 14.175 2.95614 14.3643 3.15722C14.5535 3.35831 14.5438 3.675 14.3428 3.86425L5.84277 11.8642C5.64597 12.0494 5.33756 12.0446 5.14648 11.8535L1.64648 8.35351C1.45121 8.15824 1.45121 7.84174 1.64648 7.64647C1.84174 7.45121 2.15825 7.45121 2.35351 7.64647L5.50976 10.8027L13.6572 3.13573Z" />
      );
    case "error":
      // codicon `warning`: the one silhouette that is not round, so a status
      // nobody could read is never one more circle in a column of circles.
      return (
        <path d="M14.831 11.965L9.206 1.714C8.965 1.274 8.503 1 8 1C7.497 1 7.035 1.274 6.794 1.714L1.169 11.965C1.059 12.167 1 12.395 1 12.625C1 13.383 1.617 14 2.375 14H13.625C14.383 14 15 13.383 15 12.625C15 12.395 14.941 12.167 14.831 11.965ZM13.625 13H2.375C2.168 13 2 12.832 2 12.625C2 12.561 2.016 12.5 2.046 12.445L7.671 2.195C7.736 2.075 7.863 2 8 2C8.137 2 8.264 2.075 8.329 2.195L13.954 12.445C13.984 12.501 14 12.561 14 12.625C14 12.832 13.832 13 13.625 13ZM8.75 11.25C8.75 11.664 8.414 12 8 12C7.586 12 7.25 11.664 7.25 11.25C7.25 10.836 7.586 10.5 8 10.5C8.414 10.5 8.75 10.836 8.75 11.25ZM7.5 9V5.5C7.5 5.224 7.724 5 8 5C8.276 5 8.5 5.224 8.5 5.5V9C8.5 9.276 8.276 9.5 8 9.5C7.724 9.5 7.5 9.276 7.5 9Z" />
      );
    case "unknown":
      // codicon `question`: a ring with a query inside it, so a status nobody
      // took is visibly a question rather than a fifth kind of verdict.
      return (
        <>
          <path d="M8 11C8.41421 11 8.75 11.3358 8.75 11.75C8.75 12.1642 8.41421 12.5 8 12.5C7.58579 12.5 7.25 12.1642 7.25 11.75C7.25 11.3358 7.58579 11 8 11Z" />
          <path d="M8 4C9.262 4 10.25 4.988 10.25 6.25C10.25 7.333 9.68352 7.89852 9.22852 8.35352C8.82052 8.76052 8.5 9.082 8.5 9.75C8.5 10.026 8.276 10.25 8 10.25C7.724 10.25 7.5 10.026 7.5 9.75C7.5 8.667 8.06648 8.10148 8.52148 7.64648C8.92948 7.23948 9.25 6.918 9.25 6.25C9.25 5.538 8.712 5 8 5C7.288 5 6.75 5.538 6.75 6.25C6.75 6.526 6.526 6.75 6.25 6.75C5.974 6.75 5.75 6.526 5.75 6.25C5.75 4.988 6.738 4 8 4Z" />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M8 1C11.86 1 15 4.14 15 8C15 11.86 11.86 15 8 15C4.14 15 1 11.86 1 8C1 4.14 4.14 1 8 1ZM8 2C4.691 2 2 4.691 2 8C2 11.309 4.691 14 8 14C11.309 14 14 11.309 14 8C14 4.691 11.309 2 8 2Z"
          />
        </>
      );
  }
}

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
      <svg className="status-glyph" viewBox="0 0 16 16" focusable="false">
        <StatusIcon status={status} />
      </svg>
    </span>
  );
}
