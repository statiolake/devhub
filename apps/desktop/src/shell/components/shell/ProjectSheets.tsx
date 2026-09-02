/**
 * The two sheets behind the picker's fixed entries: make a project, or clone
 * one.
 *
 * Each asks for the least it can — a path, or a repository and where to put it
 * — and then hands the whole act to main in one call, which makes the directory
 * and opens it. Neither sheet decides anything about opening; that is
 * `open_folder` and it already exists.
 *
 * **Both are pickers**, including the questions with nothing to pick from.
 * They were alerts with text fields in them, which made them a second kind of
 * sheet with its own keyboard rules, its own focus behaviour and its own idea
 * of what Escape means — and a person cannot know, before they press a key,
 * which sort of sheet they are looking at. A question with no candidates is
 * still a question: it gets a field, a heading that says what is being asked,
 * and a pinned row that means "the thing typed above".
 *
 * **A failure keeps the sheet.** "That folder already exists", "Repository not
 * found" — these are answered by editing the field that is still on screen, so
 * the sheet stays up with the reason under the field it belongs to. Sending
 * them to the window's failure area would put the reason somewhere the person
 * cannot act on it, and on this page (the modal layer) nothing would draw it
 * at all.
 */

import { useEffect, useState } from "react";
import {
  cloneTarget,
  joinPath,
  type GitHubLogin,
} from "../../../model/projects";
import { toAppError } from "../../failure";
import { useAppShell } from "../../useAppShell";
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
  /**
   * What was already typed when this sheet was asked for.
   *
   * A person who typed `devhub` into the workspace picker and then took
   * "Clone Project…" has already answered the first question of the sheet they
   * are being handed; opening it with an empty field asks them to type it
   * again, and the row they took was the one that said their typing meant
   * something. The Clone sheet reads it as a repository, the New Project sheet
   * as the name of a folder — each in its own terms, from the same string.
   */
  readonly initialQuery?: string;
  readonly onDismiss: () => void;
}

/** The row that means "make the thing typed above", where there is nothing to list. */
const CREATE_TYPED = "devhub:create-typed";
const CLONE_TYPED_SPEC = "devhub:clone-typed-spec";

/**
 * A failure, drawn where the picker draws things it has to say about itself.
 *
 * The same slot the wizard puts a step's failure in, so a refusal looks the
 * same wherever it came from.
 */
function Refusal({ what }: { readonly what: string }) {
  return <span className="picker-note-failure">{what}</span>;
}

/**
 * New Project: where the folder goes.
 *
 * One question, so one picker — with nothing to pick from, which is exactly
 * what the pinned row is for. It was an alert with a text field in it, and that
 * was a second kind of sheet with its own keyboard rules for no reason but
 * history: a question with no candidates is still a question, and a person
 * should not have to notice which sort of sheet they are looking at to know
 * what Return and Escape do.
 */
export function NewProjectSheet({
  initialQuery = "",
  onDismiss,
}: ProjectSheetProps) {
  const { createProject } = useAppShell();
  const defaultDirectory = useDefaultDirectory();
  const [failure, setFailure] = useState<string>();
  /** What was typed into the attempt that failed, so it comes back with it. */
  const [typed, setTyped] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  // Where projects go, with whatever was already typed as the name of this
  // one. The caret lands after it, so a person who typed the whole name has
  // nothing left to do but press Return.
  const start =
    defaultDirectory === undefined
      ? undefined
      : initialQuery.length > 0
        ? joinPath(defaultDirectory, initialQuery)
        : `${defaultDirectory}/`;

  return (
    <Picker
      // The picker's field is set up once, when it mounts, so re-asking is
      // remounting — which is also how the wizard re-asks a step that failed.
      key={`${start ?? ""}:${String(attempt)}`}
      title="New Project"
      question="The folder is created and opened as a workspace."
      initialQuery={typed ?? start ?? ""}
      items={[]}
      busy={defaultDirectory === undefined}
      pinned={[
        {
          id: CREATE_TYPED,
          label: "Create and open this folder",
          needsQuery: true,
        },
      ]}
      note={failure ? <Refusal what={failure} /> : undefined}
      onChoose={(choice) => {
        void createProject(choice.query).then(onDismiss, (error: unknown) => {
          setFailure(reasonOf(error));
          setTyped(choice.query);
          setAttempt((count) => count + 1);
        });
      }}
      onCancel={onDismiss}
    />
  );
}

/**
 * Clone: which repository, then where it goes.
 *
 * Two questions in two pickers. The second one has an answer DevHub already
 * knows — the folders this person keeps projects in — and a list of those is a
 * better question than an empty field with a guess in it. It is the same step,
 * drawn by the same picker with the same rows, as the Issue assignment
 * wizard's; see `cloneDestination.ts`.
 *
 * What goes in the first field is read the way `gh repo clone` reads it — a
 * bare name is this person's own repository, `owner/name` is GitHub's, and a
 * URL is cloned as written — and the row that clones it says which of the three
 * was understood, as it is typed, before anything is cloned.
 *
 * **The preview is why this is not on the wizard runner.** A step there hands
 * the runner one prompt and waits, so what it asks cannot change while it is
 * being answered; this row's second line changes on every keystroke. The two
 * questions are still one Escape apart, and a refusal still re-asks the
 * question that caused it — the rules the runner keeps — but they are kept
 * here, in the open, rather than by a runner that cannot express the preview.
 */
export function CloneProjectSheet({
  initialQuery = "",
  onDismiss,
}: ProjectSheetProps) {
  const { cloneProject, cloneParentDirectories, reportFailure } = useAppShell();
  const login = useGitHubLogin();
  const [asking, setAsking] = useState<"repository" | "where">("repository");
  /** The repository as it was last committed to, and as it is being typed. */
  const [typed, setTyped] = useState(initialQuery);
  const [draft, setDraft] = useState(initialQuery);
  const [parents, setParents] = useState<readonly string[]>();
  const [failure, setFailure] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  // Asked for once, when the sheet opens, rather than when the second question
  // is reached: the person is naming a repository for those seconds, and a
  // list that is already there is a list that does not make them wait for it.
  useEffect(() => {
    let live = true;
    void cloneParentDirectories().then((found) => {
      if (live) setParents(found);
    }, reportFailure);
    return () => {
      live = false;
    };
  }, [cloneParentDirectories, reportFailure]);

  // What is going to be cloned, from what is in the field right now. The row
  // and the call that clones read the same value, so the preview cannot
  // describe one repository while git fetches another.
  const previewed = cloneTarget(draft, login);
  const committed = cloneTarget(typed, login);
  const name = committed.kind === "clone" ? committed.name : undefined;

  if (asking === "repository") {
    return (
      <Picker
        key={`repository:${String(attempt)}`}
        title="Clone Project"
        question="The repository is cloned and then opened as a workspace."
        // The one thing here worth an example, because it is the form a person
        // is least likely to guess: a name on its own is their own repository.
        placeholder="owner/repo"
        initialQuery={typed}
        items={[]}
        // Live, so the second line answers "which repository did you read
        // that as?" while there is still time to disagree with it.
        onQueryChange={setDraft}
        queryDelayMs={0}
        pinned={
          previewed.kind === "clone"
            ? [
                {
                  id: CLONE_TYPED_SPEC,
                  label: "Clone it",
                  detail: `Clones ${previewed.url} as ${previewed.name}`,
                  needsQuery: true,
                },
              ]
            : []
        }
        // No row to take while it cannot be read, and the reason underneath —
        // rather than a row that exists only to refuse.
        note={
          failure ? (
            <Refusal what={failure} />
          ) : previewed.kind === "unreadable" ? (
            previewed.reason
          ) : undefined
        }
        onChoose={(choice) => {
          setTyped(choice.query);
          setFailure(undefined);
          setAsking("where");
        }}
        onCancel={onDismiss}
      />
    );
  }

  return (
    <Picker
      key={`where:${String(attempt)}`}
      title={`Clone ${name ?? "repository"}`}
      question={`Choose the folder ${name ?? "it"} is cloned into.`}
      // No starting value: the field filters the rows, so a path put there
      // first would hide the list it is meant to search. Where projects go
      // is a row — main adds it when the sources imply no folders.
      items={cloneParentItems(parents ?? [], name)}
      pinned={[cloneTypedItem(name)]}
      busy={parents === undefined}
      note={failure ? <Refusal what={failure} /> : undefined}
      emptyNoItems="Type the folder the clone should go into."
      emptyNoMatch="No folder matches. Type one instead."
      onChoose={(choice) => {
        if (committed.kind !== "clone") return;
        const parent =
          choice.id === CLONE_INTO_TYPED ? choice.query : choice.id;
        void cloneProject(committed.url, parent).then(
          onDismiss,
          (error: unknown) => {
            // The reason is about the destination, so the question about the
            // destination is the one asked again — with the reason under it,
            // and a fresh field, which is what makes the sheet answer keys
            // again after it locked itself on the row that was taken.
            setFailure(reasonOf(error));
            setAttempt((count) => count + 1);
          },
        );
      }}
      onCancel={() => {
        // Back to the repository, not out of the sheet: the person answered
        // one question and is being asked the next, and Escape undoes a step
        // wherever DevHub asks more than one.
        setFailure(undefined);
        setAsking("repository");
      }}
    />
  );
}
