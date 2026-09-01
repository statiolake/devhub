/**
 * Where a clone goes: the rows the question is asked with.
 *
 * Two places ask it — the picker's "Clone Project…" sheet and the Issue
 * assignment wizard — and they used to ask it two different ways: one had a
 * text field, the other had a picker with nothing in it. They are the same
 * question, so the rows are built once, here, and both draw the same list in
 * the same order with the same escape hatch at the bottom of it.
 *
 * The candidates are the parents of everything the workspace sources find, and
 * they are derived rather than configured for a reason worth stating: the
 * folders a person keeps projects in are exactly the folders their projects are
 * already in. Nobody writes that list down twice, so it cannot go stale, and
 * somebody who has configured no sources at all simply gets no rows — which is
 * what the typed row below is for.
 */

import type { PickerItem } from "./Picker";
import { joinPath } from "../../../model/projects";

/**
 * The row that means "the folder I just typed".
 *
 * Never filtered out and always last, which is `Picker`'s own rule for pinned
 * rows once something has been typed. It is the whole of the escape hatch: a
 * person cloning into a folder no source knows about types the path and takes
 * this row, which is the same thing the field it replaced did.
 */
export const CLONE_INTO_TYPED = "devhub:clone-into-typed";

/** Where a clone of `name` would land under `parent`, as a row's second line. */
function landing(parent: string, name: string | undefined): string {
  return name === undefined
    ? "Clone into this folder"
    : `Lands as ${joinPath(parent, name)}`;
}

/**
 * The parents, as rows.
 *
 * Each says where *this* clone would land rather than repeating the folder it
 * already names, so the list answers "which of these?" without the person
 * composing the path in their head. The order is the one main gave them, which
 * is the order of `workspace_sources` — the same order every other list of
 * candidates in DevHub is in.
 */
export function cloneParentItems(
  parents: readonly string[],
  repositoryName: string | undefined,
): readonly PickerItem[] {
  return parents.map((parent) => ({
    id: parent,
    label: parent,
    searchText: parent,
    detail: landing(parent, repositoryName),
  }));
}

/** The typed-path row, described in terms of what was typed. */
export function cloneTypedItem(repositoryName: string | undefined): PickerItem {
  return {
    id: CLONE_INTO_TYPED,
    // Not offered until the field has something in it: with an empty field
    // this row can only fail, and a pinned row leads the list.
    needsQuery: true,
    label: "Clone into the folder typed above",
    detail:
      repositoryName === undefined
        ? "Uses exactly what is in the field"
        : `The clone lands in it as ${repositoryName}`,
  };
}
