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
 *     glyph's line is 1.5 device pixels at either density. `.glyph-fill` is
 *     the exception, and it covers two cases: the marks that are a dot — a dot
 *     cannot be drawn as an outline at this size without closing to a smudge —
 *     and the six Octicons below.
 *   - Colour is `currentcolor`, always. What a mark means by its colour is
 *     said by the element that holds it, never here.
 *
 * The drawings are DevHub's own, with one deliberate set of borrowings. The
 * marks that say what *DevHub* is — a workspace, a worktree, a terminal, an
 * Agent's status — are drawn here, because codicons and Octicons taken
 * verbatim for those was the mistake underneath the rest: both families are
 * drawn for a 16-pixel box with interior detail sized for it, and the Sidebar
 * renders them at thirteen and fourteen, so a stroked `loading` arc arrived as
 * a hairline crescent.
 *
 * The marks that say what *GitHub* says — the Issue and pull-request states —
 * are GitHub's, verbatim and filled. They survive the size because a filled
 * silhouette does, and their whole job is recognition rather than description.
 * The block below carries the argument and the licence.
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
  | "remote"
  | "issueOpen"
  | "issueClosed"
  | "pullRequest"
  | "pullRequestDraft"
  | "pullRequestClosed"
  | "pullRequestMerged"
  | "commit"
  | "push"
  | "openIssue"
  | "openPullRequest"
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

  /* A folder on another machine. Two stacked slabs — the shape everything from
     a rack unit to a disk icon has used for forty years — rather than a folder
     with a badge on it, because this column is scanned and not read: a row on
     another machine has to be tellable from a row on this one at a glance, and
     a badge at fourteen units is a smudge. Drawn in the same live area as
     `folder` so the leading column does not move. */
  remote: (
    <path d="M2.29 3.43h11.42v3.43H2.29zM2.29 9.14h11.42v3.43H2.29zM4.57 5.14h.01M4.57 10.86h.01" />
  ),

  /* Scratch: a shell prompt. Redrawn to the shared live area, because at 14
     units it was the narrowest mark in the column and its row visibly started
     further in than the rows under it. */
  terminal: <path d="M2.5 4.5 6.5 8l-4 3.5M8.75 11.5h4.75" />,

  plus: <path d="M8 3.25v9.5M3.25 8h9.5" />,

  close: <path d="M4.75 4.75l6.5 6.5M11.25 4.75l-6.5 6.5" />,

  /* --------------------------------------------- what GitHub says, in
   * GitHub's own marks
   *
   * Six of the marks in this file are not DevHub's drawings. The Issue and
   * pull-request states are GitHub's own Octicons, at the 16-unit size they
   * are drawn for, path data verbatim from `@primer/octicons` v19 (MIT,
   * GitHub Inc. — `distribution/licenses/Octicons-MIT.txt`, the copy that
   * ships inside the bundle).
   *
   * They are the one exception to the stroked convention above, and the
   * exception is the point of them. These marks do not say anything about
   * DevHub — they say what GitHub says about this Issue and this pull request,
   * and somebody who reads GitHub all day knows these silhouettes cold. A
   * redrawn approximation of a mark whose entire job is recognition is a mark
   * that has to be learned a second time.
   *
   * So they are filled rather than stroked (`glyph-fill`, the same class the
   * dots use), and the four pull-request states are four drawings rather than
   * two-plus-colour. That second part is what lets the colour go away at rest
   * — see `.row-link-button` in `shell.css`. A column whose state is carried
   * only by colour cannot be greyed without losing the state; one whose state
   * is carried by shape can, and then the only colour left in the Sidebar at
   * rest is an Agent's status, which is the one thing worth a glance. */

  issueOpen: (
    <g className="glyph-fill">
      <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
    </g>
  ),

  issueClosed: (
    <g className="glyph-fill">
      <path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z" />
      <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z" />
    </g>
  ),

  pullRequest: (
    <g className="glyph-fill">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </g>
  ),

  pullRequestDraft: (
    <g className="glyph-fill">
      <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z" />
    </g>
  ),

  pullRequestClosed: (
    <g className="glyph-fill">
      <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
    </g>
  ),

  pullRequestMerged: (
    <g className="glyph-fill">
      <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z" />
    </g>
  ),

  /* The three shortcuts a workspace offers while work is under way. They are
     drawn on the same grid as everything else here because they appear beside
     a label rather than alone, and a mark that disagreed with the column would
     be the one thing in the window drawn to a different rule.

     Commit: a node on a line, which is what a commit is in every graph git has
     ever been drawn as. Push: the same line with the node leaving it, arrow
     first — the difference between the two is direction, which is exactly the
     difference between the two acts. There is no third: opening a pull request
     is `pullRequest`, the mark the Sidebar already uses for one. */
  commit: (
    <>
      <path d="M8 2.75v2.6M8 10.65v2.6" />
      <circle cx="8" cy="8" r="2.65" />
    </>
  ),

  /* Opening an Issue and opening a pull request, as *acts* rather than as
     states.

     They are DevHub's drawings and not the Octicons above, and the difference
     is the whole reason there are two of each. An Octicon reports what GitHub
     already says about something that exists; these two ask an Agent to make
     one, they sit in a column beside `commit` and `push`, and a filled
     16-pixel Octicon next to a 1.5-pixel stroke is the disagreement this file
     exists to prevent. Same grid, same weight, same column.

     The Issue is a ring with a dot in it and the pull request is the branch
     proposed at the trunk — the shapes DevHub drew for these before the states
     went to GitHub's own. */
  openIssue: (
    <>
      <circle cx="8" cy="8" r="5.25" />
      <circle className="glyph-fill" cx="8" cy="8" r="1.55" />
    </>
  ),

  openPullRequest: (
    <path d="M4.25 2.75v10.5M11.75 13.25V7.6a2.35 2.35 0 0 0-2.35-2.35H6.6M8.85 3 6.6 5.25 8.85 7.5" />
  ),

  push: (
    <>
      <path d="M8 13.25V5.4" />
      <path d="M4.9 8.5 8 5.4l3.1 3.1" />
      <path d="M4.4 2.75h7.2" />
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
