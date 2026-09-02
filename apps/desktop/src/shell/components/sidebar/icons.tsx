/**
 * Every mark the Sidebar draws, in one place, on one grid.
 *
 * They used to be inline in whatever component happened to need them —
 * `Sidebar.tsx` carried eight, `StatusMark.tsx` five — and each one chose its
 * own box and its own fill/stroke convention where it stood. Nothing forced
 * two of them to look alike, so they did not: a 14-unit stroked folder, a
 * 16-unit filled codicon, a 16-unit filled Octicon, three stroke weights, all
 * inside two hundred pixels of each other. A column of marks that do not agree
 * on how thick a line is does not read as a column.
 *
 * So there is one grid and one convention here, and it is the whole of what a
 * Sidebar mark may be:
 *
 *   - A 16-unit box, with the drawing inside the 12 units from 2 to 14. Every
 *     glyph therefore has the same optical size, whatever its silhouette, and
 *     the column has a straight leading edge.
 *   - Stroked, never filled: `fill: none`, `stroke: currentcolor`, round caps
 *     and joins, and one weight carried by `--sidebar-glyph-stroke` so a
 *     glyph's line is 1.5 device pixels at either density. The one exception
 *     is `.glyph-fill`, for the two marks that are a dot — a dot cannot be
 *     drawn as an outline at this size without closing to a smudge.
 *   - Colour is `currentcolor`, always. What a mark means by its colour is
 *     said by the element that holds it, never here.
 *
 * The drawings are DevHub's own. They were Octicons and codicons taken
 * verbatim, and that was the mistake underneath the rest: both families are
 * drawn for a 16-pixel box with interior detail sized for it, and the Sidebar
 * renders them at thirteen and fourteen. `git-pull-request` lost three nodes
 * and a merge arrow to grey mush; `issue-opened`'s centre dot closed up. What
 * is here instead says the same things with the detail this size can hold.
 *
 * To change how the Sidebar looks, change this file. Nothing else draws.
 */

import type { ReactNode } from "react";

export type GlyphName =
  | "folder"
  | "terminal"
  | "plus"
  | "close"
  | "trash"
  | "repository"
  | "issueOpen"
  | "issueClosed"
  | "pullRequest"
  | "statusWorking"
  | "statusWaiting"
  | "statusIdle"
  | "statusError"
  | "statusUnknown";

const GLYPHS: Record<GlyphName, ReactNode> = {
  /* Removing a worktree. A bin rather than an X, because the two things a row
     can do to itself are not alike: closing puts a workspace away, and this
     deletes a folder. A shape that says which is the difference between a
     mis-click you shrug at and one you cannot undo. */
  trash: (
    <path d="M2.86 4.57h10.28M6.29 4.57V3.43c0-.32.25-.57.57-.57h2.28c.32 0 .58.25.58.57v1.14M4 4.57l.57 7.72c.02.3.27.53.57.53h5.72c.3 0 .55-.23.57-.53l.57-7.72" />
  ),

  /* The repository on GitHub: a book, which is what a repository is called
     everywhere else in git's own vocabulary. Drawn open rather than closed so
     it does not read as a second folder in a column that already has one. */
  repository: (
    <path d="M3.14 2.29h3.15c.63 0 1.14.51 1.14 1.14v9.14a1.14 1.14 0 0 0-1.14-1.14H3.14a.57.57 0 0 1-.57-.57V2.86c0-.32.25-.57.57-.57ZM12.86 2.29H9.71c-.63 0-1.14.51-1.14 1.14v9.14c0-.63.51-1.14 1.14-1.14h3.15c.31 0 .57-.26.57-.57V2.86a.57.57 0 0 0-.57-.57Z" />
  ),

  /* A Workspace. The silhouette is the one the Sidebar already had — it was
     never the problem — moved onto the shared box and stripped of the accent
     tint that made it the one solid block in a column of lines. */
  folder: (
    <path d="M1.71 4a1.14 1.14 0 0 1 1.15-1.14h3.43l1.6 1.83h5.26a1.14 1.14 0 0 1 1.14 1.14v6.17a1.14 1.14 0 0 1-1.14 1.14H2.86a1.14 1.14 0 0 1-1.15-1.14z" />
  ),

  /* Scratch: a shell prompt. Redrawn to the shared live area, because at 14
     units it was the narrowest mark in the column and its row visibly started
     further in than the rows under it. */
  terminal: <path d="M2.5 4.5 6.5 8l-4 3.5M8.75 11.5h4.75" />,

  plus: <path d="M8 3.25v9.5M3.25 8h9.5" />,

  close: <path d="M4.75 4.75l6.5 6.5M11.25 4.75l-6.5 6.5" />,

  /* GitHub's two Issue states and the pull request that closes one.
   *
   * A ring with something inside it, and what is inside says which: nothing
   * added for open, a check for closed. The ring is the recognition and the
   * interior is one stroke, which is all this size holds — the Octicon these
   * replace put a 3-unit dot inside a 13-pixel ring and it closed to a blob.
   *
   * The pull request is a branch rejoining a trunk with an arrow on it. There
   * is one drawing for it and not two: `open` and `draft` are the only states
   * that reach the Sidebar, they differ by colour and by their label, and a
   * second silhouette that differs from the first by one node is a difference
   * nobody can see at this size and nobody needs to. */
  issueOpen: (
    <>
      <circle cx="8" cy="8" r="5.25" />
      <circle className="glyph-fill" cx="8" cy="8" r="1.55" />
    </>
  ),

  issueClosed: (
    <>
      <circle cx="8" cy="8" r="5.25" />
      <path d="M5.6 8.15 7.3 9.85 10.5 6.4" />
    </>
  ),

  pullRequest: (
    <path d="M4.25 2.75v10.5M11.75 13.25V7.6a2.35 2.35 0 0 0-2.35-2.35H6.6M8.85 3 6.6 5.25 8.85 7.5" />
  ),

  /* ------------------------------------------------------------- statuses */

  /* Working: three quarters of a ring, turned by the stylesheet. A spinner
     needs mass to read as one — the codicon arc this replaces was a sixty-
     degree hairline, which at 14 pixels in the Sidebar's orange was about a
     dozen painted pixels, and it was the mark on the busiest status in the
     app. */
  statusWorking: <path d="M8 2.75A5.25 5.25 0 1 1 2.75 8" />,

  /* Waiting: the Agent has stopped to ask you something, so it is a speech
     bubble.

     It was a filled blue disc, and the unread mark in the same row's rail is
     also a filled blue disc — the same drawing at two sizes, sixteen pixels
     apart, meaning two different things. One of them had to stop being a dot,
     and it is this one: the rail's dot is the older convention and the one
     Mail shares, and "it is talking to you" has a silhouette of its own that
     no other status could be confused with. */
  statusWaiting: (
    <path d="M4 3.5h8a1.75 1.75 0 0 1 1.75 1.75v3.5A1.75 1.75 0 0 1 12 10.5H7.2L4 13v-2.5A1.75 1.75 0 0 1 2.25 8.75v-3.5A1.75 1.75 0 0 1 4 3.5Z" />
  ),

  statusIdle: <path d="M3.4 8.35 6.35 11.3 12.6 4.85" />,

  /* Error: the one silhouette in the set that is not round or square, so a
     status that came back wrong is never one more ring in a column of rings. */
  statusError: (
    <>
      <path d="M8 2.9 14.1 13.1H1.9Z" />
      <path d="M8 6.6v2.7" />
      <circle className="glyph-fill" cx="8" cy="11.3" r="0.8" />
    </>
  ),

  /* Unknown: an empty ring with a dash through the middle — the mark for "no
     reading", not a fifth verdict. It was a question mark inside a ring, which
     is three strokes of interior detail at fourteen pixels in the dimmest ink
     on the row, and it arrived as a grey smudge. */
  statusUnknown: (
    <>
      <circle cx="8" cy="8" r="5.25" />
      <path d="M5.6 8h4.8" />
    </>
  ),
};

export interface GlyphProps {
  readonly name: GlyphName;
  /** Extra classes for the `svg` itself — how a caller animates or sizes it. */
  readonly className?: string;
}

/**
 * One Sidebar mark. The `svg` carries `sidebar-glyph`, which is where the
 * shared box, weight and colour rules live; everything a caller wants on top
 * of that goes in `className`.
 */
export function Glyph({ name, className }: GlyphProps) {
  return (
    <svg
      className={className ? `sidebar-glyph ${className}` : "sidebar-glyph"}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  );
}
