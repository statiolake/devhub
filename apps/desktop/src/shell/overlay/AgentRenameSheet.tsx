/**
 * "Rename Agent": one line of typing, so one picker.
 *
 * It was an alert with a text field in it, which is the shape a rename has had
 * since long before there was a rule about it — and that made it a second kind
 * of sheet with its own keyboard: focus on a field rather than a list, Return
 * meaning "the default button" rather than "the row I am on", and no way for a
 * person to know which of the two they were looking at before pressing a key.
 * A line of text is a list with the pinned row that means *what I typed*; see
 * `Picker`'s docstring for why that is the whole of the rule.
 *
 * The name it already has is what the field starts with, so the caret lands
 * after it and a person who wants to append a word types one. An empty field
 * offers no row, which is the same refusal the disabled button used to be, said
 * in the vocabulary this control already has: `needsQuery` means a pinned row
 * that can only fail is not there to be taken.
 *
 * The Agent is named by its id rather than carried in the request, so the
 * sheet keeps describing the Agent as the model sees it: if it stops running
 * while the sheet is up, the sheet goes, exactly as it did when the sidebar
 * drew it.
 *
 * A refusal keeps the sheet and re-asks with what was typed still in the field,
 * the way `NewProjectSheet` does — the picker locks itself onto the row it took,
 * so re-asking is remounting it.
 */

import { useEffect, useState } from "react";
import { Picker } from "../components/shell/Picker";
import { useAppShell } from "../useAppShell";

export interface AgentRenameSheetProps {
  readonly agentId: string;
  readonly onDismiss: () => void;
}

/** The pinned row that means "rename it to what is in the field". */
const RENAME_TO_TYPED = "devhub:rename-to-typed";

export function AgentRenameSheet({
  agentId,
  onDismiss,
}: AgentRenameSheetProps) {
  const { state, dispatch } = useAppShell();
  /**
   * Every Agent there is, or nothing while this page is still being told.
   *
   * The overlay page is built when the first modal opens, so its projection is
   * in flight while the sheet mounts. "I have not been told" is not "the Agent
   * is gone" — reading them as the same thing closes the sheet on the frame it
   * opens and leaves the layer up with nothing on it.
   */
  const agents =
    state.status === "ready"
      ? state.snapshot.workspaces.flatMap((workspace) => workspace.agents)
      : undefined;
  const agent = agents?.find((candidate) => candidate.id === agentId);

  const [failure, setFailure] = useState<string>();
  /** What was typed into the attempt that failed, so it comes back with it. */
  const [typed, setTyped] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  // An Agent that is no longer running cannot be renamed, so the question
  // stops being asked rather than standing with a row that can only fail.
  useEffect(() => {
    if (!agents) return;
    if (!agent || agent.controlState !== "running") onDismiss();
  }, [agent, agents, onDismiss]);

  if (!agent) return null;

  return (
    <Picker
      // Re-asking is remounting: the picker is set up once, and stops
      // listening the moment a row is taken.
      key={attempt}
      title="Rename Agent"
      question="The name is how this agent appears in the sidebar."
      initialQuery={typed ?? agent.displayName}
      items={[]}
      pinned={[
        {
          id: RENAME_TO_TYPED,
          label: "Rename it",
          // Nothing typed is nothing to rename it to, and a row that can only
          // fail should not be the row Return takes.
          needsQuery: true,
        },
      ]}
      note={
        failure ? (
          <span className="picker-note-failure">{failure}</span>
        ) : undefined
      }
      onChoose={(choice) => {
        const trimmed = choice.query.trim();
        if (trimmed.length === 0) {
          // Whitespace passes `needsQuery`, which only knows the field is not
          // empty. A name made of spaces is not a name.
          setFailure("A name cannot be only spaces.");
          setTyped(choice.query);
          setAttempt((count) => count + 1);
          return;
        }
        void dispatch({
          type: "rename_agent",
          agentId: agent.id,
          displayName: trimmed,
        }).then((outcome) => {
          if (outcome) {
            onDismiss();
            return;
          }
          setFailure("The agent could not be renamed. Try again.");
          setTyped(choice.query);
          setAttempt((count) => count + 1);
        });
      }}
      onCancel={onDismiss}
    />
  );
}
