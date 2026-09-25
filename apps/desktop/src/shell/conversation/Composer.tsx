/**
 * Where the person talks to a GUI Agent.
 *
 * The keys mean what they mean in both CLIs' own terminals: Enter sends,
 * Shift+Enter is a new line, and a key pressed while an input method is still
 * composing is the input method's — Enter then confirms the conversion and
 * sends nothing. Esc and Ctrl+C stop a running turn; they are handled by the
 * surface, so they work from anywhere in the pane, and the composer only
 * keeps Esc for itself while it has a completion list open.
 *
 * A line that starts with `/` offers the Agent's own commands. One the Agent
 * takes as a message is completed into the text; one DevHub handles itself
 * opens the toolbar's picker for the setting it changes.
 *
 * The box holds the field and, under it, a toolbar: the session's settings on
 * the left, Stop (while a turn runs) and Send on the right.
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
 * sent one per turn, as each turn ends.
 *
 * Rewinding to before a message puts its words back here, ahead of whatever
 * was being typed.
 */

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type {
  ConversationState,
  PendingMessage,
  SlashCommand,
  Transcript,
  UserEntry,
} from "../../model/conversation";
import { isImeComposing } from "../accessibility/ime";
import { commandQuery, completions, inputHistory } from "./commandCompletion";
import {
  useConversationActions,
  type SettingName,
} from "./ConversationContext";
import { EditIcon, SendIcon, StopIcon } from "./icons";
import { SettingPickers } from "./SettingPickers";

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
    "This conversation takes no more input: the Agent's CLI is not signed in.",
  refused:
    "This conversation takes no more input: the Agent's CLI refused to start.",
} as const;

/** What Rewind says before it drops anything. */
export const REWIND_NOTE =
  "Rewind to before this message? It and everything after it leave the conversation, and its words come back to the composer. Files the Agent changed are not changed back.";

/** What a held message says about itself. */
export function pendingStatus(message: PendingMessage): string {
  return message.failure === undefined
    ? "Waiting: sent when the Agent is ready for it"
    : `Not sent: ${message.failure}`;
}

/**
 * One message DevHub holds, with what can be done to it: Send now, Edit (in
 * place: Enter saves, Esc gives it up) and Remove.
 */
function PendingItem({
  message,
  canSendNow,
}: {
  readonly message: PendingMessage;
  readonly canSendNow: boolean;
}) {
  const { editPending, removePending, sendPendingNow, reportFailure } =
    useConversationActions();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const composing = useRef(false);
  const save = () => {
    if (draft === undefined) return;
    if (draft.trim() === "") {
      void removePending(message.id).catch(reportFailure);
      return;
    }
    void editPending(message.id, draft).then(
      () => setDraft(undefined),
      reportFailure,
    );
  };
  return (
    <li
      className="conversation-pending-item"
      data-failed={message.failure !== undefined || undefined}
    >
      {draft === undefined ? (
        <div className="conversation-pending-text">{message.text}</div>
      ) : (
        <textarea
          className="conversation-pending-input"
          aria-label="Waiting message"
          rows={1}
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (isImeComposing(event.nativeEvent, composing.current)) return;
            const plain =
              !event.shiftKey &&
              !event.altKey &&
              !event.metaKey &&
              !event.ctrlKey;
            if (event.key === "Enter" && plain) {
              event.preventDefault();
              save();
            } else if (event.key === "Escape") {
              // Gives the edit up; the turn is not interrupted by the same key.
              event.preventDefault();
              event.stopPropagation();
              setDraft(undefined);
            }
          }}
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
              onClick={() => setDraft(message.text)}
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
              onClick={save}
            >
              Save
            </button>
            <button
              type="button"
              className="conversation-pending-cancel"
              onClick={() => setDraft(undefined)}
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </li>
  );
}

export const COMPOSER_PLACEHOLDER =
  "Message the Agent — / for commands, Shift+Enter for a new line";

function CompletionList({
  commands,
  selected,
  choose,
}: {
  readonly commands: readonly SlashCommand[];
  readonly selected: number;
  readonly choose: (command: SlashCommand) => void;
}) {
  return (
    <ul
      className="conversation-completions"
      role="listbox"
      aria-label="Commands"
      id="conversation-completions"
    >
      {commands.map((command, index) => (
        <li
          key={command.name}
          role="option"
          aria-selected={index === selected}
          className="conversation-completion"
          // Pressed before the textarea loses focus to the click.
          onMouseDown={(event) => {
            event.preventDefault();
            choose(command);
          }}
        >
          <span className="conversation-completion-name">/{command.name}</span>
          {command.argumentHint ? (
            <span className="conversation-completion-hint">
              {command.argumentHint}
            </span>
          ) : null}
          <span className="conversation-completion-description">
            {command.description}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Composer({
  transcript,
  inputRef,
  pickers,
  openSetting,
  restored,
}: {
  readonly transcript: Transcript;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly pickers: Readonly<
    Record<SettingName, RefObject<HTMLSelectElement | null>>
  >;
  /** Open the toolbar's picker for a setting a command changes. */
  readonly openSetting: (setting: SettingName) => void;
  /** The message a rewind took out of the conversation, whose words come back here. */
  readonly restored: UserEntry | undefined;
}) {
  const { send, interrupt, reportFailure, openResume } =
    useConversationActions();
  const [text, setText] = useState("");
  /** Which of the history the composer is showing, while it is showing one. */
  const [recalled, setRecalled] = useState<number | undefined>(undefined);
  const [selected, setSelected] = useState(0);
  /** The text whose completion list Esc closed; typing again reopens it. */
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  const composing = useRef(false);

  const refusal = inputRefusal(transcript.state);
  const running =
    transcript.state.phase === "ready" && transcript.state.turn === "running";
  // The CLI can take a message now (a running turn takes it in), and a
  // setting: it is up, and not being started again.
  const canSendNow =
    transcript.state.phase === "ready" && transcript.state.turn !== "rewinding";
  const history = useMemo(() => inputHistory(transcript), [transcript]);
  const query = commandQuery(text);
  const offered =
    query === undefined || dismissed === text
      ? []
      : completions(transcript.session.commands, query);
  const highlighted = Math.min(selected, offered.length - 1);

  const edit = (next: string) => {
    setText(next);
    setRecalled(undefined);
    setSelected(0);
  };

  // A rewound message's words come back ahead of what was being typed, with
  // the caret at their end.
  const restoredId = restored?.id;
  useLayoutEffect(() => {
    if (restored === undefined) return;
    setText((current) =>
      current === "" ? restored.text : `${restored.text}\n\n${current}`,
    );
    setRecalled(undefined);
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.setSelectionRange(restored.text.length, restored.text.length);
    }
    // Only a new rewind fills the composer, not a new render of the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoredId]);

  const submit = () => {
    const line = text;
    // A command DevHub answers itself, typed out whole, is that command
    // chosen, not words for the Agent (`/resume`, `/model`).
    const answered = transcript.session.commands.find(
      (command) =>
        command.route !== "message" && line.trim() === `/${command.name}`,
    );
    if (answered !== undefined) {
      choose(answered);
      return;
    }
    if (line.trim() === "" || refusal !== undefined) return;
    void send(line).then(() => {
      // Only what was sent is cleared: anything typed since stays.
      setText((current) => (current === line ? "" : current));
      setRecalled(undefined);
    }, reportFailure);
  };

  const choose = (command: SlashCommand) => {
    if (command.route === "message") {
      edit(`/${command.name} `);
      return;
    }
    edit("");
    if (command.route === "resume") openResume();
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

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(event.nativeEvent, composing.current)) return;
    const plain =
      !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
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
    if (event.key === "Enter" && plain) {
      event.preventDefault();
      submit();
      return;
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && plain) {
      if (recall(event.key === "ArrowUp" ? 1 : -1)) event.preventDefault();
    }
  };

  return (
    <div className="conversation-composer">
      {transcript.pending.length > 0 ? (
        <ol className="conversation-pending" aria-label="Waiting to be sent">
          {transcript.pending.map((message) => (
            <PendingItem
              key={message.id}
              message={message}
              canSendNow={canSendNow}
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
        // A click on the box's padding or toolbar gap is a click on the field.
        onMouseDown={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
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
          onChange={(event) => edit(event.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
        />
        <div className="conversation-composer-toolbar">
          <SettingPickers
            session={transcript.session}
            disabled={!canSendNow}
            pickers={pickers}
          />
          <div className="conversation-composer-actions">
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
              title="Send (Enter)"
              disabled={refusal !== undefined || text.trim() === ""}
              onClick={submit}
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
