/**
 * Open Quickly, for workspaces.
 *
 * The control is `Picker`; this is the source behind it. The candidates come
 * from the sources in `config.toml`, streamed as each one answers, and "Other…"
 * is the native folder chooser for a folder no source knows about.
 *
 * **What arrives is kept.** A query cannot be answered locally — a source can
 * only be asked, and a narrower query may reach rows the last one never
 * returned — so typing re-runs the search. But the rows already on screen are
 * still true, and clearing them for the length of a round trip is what made the
 * list blink out on every keystroke. So the pool here only ever grows for as
 * long as the sheet stands, the sheet filters it locally in the same frame as
 * the keystroke, and a search that comes back late can only add to it.
 */

import { useCallback, useEffect, useState } from "react";
import { useAppShell } from "../../useAppShell";
import { Picker, type PickerItem } from "./Picker";
import { PathLabel } from "./PathLabel";
import { CloneProjectSheet, NewProjectSheet } from "./ProjectSheets";

export interface WorkspacePickerProps {
  readonly onDismiss: () => void;
}

/**
 * The two rows that are not workspaces.
 *
 * A path can never be one of these ids — a candidate's id is its absolute path
 * — so the answer the picker gives back says which of the three things
 * happened without anything having to be tagged.
 */
const NEW_PROJECT = "devhub:new-project";
const CLONE_PROJECT = "devhub:clone-project";

function PlusGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 3.6v8.8M3.6 8h8.8" />
    </svg>
  );
}

function CloneGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5.6 2.6h5.2a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H5.6a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1z" />
      <path d="M3 5.2v7.2a1 1 0 0 0 1 1h5.4" />
    </svg>
  );
}

const ACTIONS: readonly PickerItem[] = [
  {
    id: NEW_PROJECT,
    label: "New Project…",
    detail: "Create a folder and open it",
    glyph: <PlusGlyph />,
  },
  {
    id: CLONE_PROJECT,
    label: "Clone Project…",
    detail: "Clone a Git repository and open it",
    glyph: <CloneGlyph />,
  },
];

function FolderGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M1.8 4.2a1 1 0 0 1 1-1h3l1.4 1.6h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9.4a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function WorkspacePicker({ onDismiss }: WorkspacePickerProps) {
  // What this sheet is at the moment: the list, or one of the two things the
  // list can start. One state, because they are one modal — the picker is not
  // still standing behind a form it opened.
  const [asking, setAsking] = useState<"pick" | "new" | "clone">("pick");
  const {
    pickerCandidates,
    pickerBusy,
    startWorkspacePicker,
    cancelWorkspacePicker,
    selectWorkspacePicker,
    chooseWorkspaceFolder,
    reportFailure,
  } = useAppShell();

  // Everything any round of this sheet has found, by path. Not derived from
  // `pickerCandidates`, which is one round's answer and is emptied when the
  // next round starts.
  const [pool, setPool] = useState<readonly PickerItem[]>([]);
  useEffect(() => {
    if (pickerCandidates.length === 0) return;
    setPool((current) => {
      const known = new Set(current.map((item) => item.id));
      const added = pickerCandidates
        .filter((candidate) => !known.has(candidate.path))
        .map((candidate) => ({
          id: candidate.path,
          label: candidate.label,
          searchText: candidate.path,
          detail: <PathLabel path={candidate.path} />,
          glyph: <FolderGlyph />,
        }));
      return added.length === 0 ? current : [...current, ...added];
    });
  }, [pickerCandidates]);

  const search = useCallback(
    (query: string) => {
      void cancelWorkspacePicker().then(() => startWorkspacePicker(query));
    },
    [cancelWorkspacePicker, startWorkspacePicker],
  );

  const finish = useCallback(
    (action?: () => Promise<unknown>) => {
      void cancelWorkspacePicker()
        .then(() => action?.())
        .catch(reportFailure)
        .finally(onDismiss);
    },
    [cancelWorkspacePicker, onDismiss, reportFailure],
  );

  // Leaving the list for a form ends the search behind it: nothing is going to
  // read its results, and a source left running would answer into nowhere.
  const ask = useCallback(
    (next: "new" | "clone") => {
      void cancelWorkspacePicker().catch(reportFailure);
      setAsking(next);
    },
    [cancelWorkspacePicker, reportFailure],
  );

  if (asking === "new") return <NewProjectSheet onDismiss={onDismiss} />;
  if (asking === "clone") return <CloneProjectSheet onDismiss={onDismiss} />;

  return (
    <Picker
      title="Open Workspace"
      placeholder="Open Workspace"
      items={pool}
      pinned={ACTIONS}
      busy={pickerBusy}
      emptyNoMatch="No workspaces match."
      emptyNoItems="No workspaces found in the configured sources."
      onQueryChange={search}
      // A workspace is a workbench and nothing else, so there is nothing for
      // the split modifier to mean here: both ways of choosing open it.
      onChoose={(choice) => {
        if (choice.id === NEW_PROJECT) {
          ask("new");
          return;
        }
        if (choice.id === CLONE_PROJECT) {
          ask("clone");
          return;
        }
        finish(() => selectWorkspacePicker(choice.id));
      }}
      onCancel={() => {
        finish();
      }}
      extraAction={{
        label: "Other…",
        run: () => {
          finish(async () => {
            const path = await chooseWorkspaceFolder();
            if (path) await selectWorkspacePicker(path);
          });
        },
      }}
    />
  );
}
