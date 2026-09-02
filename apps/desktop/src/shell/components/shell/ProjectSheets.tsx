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
import { cloneTarget, type GitHubLogin } from "../../../model/projects";
import { toAppError } from "../../failure";
import { useAppShell } from "../../useAppShell";
import { Alert } from "./Alert";
import {
  CLONE_INTO_TYPED,
  cloneParentItems,
  cloneTypedItem,
} from "./cloneDestination";
import { Picker } from "./Picker";

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

/**
 * Who GitHub says this person is, for as long as a sheet needs to know.
 *
 * Asked once when the sheet opens and never guessed at. Until the answer
 * arrives the login is `pending`, which is a state the preview line can say
 * something true about — a default of "not signed in" would put a sentence
 * about `gh auth login` in front of somebody who is signed in perfectly well.
 */
function useGitHubLogin(): GitHubLogin {
  const { githubLogin } = useAppShell();
  const [login, setLogin] = useState<GitHubLogin>({ kind: "pending" });
  useEffect(() => {
    let live = true;
    void githubLogin().then((answer) => {
      if (!live) return;
      setLogin(
        answer.kind === "login"
          ? { kind: "known", login: answer.login }
          : { kind: "unknown", reason: answer.reason },
      );
    });
    // The answer can arrive after the sheet is gone — `gh` takes as long as it
    // takes — and a hook that set state then would be answering a question
    // nobody is still asking.
    return () => {
      live = false;
    };
  }, [githubLogin]);
  return login;
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

/**
 * Clone: the URL, then where it goes.
 *
 * Two questions in two steps rather than two fields in one sheet, because the
 * second one has an answer DevHub already knows — the folders this person keeps
 * projects in — and a list of those is a better question than an empty field
 * with a guess in it. It is the same step, drawn by the same picker with the
 * same rows, as the Issue assignment wizard's; see `cloneDestination.ts`.
 *
 * The typed row is what is left of the field: somebody cloning into a folder no
 * source knows about types the path and takes it.
 *
 * What goes in the first field is read the way `gh repo clone` reads it — a
 * bare name is this person's own repository, `owner/name` is GitHub's, and a
 * URL is cloned as written — and the line under the field says which of the
 * three was understood before anything is cloned.
 */
export function CloneProjectSheet({ onDismiss }: ProjectSheetProps) {
  const { cloneProject, cloneParentDirectories, reportFailure } = useAppShell();
  const login = useGitHubLogin();
  const [typed, setTyped] = useState("");
  const [asking, setAsking] = useState<"url" | "where">("url");
  const [parents, setParents] = useState<readonly string[]>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const urlField = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    urlField.current?.focus();
  }, []);

  // Asked for once, when the sheet opens, rather than when the second step is
  // reached: the person is typing a URL for those seconds, and a list that is
  // already there is a list that does not make them wait for it.
  useEffect(() => {
    let live = true;
    void cloneParentDirectories().then((found) => {
      if (live) setParents(found);
    }, reportFailure);
    return () => {
      live = false;
    };
  }, [cloneParentDirectories, reportFailure]);

  // What was typed, read the way `gh repo clone` reads it. The line under the
  // field, the rows' "Lands as", and the call that clones are all this one
  // value, so the sheet cannot promise one repository and clone another.
  const target = cloneTarget(typed, login);
  const name = target.kind === "clone" ? target.name : undefined;

  const clone = (parent: string) => {
    if (busy || target.kind !== "clone") return;
    // A blank folder is not guarded against here: main refuses it with a
    // sentence ("Enter a path for the folder."), and that sentence under the
    // still-open list is worth more than a click that silently does nothing.
    setBusy(true);
    setFailure(undefined);
    void cloneProject(target.url, parent).then(onDismiss, (error: unknown) => {
      setBusy(false);
      setFailure(reasonOf(error));
      // The reason is about the destination, so the question about the
      // destination is the one asked again — with the reason under it.
      setAsking("where");
    });
  };

  if (asking === "where") {
    return (
      <Picker
        title={`Clone ${name ?? "repository"}`}
        question={`The repository is cloned and then opened as a workspace. Choose the folder ${name ?? "it"} should be cloned into.`}
        // No starting value: the field filters the rows, so a path put there
        // first would hide the list it is meant to search. Where projects go
        // is a row — main adds it when the sources imply no folders.
        items={cloneParentItems(parents ?? [], name)}
        pinned={[cloneTypedItem(name)]}
        busy={parents === undefined || busy}
        note={failure}
        emptyNoItems="Type the folder the clone should go into."
        emptyNoMatch="No folder matches. Type one instead."
        onChoose={(choice) => {
          clone(choice.id === CLONE_INTO_TYPED ? choice.query : choice.id);
        }}
        onCancel={() => {
          // Back to the URL, not out of the sheet: the person answered one
          // question and is being asked the next, and Escape undoes the step.
          setFailure(undefined);
          setAsking("url");
        }}
      />
    );
  }

  return (
    <Alert
      tone="plain"
      title="Clone Project"
      message="A name on its own is your own repository, owner/name is on GitHub, and a URL is cloned as it is written."
      onCancel={onDismiss}
      actions={[
        { label: "Cancel", run: onDismiss, disabled: busy },
        {
          label: "Continue",
          isDefault: true,
          disabled: busy || target.kind !== "clone",
          run: () => {
            setFailure(undefined);
            setAsking("where");
          },
        },
      ]}
    >
      <input
        ref={urlField}
        className="mac-field mac-alert-field"
        aria-label="Repository"
        placeholder="owner/repo"
        value={typed}
        disabled={busy}
        aria-invalid={failure !== undefined}
        onChange={(event) => {
          setTyped(event.target.value);
          setFailure(undefined);
        }}
      />
      {/* Which repository, spelled out, by the same rule that is about to
          clone it — so the line is a preview and not a guess. A name on its
          own is the form that can be read wrong most quietly, and this is
          where it stops being quiet. Where it lands is the next question. */}
      <p className="mac-caption project-destination">
        {target.kind === "clone"
          ? `Clones ${target.url} as ${target.name}`
          : target.reason}
      </p>
      {failure ? (
        <p className="mac-message" role="alert">
          {failure}
        </p>
      ) : null}
    </Alert>
  );
}
