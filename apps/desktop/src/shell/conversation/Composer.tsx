/**
 * Where the person talks to a GUI Agent.
 *
 * Return is a new line and ⌘Return sends, as in every field of a GUI Agent
 * where something is written to send (`messageKeys.ts`, which also keeps a
 * key an input method is still composing away from all of them). Esc and
 * Ctrl+C stop a running turn; they are handled by the surface, so they work
 * from anywhere in the pane, and the composer only keeps Esc for itself while
 * it has a completion list open.
 *
 * A line that starts with `/` offers the Agent's own commands. While the list
 * is open Return (or Tab) takes the highlighted one, as it does in any list;
 * ⌘Return still sends what is typed. One the Agent takes as a message is
 * completed into the text; one DevHub handles itself opens the toolbar's
 * picker for the setting it changes.
 *
 * The box holds the field and, under it, a toolbar: the session's settings on
 * the left, Stop (while a turn runs) and Send on the right. Under the box, what
 * the Agent has working in the background (`BackgroundTasks.tsx`) and how
 * full the context is (`ContextUsage.tsx`).
 *
 * On an empty composer ↑ and ↓ walk what the person has already said to this
 * Agent, which is read off its transcript — so the history is per Agent and
 * is never stored anywhere but the conversation itself.
 *
 * What was typed is not cleared until main has it. A send that fails is
 * handed to the page's root, and the text stays where it was, to be sent
 * again.
 *
 * A message sent while the Agent is busy — a turn running, still connecting,
 * the conversation being taken back — is held by DevHub and listed over the
 * box, oldest first (`Transcript.pending`). Each can be changed or removed
 * there, or sent now, which a running turn takes in as it goes; the rest are
 * sent one per turn, as each turn ends. One open to be changed is held by
 * main, unsent, from Edit until Save or Cancel, and let go if the composer
 * goes away with it open; the caret starts at the end of its words.
 *
 * Rewinding to before a message puts its words back here, ahead of whatever
 * was being typed, and its images back among the attached.
 *
 * What is typed and not sent is the Agent's draft, which main keeps across a
 * restart of DevHub (`main/agent/conversation/drafts.ts`): the words in the
 * field, with the words of any waiting message being changed ahead of them.
 * It is reported a moment after typing pauses, at once when the composer
 * loses the keyboard, a send clears it, the pane goes away or the page is
 * unloaded, and it comes back here, ahead of anything already typed, when the
 * pane attaches. Only words: attached images are not kept, so they do not
 * come back.
 *
 * Images are attached by pasting them or dropping them on the box: each is a
 * thumbnail over the field with its own Remove, and goes with the next
 * message (which may be images alone). A file that is not an image a model
 * takes is refused at the page's root, naming it; nothing is dropped quietly.
 *
 * The microphone beside Send (or ⌘⇧M in the field) dictates: what is said is
 * transcribed on this Mac and put in at the caret, to be read and sent like
 * anything typed. See `dictation.ts`.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  SENDABLE_IMAGE_TYPES,
  type ConversationState,
  type EntryId,
  type ImageRef,
  type PendingId,
  type PendingMessage,
  type SlashCommand,
  type Transcript,
  type UserEntry,
} from "../../model/conversation";
import {
  completed,
  completionQuery,
  completions,
  inputHistory,
} from "./commandCompletion";
import { ComposerFooter } from "./BackgroundTasks";
import { ContextUsage } from "./ContextUsage";
import {
  useConversationActions,
  type SettingName,
} from "./ConversationContext";
import { ImageView } from "./EntryParts";
import { SkillBackdrop } from "./skillTokens";
import {
  DICTATION_KEY,
  placeDictation,
  type DictationAnchor,
  isDictationKey,
  LANGUAGE_LABELS,
  nextLanguage,
  saveLanguage,
  savedLanguage,
} from "./dictation";
import { EditIcon, MicIcon, SendIcon, StopIcon } from "./icons";
import { ActivityLine } from "./ActivityLine";
import { useDictation, type Dictation } from "./useDictation";
import type { VoiceLanguage } from "../../ipc/voice";
import { SEND_KEY, useMessageKeys } from "./messageKeys";
import { SettingPickers, type SettingPickerHandle } from "./SettingPickers";

/**
 * Why the composer takes no input right now, or `undefined` when it does:
 * only a conversation that takes no more input refuses it. While the Agent
 * cannot take a message yet, what is sent is held. The sentence is shown
 * where the placeholder would be.
 */
export function inputRefusal(state: ConversationState): string | undefined {
  return state.phase === "broken"
    ? BROKEN_REFUSALS[state.failure.code]
    : undefined;
}

/** What the empty composer says: why the Agent would hold a message now, if it would. */
export function composerPlaceholder(state: ConversationState): string {
  switch (state.phase) {
    case "connecting":
      return "Connecting to the Agent… What you send now is sent once it is ready.";
    case "ready":
      return state.turn === "rewinding"
        ? "Taking the conversation back… What you send now is sent once that is done."
        : COMPOSER_PLACEHOLDER;
    case "broken":
      return BROKEN_REFUSALS[state.failure.code];
  }
}

const BROKEN_REFUSALS = {
  protocol_mismatch:
    "This conversation takes no more input: DevHub could not read what the Agent said.",
  not_signed_in:
    "This conversation takes no more input until the Agent's CLI is signed in again and restarted.",
  refused:
    "This conversation takes no more input: the Agent's CLI refused to start.",
} as const;

/** What Rewind says before it drops anything. */
export const REWIND_NOTE =
  "Rewind to before this message? It and everything after it leave the conversation, and its words come back to the composer. Files the Agent changed are not changed back.";

/** What a held message says about itself. */
export function pendingStatus(message: PendingMessage): string {
  if (message.failure !== undefined) return `Not sent: ${message.failure}`;
  return message.editing
    ? "Being changed: not sent until you save or cancel"
    : "Waiting: sent when the Agent is ready for it";
}

/**
 * The images among `files`, read into their own bytes. A file of another
 * kind refuses the whole lot, naming it, so the person knows what was not
 * attached.
 */
export async function readImages(
  files: readonly File[],
): Promise<readonly ImageRef[]> {
  const refused = files.find(
    (file) => !(SENDABLE_IMAGE_TYPES as readonly string[]).includes(file.type),
  );
  if (refused !== undefined) {
    throw new Error(
      `${refused.name || "The pasted file"} cannot be attached: the Agent takes PNG, JPEG, GIF or WebP images.`,
    );
  }
  return Promise.all(
    files.map(
      (file) =>
        new Promise<ImageRef>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const url = reader.result as string;
            resolve({
              mediaType: file.type,
              source: { kind: "data", base64: url.slice(url.indexOf(",") + 1) },
              label: file.name || "image",
            });
          };
          reader.onerror = () =>
            reject(
              reader.error ??
                new Error(`${file.name || "The image"} could not be read.`),
            );
          reader.readAsDataURL(file);
        }),
    ),
  );
}

/** Thumbnails of attached images, each with its own Remove. */
function Attachments({
  images,
  remove,
}: {
  readonly images: readonly ImageRef[];
  readonly remove: (image: ImageRef) => void;
}) {
  if (images.length === 0) return null;
  return (
    <ul className="conversation-attachments" aria-label="Attached images">
      {images.map((image, index) => (
        <li key={index} className="conversation-attachment">
          <ImageView image={image} />
          <button
            type="button"
            className="conversation-attachment-remove"
            aria-label={`Remove ${image.label}`}
            title="Remove"
            onClick={() => remove(image)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * One message DevHub holds, with what can be done to it: Send now, Edit (in
 * place: ⌘Return saves, Esc gives it up) and Remove.
 */
function PendingItem({
  message,
  canSendNow,
  reportEdit,
}: {
  readonly message: PendingMessage;
  readonly canSendNow: boolean;
  /** Its changed words while it is open to be changed, else `undefined`: part of the draft. */
  readonly reportEdit: (pending: PendingId, words: string | undefined) => void;
}) {
  const {
    startEditingPending,
    editPending,
    stopEditingPending,
    removePending,
    sendPendingNow,
    reportFailure,
  } = useConversationActions();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  useEffect(() => {
    reportEdit(message.id, draft);
  }, [reportEdit, message.id, draft]);
  useEffect(
    () => () => reportEdit(message.id, undefined),
    [reportEdit, message.id],
  );
  // Main holds the message while the editor is open; the composer going
  // away with it open lets go, so it is not held for an edit nobody finishes.
  const editing = useRef(false);
  editing.current = draft !== undefined;
  const release = useRef<() => void>(() => undefined);
  release.current = () => {
    void stopEditingPending(message.id).catch(reportFailure);
  };
  useEffect(
    () => () => {
      if (editing.current) release.current();
    },
    [],
  );
  const open = () => {
    void startEditingPending(message.id).then(
      () => setDraft(message.text),
      reportFailure,
    );
  };
  const cancel = () => {
    setDraft(undefined);
    release.current();
  };
  const save = () => {
    if (draft === undefined) return;
    if (draft.trim() === "" && message.images.length === 0) {
      void removePending(message.id).catch(reportFailure);
      return;
    }
    void editPending(message.id, draft).then(
      () => setDraft(undefined),
      reportFailure,
    );
  };
  const keys = useMessageKeys(save, (event) => {
    if (event.key === "Escape") {
      // Gives the edit up; the turn is not interrupted by the same key.
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  });
  return (
    <li
      className="conversation-pending-item"
      data-failed={message.failure !== undefined || undefined}
    >
      {message.images.length > 0 ? (
        <div className="conversation-images">
          {message.images.map((image, index) => (
            <ImageView key={index} image={image} />
          ))}
        </div>
      ) : null}
      {draft === undefined ? (
        <div className="conversation-pending-text">{message.text}</div>
      ) : (
        <textarea
          className="conversation-pending-input"
          aria-label="Waiting message"
          rows={3}
          value={draft}
          autoFocus
          onFocus={(event) => {
            const end = event.currentTarget.value.length;
            event.currentTarget.setSelectionRange(end, end);
          }}
          onChange={(event) => setDraft(event.target.value)}
          {...keys}
        />
      )}
      <div className="conversation-pending-footer">
        <span className="conversation-pending-status">
          {pendingStatus(message)}
        </span>
        {draft === undefined ? (
          <>
            <button
              type="button"
              className="conversation-pending-now"
              title="Send it now: a running turn takes it in as it goes"
              disabled={!canSendNow}
              onClick={() => {
                void sendPendingNow(message.id).catch(reportFailure);
              }}
            >
              <SendIcon />
              Send now
            </button>
            <button
              type="button"
              className="conversation-pending-edit"
              onClick={open}
            >
              <EditIcon />
              Edit
            </button>
            <button
              type="button"
              className="conversation-pending-remove"
              onClick={() => {
                void removePending(message.id).catch(reportFailure);
              }}
            >
              Remove
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="conversation-pending-save"
              title={`Save (${SEND_KEY})`}
              onClick={save}
            >
              Save
            </button>
            <button
              type="button"
              className="conversation-pending-cancel"
              onClick={cancel}
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/** How long typing pauses before the draft is reported to main. */
export const DRAFT_PAUSE_MS = 400;

/**
 * Tell main the draft (`ConversationActions.saveDraft`): `DRAFT_PAUSE_MS`
 * after it last changed, or at once when `flush` is called, the composer goes
 * away or the page is unloaded. Nothing is reported until main's own copy is
 * `known`, so an empty composer drawn before the attachment answers cannot
 * wipe the draft it is about to be given; and nothing that main already has
 * is reported again. `flushNext` makes the next change go at once.
 */
function useDraftReport(
  words: string,
  known: string | undefined,
): { readonly flush: () => void; readonly flushNext: () => void } {
  const { saveDraft, reportFailure } = useConversationActions();
  const latest = useRef(words);
  latest.current = words;
  /** What main was last told, or `undefined` before its copy is known. */
  const told = useRef<string | undefined>(undefined);
  if (told.current === undefined && known !== undefined) told.current = known;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const soon = useRef(false);
  const flush = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    soon.current = false;
    const text = latest.current;
    if (told.current === undefined || text === told.current) return;
    told.current = text;
    void saveDraft(text).catch(reportFailure);
  }, [saveDraft, reportFailure]);
  useEffect(() => {
    if (soon.current) {
      flush();
      return;
    }
    if (told.current === undefined || words === told.current) return;
    timer.current = setTimeout(flush, DRAFT_PAUSE_MS);
    return () => {
      clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [words, flush]);
  useEffect(() => {
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [flush]);
  const flushNext = useCallback(() => {
    soon.current = true;
  }, []);
  return { flush, flushNext };
}

/** The draft: the words of the waiting messages being changed, oldest first, then the field's. */
function draftWords(
  pending: readonly PendingMessage[],
  edits: ReadonlyMap<PendingId, string>,
  text: string,
): string {
  return [...pending.map((message) => edits.get(message.id)), text]
    .filter((words): words is string => words !== undefined)
    .filter((words) => words.trim() !== "")
    .join("\n\n");
}

export const COMPOSER_PLACEHOLDER = `Message the Agent — / for commands, ${SEND_KEY} to send`;

/**
 * The commands a `/` offers, drawn as DevHub's other lists are (`mac-list`,
 * the Open Quickly rows): one line a row, the highlighted one in the accent.
 *
 * A row is always one line — the name whole, the argument hint, then as much
 * of the description as fits, cut with an ellipsis — so the list is a column
 * of equal rows the arrows walk evenly. What a cut description goes on to
 * say is under the list, for the highlighted row only, as the Open Quickly
 * sheet says more about the row one is on beside its list (`aside`) rather
 * than in the row.
 */
function CompletionList({
  commands,
  selected,
  choose,
}: {
  readonly commands: readonly SlashCommand[];
  readonly selected: number;
  readonly choose: (command: SlashCommand) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, commands]);
  const current = commands[selected];
  return (
    <div className="conversation-completions mac">
      <ul
        ref={listRef}
        className="mac-list conversation-completion-list"
        role="listbox"
        aria-label={commands[0]?.trigger === "$" ? "Skills" : "Commands"}
        id="conversation-completions"
      >
        {commands.map((command, index) => (
          <li
            key={`${command.trigger}${command.name}`}
            role="option"
            aria-selected={index === selected}
            aria-describedby={
              index === selected ? "conversation-completion-detail" : undefined
            }
            className="mac-list-row conversation-completion"
            // Pressed before the textarea loses focus to the click.
            onMouseDown={(event) => {
              event.preventDefault();
              choose(command);
            }}
          >
            <span className="conversation-completion-name">
              {command.trigger}
              {command.name}
            </span>
            {command.argumentHint ? (
              <span className="conversation-completion-hint mac-caption">
                {command.argumentHint}
              </span>
            ) : null}
            <span className="conversation-completion-description mac-caption">
              {command.description}
            </span>
          </li>
        ))}
      </ul>
      {current?.description ? (
        <p
          className="conversation-completion-detail mac-caption"
          id="conversation-completion-detail"
        >
          {current.description}
        </p>
      ) : null}
    </div>
  );
}

export function Composer({
  transcript,
  inputRef,
  pickers,
  openSetting,
  restored,
  savedDraft,
  openTask,
}: {
  readonly transcript: Transcript;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly pickers: Readonly<
    Record<SettingName, RefObject<SettingPickerHandle | null>>
  >;
  /** Open the toolbar's picker for a setting a command changes. */
  readonly openSetting: (setting: SettingName) => void;
  /** The message a rewind took out of the conversation, whose words come back here. */
  readonly restored: UserEntry | undefined;
  /** The draft main kept for this Agent, once it has said (`ConversationSurface`). */
  readonly savedDraft: string | undefined;
  /** Open the call a background task was started by (`ComposerFooter`). */
  readonly openTask: (call: EntryId) => void;
}) {
  const {
    send,
    interrupt,
    reportFailure,
    openResume,
    openMcp,
    restart,
    voice,
  } = useConversationActions();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<readonly ImageRef[]>([]);
  /** Which of the history the composer is showing, while it is showing one. */
  const [recalled, setRecalled] = useState<number | undefined>(undefined);
  const [selected, setSelected] = useState(0);
  /** The text whose completion list Esc closed; typing again reopens it. */
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  /** The words of each waiting message open to be changed. */
  const [edits, setEdits] = useState<ReadonlyMap<PendingId, string>>(
    () => new Map(),
  );
  const reportEdit = useCallback(
    (pending: PendingId, words: string | undefined) =>
      setEdits((current) => {
        if (current.get(pending) === words) return current;
        const next = new Map(current);
        if (words === undefined) next.delete(pending);
        else next.set(pending, words);
        return next;
      }),
    [],
  );
  const draft = useDraftReport(
    draftWords(transcript.pending, edits, text),
    savedDraft,
  );

  const refusal = inputRefusal(transcript.state);
  const [language, setLanguage] = useState<VoiceLanguage>(() =>
    savedLanguage(storage()),
  );
  const dictationAnchor = useRef<DictationAnchor | undefined>(undefined);
  const dictation = useDictation({
    voice,
    language,
    reportFailure,
    // The words go where the caret was when the recording started, phrase
    // after phrase, moved along by whatever is typed meanwhile.
    onBegin: () => {
      const input = inputRef.current;
      const current = input?.value ?? text;
      dictationAnchor.current = {
        start: input?.selectionStart ?? current.length,
        end: input?.selectionEnd ?? current.length,
        text: current,
      };
    },
    onWords: (words) => {
      const input = inputRef.current;
      setText((current) => {
        const anchor = dictationAnchor.current ?? {
          start: current.length,
          end: current.length,
          text: current,
        };
        // The caret follows the words only if it was where they go: someone
        // typing elsewhere keeps their caret.
        const following =
          input === null ||
          document.activeElement !== input ||
          (input.selectionStart === input.selectionEnd &&
            input.selectionEnd === anchor.end &&
            current === anchor.text);
        const next = placeDictation(current, anchor, words);
        dictationAnchor.current = next.anchor;
        if (following)
          requestAnimationFrame(() => {
            input?.focus();
            input?.setSelectionRange(next.caret, next.caret);
          });
        return next.text;
      });
      setRecalled(undefined);
    },
  });
  const running =
    transcript.state.phase === "ready" && transcript.state.turn === "running";
  // The CLI can take a message now (a running turn takes it in), and a
  // setting: it is up, and not being started again.
  const canSendNow =
    transcript.state.phase === "ready" && transcript.state.turn !== "rewinding";
  const history = useMemo(() => inputHistory(transcript), [transcript]);
  const [place, setPlace] = useState({ text, caret: text.length });
  const [composing, setComposing] = useState(false);
  // The caret as the field last reported it, for this very text; text set from
  // outside (history, a restored draft) has its caret at the end.
  const caret =
    place.text === text ? Math.min(place.caret, text.length) : text.length;
  const query = completionQuery(text, caret);
  const offered =
    query === undefined || dismissed === text || composing
      ? []
      : completions(transcript.session.commands, query);
  const highlighted = Math.min(selected, offered.length - 1);

  const edit = (next: string) => {
    setText(next);
    setRecalled(undefined);
    setSelected(0);
  };

  // Words that come back — a rewound message's, or the draft main kept —
  // come back ahead of what was being typed, with the caret at their end.
  const bringBack = (words: string, images: readonly ImageRef[]) => {
    setText((current) => (current === "" ? words : `${words}\n\n${current}`));
    setAttachments((current) => [...images, ...current]);
    setRecalled(undefined);
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.setSelectionRange(words.length, words.length);
    }
  };
  const restoredId = restored?.id;
  useLayoutEffect(() => {
    if (restored === undefined) return;
    bringBack(
      restored.text,
      restored.images.filter((image) => image.source.kind === "data"),
    );
    // Only a new rewind fills the composer, not a new render of the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoredId]);
  // The kept draft, once, when main says what it is.
  useLayoutEffect(() => {
    if (savedDraft === undefined || savedDraft === "") return;
    bringBack(savedDraft, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedDraft]);

  const submit = () => {
    const line = text;
    // A command DevHub answers itself, typed out whole, is that command
    // chosen, not words for the Agent (`/resume`, `/model`).
    const answered = transcript.session.commands.find(
      (command) =>
        command.route !== "message" &&
        line.trim() === `${command.trigger}${command.name}`,
    );
    if (answered !== undefined) {
      choose(answered);
      return;
    }
    const images = attachments;
    if ((line.trim() === "" && images.length === 0) || refusal !== undefined)
      return;
    void send(line, images).then(() => {
      // Only what was sent is cleared: anything typed or attached since stays.
      // Main is told at once, so a restart right after cannot bring it back.
      draft.flushNext();
      setText((current) => (current === line ? "" : current));
      setAttachments((current) =>
        current.filter((image) => !images.includes(image)),
      );
      setRecalled(undefined);
    }, reportFailure);
  };

  const attach = (files: readonly File[]) => {
    if (files.length === 0 || refusal !== undefined) return;
    void readImages(files).then(
      (images) => setAttachments((current) => [...current, ...images]),
      reportFailure,
    );
  };

  const choose = (command: SlashCommand) => {
    if (command.route === "message") {
      // Only an offered completion is chosen, and one is offered only while a
      // name is being typed.
      if (query === undefined)
        throw new Error(`${command.name} was chosen with no name being typed`);
      const next = completed(text, query, command);
      edit(next.text);
      setPlace({ text: next.text, caret: next.caret });
      const input = inputRef.current;
      if (input)
        requestAnimationFrame(() => {
          input.focus();
          input.setSelectionRange(next.caret, next.caret);
        });
      return;
    }
    edit("");
    if (command.route === "resume") openResume();
    else if (command.route === "mcp") openMcp();
    else if (command.route === "restart") void restart().catch(reportFailure);
    else openSetting(command.route);
  };

  const recall = (step: 1 | -1): boolean => {
    const browsing =
      text === "" || (recalled !== undefined && text === history[recalled]);
    if (!browsing) return false;
    const next = (recalled ?? -1) + step;
    if (next < 0) {
      setText("");
      setRecalled(undefined);
      return recalled !== undefined;
    }
    if (next >= history.length) return false;
    setText(history[next]!);
    setRecalled(next);
    return true;
  };

  const ownKeys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const plain =
      !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
    if (voice !== undefined && isDictationKey(event)) {
      event.preventDefault();
      dictation.toggle();
      return;
    }
    if (event.key === "Escape" && dictation.cancel()) {
      // The recording is thrown away; the turn is not interrupted by the same key.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (offered.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSelected((highlighted + step + offered.length) % offered.length);
        return;
      }
      if ((event.key === "Tab" || event.key === "Enter") && plain) {
        event.preventDefault();
        choose(offered[highlighted]!);
        return;
      }
      if (event.key === "Escape") {
        // The list closes; the turn is not interrupted by the same key.
        event.preventDefault();
        event.stopPropagation();
        setDismissed(text);
        return;
      }
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && plain) {
      if (recall(event.key === "ArrowUp" ? 1 : -1)) event.preventDefault();
    }
  };
  const keys = useMessageKeys(submit, ownKeys);

  return (
    <div className="conversation-composer" onBlur={draft.flush}>
      {transcript.pending.length > 0 ? (
        <ol className="conversation-pending" aria-label="Waiting to be sent">
          {transcript.pending.map((message) => (
            <PendingItem
              key={message.id}
              message={message}
              canSendNow={canSendNow}
              reportEdit={reportEdit}
            />
          ))}
        </ol>
      ) : null}
      {offered.length > 0 ? (
        <CompletionList
          commands={offered}
          selected={highlighted}
          choose={choose}
        />
      ) : null}
      <div
        className="conversation-composer-box"
        data-disabled={refusal !== undefined || undefined}
        onDragOver={(event) => {
          if ([...event.dataTransfer.types].includes("Files"))
            event.preventDefault();
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          attach([...event.dataTransfer.files]);
        }}
        // A click on the box's padding or toolbar gap is a click on the field.
        onMouseDown={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <ActivityLine transcript={transcript} />
        <Attachments
          images={attachments}
          remove={(image) =>
            setAttachments((current) =>
              current.filter((each) => each !== image),
            )
          }
        />
        <div className="conversation-composer-field">
          <SkillBackdrop text={text} input={inputRef} />
          <textarea
            ref={inputRef}
            className="conversation-composer-input"
            aria-label="Message to the Agent"
            rows={1}
            value={text}
            disabled={refusal !== undefined}
            placeholder={composerPlaceholder(transcript.state)}
            aria-controls={
              offered.length > 0 ? "conversation-completions" : undefined
            }
            aria-expanded={offered.length > 0}
            onChange={(event) => {
              edit(event.target.value);
              setPlace({
                text: event.target.value,
                caret: event.target.selectionStart,
              });
            }}
            onSelect={(event) => {
              const field = event.currentTarget;
              setPlace({ text: field.value, caret: field.selectionStart });
            }}
            {...keys}
            onCompositionStart={() => {
              keys.onCompositionStart();
              setComposing(true);
            }}
            onCompositionEnd={() => {
              keys.onCompositionEnd();
              setComposing(false);
            }}
            onPaste={(event) => {
              // Files pasted (a screenshot) are attached; text pastes as text.
              const files = [...event.clipboardData.files];
              if (files.length === 0) return;
              event.preventDefault();
              attach(files);
            }}
          />
        </div>
        {dictation.tentative !== "" &&
        (dictation.phase === "recording" ||
          dictation.phase === "transcribing") ? (
          <div
            className="conversation-dictation-tentative"
            aria-live="polite"
            title="Still being recognised — goes in when you pause"
          >
            {dictation.tentative}
          </div>
        ) : null}
        <div className="conversation-composer-toolbar">
          <SettingPickers
            session={transcript.session}
            disabled={!canSendNow}
            pickers={pickers}
          />
          <div className="conversation-composer-actions">
            {voice !== undefined ? (
              <DictationControls
                dictation={dictation}
                language={language}
                disabled={refusal !== undefined}
                cycleLanguage={() => {
                  const next = nextLanguage(language);
                  setLanguage(next);
                  saveLanguage(storage(), next);
                }}
              />
            ) : null}
            {running ? (
              <button
                type="button"
                className="conversation-stop"
                aria-label="Stop"
                title="Stop the turn (Esc or Ctrl+C)"
                onClick={() => {
                  void interrupt().catch(reportFailure);
                }}
              >
                <StopIcon />
              </button>
            ) : null}
            <button
              type="button"
              className="conversation-send"
              aria-label="Send"
              title={`Send (${SEND_KEY})`}
              disabled={
                refusal !== undefined ||
                (text.trim() === "" && attachments.length === 0)
              }
              onClick={submit}
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
      <ComposerFooter
        tasks={transcript.backgroundTasks}
        openTask={openTask}
        readout={<ContextUsage usage={transcript.usage} />}
      />
    </div>
  );
}

/** `localStorage`, where the page has one it may use. */
function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

const DICTATION_TITLES = {
  idle: `Dictate (${DICTATION_KEY})`,
  starting: "Opening the microphone…",
  recording: `Stop dictating (${DICTATION_KEY}) — Esc discards what is not in yet`,
  transcribing: "Finishing the last words on this Mac…",
} as const;

/**
 * The microphone and the language it listens for. The button is the state:
 * red and pulsing with the level while it records, waiting while it
 * transcribes, and unavailable — with the reason as its title — in a build
 * with no recogniser.
 */
function DictationControls({
  dictation,
  language,
  disabled,
  cycleLanguage,
}: {
  readonly dictation: Dictation;
  readonly language: VoiceLanguage;
  readonly disabled: boolean;
  readonly cycleLanguage: () => void;
}) {
  const { phase } = dictation;
  const recording = phase === "recording";
  return (
    <>
      {phase !== "unavailable" ? (
        <button
          type="button"
          className="conversation-dictation-language"
          aria-label={`Dictation language: ${LANGUAGE_LABELS[language]}`}
          title="The language dictation listens for — click to change"
          disabled={phase !== "idle"}
          onClick={cycleLanguage}
        >
          {LANGUAGE_LABELS[language]}
        </button>
      ) : null}
      <button
        type="button"
        className="conversation-dictation"
        data-phase={phase}
        aria-label={recording ? "Stop dictating" : "Dictate"}
        aria-pressed={recording}
        title={
          phase === "unavailable" ? dictation.reason : DICTATION_TITLES[phase]
        }
        disabled={
          disabled ||
          phase === "unavailable" ||
          phase === "starting" ||
          phase === "transcribing"
        }
        style={
          recording
            ? ({
                "--dictation-level": dictation.level.toFixed(2),
              } as CSSProperties)
            : undefined
        }
        onClick={dictation.toggle}
        onPointerEnter={dictation.warm}
        onFocus={dictation.warm}
      >
        <MicIcon />
      </button>
    </>
  );
}
