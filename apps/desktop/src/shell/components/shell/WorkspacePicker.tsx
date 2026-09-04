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
 *
 * **Command means "with an agent".** Return opens the workspace; Command-Return
 * — and Command-click, which is the same gesture with the other hand — asks
 * which agent profile to start in it first. It means that on every row, and
 * that is the whole reason it is decided here rather than per row: an existing
 * folder, a folder a source is offering to make, a project being created, a
 * repository being cloned. What differs between them is only *when* there is a
 * workspace to start the agent in, and none of them decides that here — the
 * profile travels with the opening as `withAgent`, and main starts the agent on
 * the far side of whatever had to happen first.
 */

import { useCallback, useEffect, useState } from "react";
import { useAppShell } from "../../useAppShell";
import { AgentProfilePicker } from "./AgentProfilePicker";
import { Picker, type PickerItem } from "./Picker";
import { PathLabel } from "./PathLabel";
import { CloneProjectSheet, NewProjectSheet } from "./ProjectSheets";

export interface WorkspacePickerProps {
  readonly onDismiss: () => void;
}

/** A candidate row, and which source in Settings it came from. */
interface PoolItem extends PickerItem {
  readonly sourceRank: number;
  /** The folder is not there yet, and choosing this row makes it. */
  readonly missing: boolean;
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

/**
 * A row taken, held until everything it needs has been asked.
 *
 * The Command gesture puts a question *between* the row and the act, so the act
 * has to survive being asked something else. It is one value with the shape of
 * the three things this sheet can lead to, so the code that runs it reads the
 * same whether an agent was asked for or not.
 */
type Chosen =
  | { readonly kind: "open"; readonly path: string; readonly create: boolean }
  | { readonly kind: "new"; readonly query: string }
  | { readonly kind: "clone"; readonly query: string };

export function WorkspacePicker({ onDismiss }: WorkspacePickerProps) {
  // What this sheet is at the moment: the list, the agent question Command
  // adds in front of the act, or one of the two things the list can start. One
  // state, because they are one modal — the picker is not still standing
  // behind a form it opened.
  const [asking, setAsking] = useState<"pick" | "agent" | "new" | "clone">(
    "pick",
  );
  /** What was typed here, for whichever sheet is asked for next. */
  const [typedQuery, setTypedQuery] = useState("");
  /** The row Command took, waiting on the agent question. */
  const [chosen, setChosen] = useState<Chosen>();
  /** The profile the answer to that question named, once there is one. */
  const [withAgent, setWithAgent] = useState<string>();
  const {
    pickerCandidates,
    pickerBusy,
    pickerSourceCount,
    startWorkspacePicker,
    cancelWorkspacePicker,
    selectWorkspacePicker,
    chooseWorkspaceFolder,
    reportFailure,
  } = useAppShell();

  /**
   * Everything any round of this sheet has found, in the order Settings put
   * its sources in.
   *
   * Not derived from `pickerCandidates`, which is one round's answer and is
   * emptied when the next round starts — the pool only ever grows for as long
   * as the sheet stands.
   *
   * The order is the source's rank and nothing else. Sources run concurrently
   * in main, so what arrives first is a race between a command that answers in
   * a millisecond and a directory walk that takes a second, and a list in
   * arrival order is a list whose top row changes between two identical runs.
   * Sorting by rank alone — and letting the sort's own stability keep each
   * source's rows in the order that source produced them — is the whole rule:
   * the list reads down `workspace_sources` from the top, exactly as it is
   * written in Settings, and `Picker` then re-ranks it by the query without
   * disturbing rows the query scores the same.
   *
   * A path two sources both name belongs to the earlier one, which is why the
   * rank is lowered rather than a second row being added.
   */
  const [pool, setPool] = useState<readonly PoolItem[]>([]);
  useEffect(() => {
    if (pickerCandidates.length === 0) return;
    setPool((current) => {
      const byPath = new Map(current.map((item) => [item.id, item]));
      let changed = false;
      for (const candidate of pickerCandidates) {
        const known = byPath.get(candidate.path);
        if (known === undefined) {
          byPath.set(candidate.path, {
            id: candidate.path,
            label: candidate.label,
            searchText: candidate.path,
            detail: candidate.missing ? (
              // The row is an offer to make it, so it says so where every
              // other row says where it is. A path that is not there yet,
              // shown as though it were, is a row that fails when chosen.
              <>
                <PathLabel path={candidate.path} /> — not created yet
              </>
            ) : (
              <PathLabel path={candidate.path} />
            ),
            glyph: <FolderGlyph />,
            sourceRank: candidate.sourceRank,
            missing: candidate.missing,
          });
          changed = true;
        } else if (candidate.sourceRank < known.sourceRank) {
          byPath.set(candidate.path, {
            ...known,
            sourceRank: candidate.sourceRank,
          });
          changed = true;
        }
      }
      return changed
        ? [...byPath.values()].sort(
            (left, right) => left.sourceRank - right.sourceRank,
          )
        : current;
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
  // What was typed travels with the question. Somebody who typed a name and
  // found no workspace by it, then took "Clone Project…", has already said
  // what they want — and the row they took is the one that said their typing
  // meant something. Handing the next sheet an empty field would ask them for
  // it twice.
  const ask = useCallback(
    (next: "new" | "clone", query: string) => {
      void cancelWorkspacePicker().catch(reportFailure);
      setTypedQuery(query);
      setAsking(next);
    },
    [cancelWorkspacePicker, reportFailure],
  );

  /**
   * Do what the row said, now that nothing else is going to be asked.
   *
   * The profile is passed on rather than acted on: an agent needs a workspace,
   * and for two of these three the workspace does not exist yet. Handing it to
   * the call that opens is what makes "open it with this agent" one act, and
   * one that cannot half-happen.
   */
  const run = useCallback(
    (row: Chosen, profileId: string | undefined) => {
      if (row.kind === "open") {
        finish(() => selectWorkspacePicker(row.path, row.create, profileId));
        return;
      }
      ask(row.kind, row.query);
    },
    [ask, finish, selectWorkspacePicker],
  );

  // The questions the Command gesture adds are questions, so they are counted:
  // the list is the first, the agent is the second, and the project sheets come
  // after whichever of those were asked.
  const projectStep = withAgent === undefined ? 2 : 3;
  if (asking === "new")
    return (
      <NewProjectSheet
        initialQuery={typedQuery}
        step={projectStep}
        withAgent={withAgent}
        onDismiss={onDismiss}
      />
    );
  if (asking === "clone")
    return (
      <CloneProjectSheet
        initialQuery={typedQuery}
        step={projectStep}
        withAgent={withAgent}
        onDismiss={onDismiss}
      />
    );
  if (asking === "agent")
    return (
      <AgentProfilePicker
        question="Which agent profile should start in the workspace being opened?"
        step={2}
        hint="The agent starts at the workspace root, once it is open."
        onChoose={(profileId) => {
          if (chosen === undefined) {
            // This question is only ever asked with a row behind it. Standing
            // here without one means the two states disagree, and going on
            // would start an agent in a workspace nobody named.
            throw new Error("the agent question was asked with no row taken");
          }
          setWithAgent(profileId);
          run(chosen, profileId);
        }}
        // One question back, which is the list — and the same list, because
        // the pool it is drawn from outlives the sheet that draws it.
        onCancel={() => {
          setChosen(undefined);
          setAsking("pick");
        }}
      />
    );

  return (
    <Picker
      title="Open Workspace"
      question="Which workspace should this window open? Type to search the folders your sources cover."
      items={pool}
      pinned={ACTIONS}
      busy={pickerBusy}
      emptyNoMatch="No workspaces match."
      // Two different things to say, and an empty list cannot tell them apart.
      // Somebody with no sources has not searched an empty machine — they have
      // not said where to look, which is the one thing DevHub cannot work out
      // for them, and the default configuration deliberately does not guess.
      emptyNoItems={
        pickerSourceCount === 0
          ? "No workspace sources yet. Add one in Settings to search your folders — or make a project with the rows below."
          : "No workspaces found in the configured sources."
      }
      onQueryChange={search}
      step={1}
      note="⌘↵ Open with an agent"
      onChoose={(choice) => {
        // What the row means, in the same terms whichever row it was — so the
        // modifier is read once, here, rather than by each of the three things
        // a row can lead to.
        const row: Chosen =
          choice.id === NEW_PROJECT
            ? { kind: "new", query: choice.query }
            : choice.id === CLONE_PROJECT
              ? { kind: "clone", query: choice.query }
              : {
                  kind: "open",
                  path: choice.id,
                  // Only a row that said it is missing may make a folder, and
                  // the row said it because the source it came from said so.
                  // Nothing here decides it, and nothing here looks at the disk
                  // to second-guess it.
                  create:
                    pool.find((item) => item.id === choice.id)?.missing ??
                    false,
                };
        if (choice.split) {
          void cancelWorkspacePicker().catch(reportFailure);
          setChosen(row);
          setAsking("agent");
          return;
        }
        run(row, undefined);
      }}
      onCancel={() => {
        finish();
      }}
      extraAction={{
        label: "Other…",
        run: () => {
          finish(async () => {
            const path = await chooseWorkspaceFolder();
            // A folder the person picked in the native chooser is one that
            // exists; there is nothing to make.
            if (path) await selectWorkspacePicker(path, false);
          });
        },
      }}
    />
  );
}
