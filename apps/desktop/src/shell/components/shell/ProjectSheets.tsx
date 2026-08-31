/**
 * The two sheets behind the picker's fixed entries: make a project, or clone
 * one.
 *
 * Each asks for the least it can — a path, or a URL and where to put it — and
 * then hands the whole act to main in one call, which makes the directory and
 * opens it. Neither sheet decides anything about opening; that is `open_folder`
 * and it already exists.
 *
 * **A failure keeps the sheet.** "That folder already exists", "Repository not
 * found" — these are answered by editing the field that is still on screen, so
 * the sheet stays up with the reason under the field it belongs to. Sending
 * them to the window's failure area would put the reason somewhere the person
 * cannot act on it, and on this page (the modal layer) nothing would draw it
 * at all.
 */

import { useEffect, useRef, useState } from "react";
import { cloneDirectoryName, joinPath } from "../../../model/projects";
import { toAppError } from "../../failure";
import { useAppShell } from "../../useAppShell";
import { Alert } from "./Alert";

/** What went wrong, in the words whoever refused it used. */
function reasonOf(error: unknown): string {
  return toAppError(error).summary;
}

/**
 * The starting value for a path field: where projects live, with a trailing
 * separator so the person types a name and nothing else.
 */
function useDefaultDirectory(): string | undefined {
  const { projectDefaultDirectory, reportFailure } = useAppShell();
  const [directory, setDirectory] = useState<string>();
  useEffect(() => {
    let live = true;
    void projectDefaultDirectory().then((value) => {
      if (live) setDirectory(value);
    }, reportFailure);
    return () => {
      live = false;
    };
  }, [projectDefaultDirectory, reportFailure]);
  return directory;
}

/** A field whose caret starts at the end, so a prefilled path can be typed on. */
function useCaretAtEnd(value: string | undefined) {
  const field = useRef<HTMLInputElement | null>(null);
  const placed = useRef(false);
  useEffect(() => {
    if (placed.current || value === undefined) return;
    placed.current = true;
    const element = field.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(value.length, value.length);
  }, [value]);
  return field;
}

export interface ProjectSheetProps {
  readonly onDismiss: () => void;
}

export function NewProjectSheet({ onDismiss }: ProjectSheetProps) {
  const { createProject } = useAppShell();
  const defaultDirectory = useDefaultDirectory();
  const [typed, setTyped] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const prefill =
    defaultDirectory === undefined ? undefined : `${defaultDirectory}/`;
  const path = typed ?? prefill ?? "";
  const field = useCaretAtEnd(prefill);

  const create = () => {
    if (busy || path.trim().length === 0) return;
    setBusy(true);
    setFailure(undefined);
    void createProject(path).then(onDismiss, (error: unknown) => {
      setBusy(false);
      setFailure(reasonOf(error));
    });
  };

  return (
    <Alert
      tone="plain"
      title="New Project"
      message="The folder is created and opened as a workspace."
      onCancel={onDismiss}
      actions={[
        { label: "Cancel", run: onDismiss, disabled: busy },
        {
          label: busy ? "Creating…" : "Create",
          isDefault: true,
          disabled: busy || path.trim().length === 0,
          run: create,
        },
      ]}
    >
      <input
        ref={field}
        className="mac-field mac-alert-field"
        aria-label="Folder"
        value={path}
        disabled={busy || defaultDirectory === undefined}
        aria-invalid={failure !== undefined}
        onChange={(event) => {
          setTyped(event.target.value);
          setFailure(undefined);
        }}
      />
      {failure ? (
        <p className="mac-message" role="alert">
          {failure}
        </p>
      ) : null}
    </Alert>
  );
}

export function CloneProjectSheet({ onDismiss }: ProjectSheetProps) {
  const { cloneProject } = useAppShell();
  const defaultDirectory = useDefaultDirectory();
  const [url, setUrl] = useState("");
  const [typedParent, setTypedParent] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const urlField = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    urlField.current?.focus();
  }, []);

  const parent = typedParent ?? defaultDirectory ?? "";
  const name = cloneDirectoryName(url);
  const ready = name !== undefined && parent.trim().length > 0;

  const clone = () => {
    if (busy || !ready) return;
    setBusy(true);
    setFailure(undefined);
    void cloneProject(url, parent).then(onDismiss, (error: unknown) => {
      setBusy(false);
      setFailure(reasonOf(error));
    });
  };

  return (
    <Alert
      tone="plain"
      title="Clone Project"
      message="The repository is cloned and opened as a workspace."
      onCancel={onDismiss}
      actions={[
        { label: "Cancel", run: onDismiss, disabled: busy },
        {
          label: busy ? "Cloning…" : "Clone",
          isDefault: true,
          disabled: busy || !ready,
          run: clone,
        },
      ]}
    >
      <input
        ref={urlField}
        className="mac-field mac-alert-field"
        aria-label="Repository URL"
        placeholder="https://github.com/owner/repo.git"
        value={url}
        disabled={busy}
        aria-invalid={failure !== undefined}
        onChange={(event) => {
          setUrl(event.target.value);
          setFailure(undefined);
        }}
      />
      <input
        className="mac-field mac-alert-field"
        aria-label="Parent folder"
        value={parent}
        disabled={busy || defaultDirectory === undefined}
        onChange={(event) => {
          setTypedParent(event.target.value);
          setFailure(undefined);
        }}
      />
      {/* Where it is going to land, computed by the rule main clones with, so
          the line is a preview and not a guess. */}
      <p className="mac-caption project-destination">
        {name ? joinPath(parent, name) : "Enter a repository URL."}
      </p>
      {failure ? (
        <p className="mac-message" role="alert">
          {failure}
        </p>
      ) : null}
    </Alert>
  );
}
