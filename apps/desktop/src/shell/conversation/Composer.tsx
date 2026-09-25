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
 * What was typed is not cleared until the Agent has it. A send that fails is
 * handed to the page's root, and the text stays where it was, to be sent
 * again.
 */

import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type {
  ConversationState,
  SlashCommand,
  Transcript,
} from "../../model/conversation";
import { isImeComposing } from "../accessibility/ime";
import { commandQuery, completions, inputHistory } from "./commandCompletion";
import {
  useConversationActions,
  type SettingName,
} from "./ConversationContext";
import { SendIcon, StopIcon } from "./icons";
import { SettingPickers } from "./SettingPickers";

/**
 * Why the composer takes no input right now, or `undefined` when it does.
 * The sentence is shown where the placeholder would be.
 */
export function inputRefusal(state: ConversationState): string | undefined {
  switch (state.phase) {
    case "connecting":
      return "Connecting to the Agent…";
    case "ready":
      return undefined;
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
}: {
  readonly transcript: Transcript;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly pickers: Readonly<
    Record<SettingName, RefObject<HTMLSelectElement | null>>
  >;
  /** Open the toolbar's picker for a setting a command changes. */
  readonly openSetting: (setting: SettingName) => void;
}) {
  const { send, interrupt, reportFailure } = useConversationActions();
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

  const submit = () => {
    const line = text;
    if (line.trim() === "") return;
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
    openSetting(command.route);
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
          placeholder={refusal ?? COMPOSER_PLACEHOLDER}
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
            disabled={refusal !== undefined}
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
