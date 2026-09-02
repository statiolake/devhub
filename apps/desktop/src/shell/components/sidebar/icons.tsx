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
  | "worktree"
  | "issueOpen"
  | "issueClosed"
  | "pullRequest"
  | "pullRequestMerged"
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

  /* ------------------------------------------------- what a row is made of
   *
   * Three marks share the leading column, and a row is identified by which of
   * them starts it: a plain folder, a repository, and a worktree of one. They
   * have to be told apart at thirteen pixels, in one glance, in a column where
   * they sit directly above one another — so they are three different
   * silhouettes rather than one silhouette with a detail added to it.
   *
   * The repository used to be an open book, which is the word git itself uses
   * and the mark GitHub draws. It is gone at the person's request, and the
   * replacement had to satisfy the harder half of the old brief anyway: a book
   * at this size is a rectangle with a seam down it, and a folder is a
   * rectangle, so the two were carrying the whole distinction on one interior
   * stroke.
   */

  /* A repository: a box, seen as a solid. It has the mass a folder has — this
     is the same column, and a mark that reads as lighter than its neighbours
     reads as less important than them — and it is the one closed convex
     silhouette in the set, so the difference from a folder is the outline
     itself rather than anything drawn inside it. The three interior edges meet
     at the centre at 120°, which is what makes it read as a solid instantly
     and not as a hexagon.

     The alternative, kept here because it was close: a commit graph — a trunk
     with two nodes and a branch leaving it. It says "repository" at least as
     well, and it was dropped because at thirteen pixels it is mostly the same
     strokes as `pullRequest` two lines further down the same row. */
  repository: (
    <>
      <path d="M8 2.6 13.4 5.5v5L8 13.4 2.6 10.5v-5Z" />
      <path d="M8 13.4V8M8 8 2.6 5.5M8 8l5.4-2.5" />
    </>
  ),

  /* A worktree: the repository, checked out a second time. So it is two of the
     same shape, one behind the other — the mark everything else uses for a
     copy, which is exactly what a worktree is.

     The one behind is drawn as three sides rather than a whole square, so the
     two outlines never cross. A crossing is four line-ends meeting inside two
     pixels, and at this size that is a blot. */
  worktree: (
    <>
      <path d="M10 6V3.8c0-.66-.54-1.2-1.2-1.2H3.8c-.66 0-1.2.54-1.2 1.2v5c0 .66.54 1.2 1.2 1.2H6" />
      <path d="M7.2 6h5c.66 0 1.2.54 1.2 1.2v5c0 .66-.54 1.2-1.2 1.2h-5A1.2 1.2 0 0 1 6 12.2v-5C6 6.54 6.54 6 7.2 6Z" />
    </>
  ),

  /* A Workspace that is only a folder. The silhouette is the one the Sidebar
     already had — it was never the problem — moved onto the shared box and
     stripped of the accent tint that made it the one solid block in a column
     of lines. */
  folder: (
    <path d="M1.71 4a1.14 1.14 0 0 1 1.15-1.14h3.43l1.6 1.83h5.26a1.14 1.14 0 0 1 1.14 1.14v6.17a1.14 1.14 0 0 1-1.14 1.14H2.86a1.14 1.14 0 0 1-1.15-1.14z" />
  ),

  /* Scratch: a shell prompt. Redrawn to the shared live area, because at 14
     units it was the narrowest mark in the column and its row visibly started
     further in than the rows under it. */
  terminal: <path d="M2.5 4.5 6.5 8l-4 3.5M8.75 11.5h4.75" />,

  plus: <path d="M8 3.25v9.5M3.25 8h9.5" />,

  close: <path d="M4.75 4.75l6.5 6.5M11.25 4.75l-6.5 6.5" />,

  /* GitHub's two Issue states, and the pull request out from the branch.
   *
   * A ring with something inside it, and what is inside says which: nothing
   * added for open, a check for closed. The ring is the recognition and the
   * interior is one stroke, which is all this size holds — the Octicon these
   * replace put a 3-unit dot inside a 13-pixel ring and it closed to a blob.
   *
   * The pull request is a branch and a trunk, and there are two drawings for
   * the four states — because there is exactly one question the shape answers:
   * **did this land?**
   *
   * `open`, `draft` and `closed` are all "no", and they get the arrow: the
   * branch proposed at the trunk, not touching it. `merged` is "yes", and the
   * branch reaches the trunk and joins it at a node. What separates the three
   * that did not land is colour and label — green, grey, red — the same way
   * `open` and `draft` have always been separated, because a second silhouette
   * differing from the first by one node is a difference nobody can see at
   * thirteen pixels. Landing is not that kind of difference: it is the one
   * fact a person scans this column for. */
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

  /* Merged: the same trunk and the same branch, with the arrow replaced by the
     junction it was pointing at. The branch runs all the way in and a filled
     node sits where it meets — a dot, and not an outline, for the reason the
     other two dots in this file are dots: at this size a ring that small
     closes to a smudge. */
  pullRequestMerged: (
    <>
      <path d="M4.25 2.75v10.5M11.75 13.25V7.6a2.35 2.35 0 0 0-2.35-2.35H5.6" />
      <circle className="glyph-fill" cx="4.25" cy="5.25" r="1.35" />
    </>
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
 *
 * `data-glyph` names which mark it is. A glyph is `aria-hidden` — what it says
 * is said in the label of whatever holds it — so it is otherwise invisible to
 * anything reading the rendered row, and *which* mark a row starts with is
 * exactly the fact the three Workspace kinds are told apart by.
 */
export function Glyph({ name, className }: GlyphProps) {
  return (
    <svg
      className={className ? `sidebar-glyph ${className}` : "sidebar-glyph"}
      data-glyph={name}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  );
}
