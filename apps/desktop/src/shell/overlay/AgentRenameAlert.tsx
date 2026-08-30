/**
 * "Rename Agent", drawn on the modal layer.
 *
 * The Agent is named by its id rather than carried in the request, so the
 * field keeps describing the Agent as the model sees it: if it stops running
 * while the sheet is up, the sheet goes, exactly as it did when the sidebar
 * drew it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppShell } from "../useAppShell";
import { Alert } from "../components/shell/Alert";

export interface AgentRenameAlertProps {
  readonly agentId: string;
  readonly onDismiss: () => void;
}

export function AgentRenameAlert({
  agentId,
  onDismiss,
}: AgentRenameAlertProps) {
  const { state, dispatch } = useAppShell();
  const agent =
    state.status === "ready"
      ? state.snapshot.workspaces
          .flatMap((workspace) => workspace.agents)
          .find((candidate) => candidate.id === agentId)
      : undefined;

  const [value, setValue] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  // The name the Agent has is the name the field starts with, and only the
  // first time: after that the person is typing and the projection must not
  // reach in and overwrite them.
  const displayName = agent?.displayName;
  useEffect(() => {
    setValue((current) => current ?? displayName);
  }, [displayName]);

  // The field, not the default button: a rename starts by typing over what is
  // there. The alert itself owns the focus trap and the restore.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  // An Agent that is no longer running cannot be renamed, so the question
  // stops being asked rather than standing with a disabled button.
  useEffect(() => {
    if (!agent || agent.controlState !== "running") onDismiss();
  }, [agent, onDismiss]);

  const submit = useCallback(async () => {
    const trimmed = (value ?? "").trim();
    if (!agent || trimmed.length === 0 || busy) return;
    setBusy(true);
    setFailed(false);
    const outcome = await dispatch({
      type: "rename_agent",
      agentId: agent.id,
      displayName: trimmed,
    });
    setBusy(false);
    if (outcome) onDismiss();
    else setFailed(true);
  }, [agent, busy, dispatch, onDismiss, value]);

  if (!agent) return null;

  return (
    <Alert
      title="Rename Agent"
      message="The name is how this agent appears in the sidebar."
      onCancel={onDismiss}
      actions={[
        { label: "Cancel", run: onDismiss, disabled: busy },
        {
          label: busy ? "Renaming…" : "Rename",
          isDefault: true,
          disabled: busy || (value ?? "").trim().length === 0,
          run: () => {
            void submit();
          },
        },
      ]}
    >
      <input
        ref={field}
        className="mac-field mac-alert-field"
        aria-label="Display name"
        value={value ?? ""}
        maxLength={256}
        aria-invalid={failed}
        disabled={busy}
        onChange={(event) => {
          setValue(event.target.value);
        }}
      />
      {failed ? (
        <p className="mac-message" role="alert">
          The agent could not be renamed. Try again.
        </p>
      ) : null}
    </Alert>
  );
}
