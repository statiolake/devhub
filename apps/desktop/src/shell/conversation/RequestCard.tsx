/**
 * A question the Agent is waiting on, drawn as a card.
 *
 * The card lays out what the request carries and nothing else. Which answers
 * exist, what they are called and whether one takes a sentence are all in
 * `choices`, decided by the adapter; the page does not know which CLI asked,
 * and there is no branch here that could care.
 *
 * An answer that fails to reach the Agent is handed to the page's root, and
 * the card stays: the request is still open, so it is still the thing to
 * answer.
 *
 * From the keyboard, as in the CLIs' own dialogs: with the card focused, 1–9
 * press its choices in order, and Esc goes back to the composer. What is typed
 * into it is written under the composer's keys (`messageKeys.ts`): Return is a
 * new line and ⌘Return answers.
 */

import { useState } from "react";
import type {
  PendingRequest,
  Question,
  QuestionOption,
  RequestAnswer,
  RequestChoice,
} from "../../model/conversation";
import {
  useConversationActions,
  useFocusComposer,
} from "./ConversationContext";
import { DiffView, JsonView } from "./EntryParts";
import { Markdown } from "./Markdown";
import { SEND_KEY, useMessageKeys, type MessageKeys } from "./messageKeys";

function Subject({ request }: { readonly request: PendingRequest }) {
  const { subject } = request;
  switch (subject.kind) {
    case "tool":
      return (
        <>
          <div className="conversation-request-title">{subject.title}</div>
          <JsonView value={subject.input} />
          {subject.reason ? (
            <p className="conversation-request-reason">{subject.reason}</p>
          ) : null}
        </>
      );
    case "command":
      return (
        <>
          <pre className="conversation-request-command">
            <code>{subject.command}</code>
          </pre>
          <div className="conversation-request-cwd">in {subject.cwd}</div>
          {subject.reason ? (
            <p className="conversation-request-reason">{subject.reason}</p>
          ) : null}
        </>
      );
    case "file-change":
      return <DiffView files={subject.files} />;
    case "question":
      // The questions are the form below; the card has no other subject.
      return null;
    case "elicitation":
      return (
        <>
          <div className="conversation-request-title">{subject.server}</div>
          <p className="conversation-request-reason">{subject.message}</p>
          <JsonView value={subject.schema} />
        </>
      );
  }
}

function Choices({
  choices,
  busy,
  send,
}: {
  readonly choices: readonly RequestChoice[];
  readonly busy: boolean;
  readonly send: (answer: RequestAnswer) => void;
}) {
  const [writing, setWriting] = useState<RequestChoice | undefined>(undefined);
  const [text, setText] = useState("");
  const answer = () => {
    if (busy || writing === undefined) return;
    send({ kind: "choice", choiceId: writing.id, text });
  };
  const keys = useMessageKeys(answer);
  if (writing) {
    return (
      <form
        className="conversation-request-text"
        onSubmit={(event) => {
          event.preventDefault();
          answer();
        }}
      >
        <textarea
          aria-label={writing.label}
          value={text}
          autoFocus
          onChange={(event) => setText(event.target.value)}
          {...keys}
        />
        <div className="conversation-request-choices">
          <button
            type="button"
            className="conversation-request-choice"
            disabled={busy}
            onClick={() => setWriting(undefined)}
          >
            Back
          </button>
          <button
            type="submit"
            className="conversation-request-choice"
            data-tone={writing.tone}
            title={`${writing.label} (${SEND_KEY})`}
            disabled={busy}
          >
            {writing.label}
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="conversation-request-choices">
      {choices.map((choice, index) => (
        <button
          key={choice.id}
          type="button"
          className="conversation-request-choice"
          data-tone={choice.tone}
          data-choice-index={index}
          aria-keyshortcuts={index < 9 ? `${index + 1}` : undefined}
          disabled={busy}
          onClick={() => {
            if (choice.takesText) setWriting(choice);
            else send({ kind: "choice", choiceId: choice.id, text: undefined });
          }}
        >
          {index < 9 ? (
            <span className="conversation-request-key" aria-hidden>
              {index + 1}
            </span>
          ) : null}
          {choice.label}
          {choice.takesText ? "…" : null}
        </button>
      ))}
    </div>
  );
}

type Picked = Readonly<Record<string, readonly string[]>>;

/**
 * A preview's Markdown with each line's leading spaces kept. Markdown drops
 * the indentation of a paragraph's lines, which would pull an ASCII mockup's
 * columns out of line; outside a fenced block the spaces become no-break
 * spaces, which it keeps. A fenced block keeps its lines as they are anyway.
 */
function keepIndentation(source: string): string {
  let fence: string | undefined;
  return source
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
      if (marker !== undefined) {
        if (fence === undefined) fence = marker;
        else if (marker.startsWith(fence)) fence = undefined;
        return line;
      }
      if (fence !== undefined) return line;
      return line.replace(/^ +/u, (spaces) => "\u00a0".repeat(spaces.length));
    })
    .join("\n");
}

/**
 * The preview of an option, in its monospace box: here beside the options,
 * and in the answered call's record beside the option chosen.
 */
export function OptionPreview({ option }: { readonly option: QuestionOption }) {
  return (
    <div
      className="conversation-question-preview"
      role="region"
      aria-label={`Preview: ${option.label}`}
    >
      {option.preview === undefined ? (
        <p className="conversation-question-no-preview">No preview</p>
      ) : (
        <Markdown source={keepIndentation(option.preview)} streaming={false} />
      )}
    </div>
  );
}

/**
 * One question: its options, and — when it is single-select and any option
 * carries a preview — beside them the preview of the option pointed at,
 * focused, or picked (the first option's before any is), as the CLI shows it.
 */
function QuestionFields({
  question,
  picked,
  pick,
  other,
  setOther,
  keys,
}: {
  readonly question: Question;
  readonly picked: readonly string[];
  readonly pick: (label: string, on: boolean) => void;
  readonly other: string;
  readonly setOther: (text: string) => void;
  readonly keys: MessageKeys<HTMLTextAreaElement>;
}) {
  const [pointed, setPointed] = useState<string | undefined>(undefined);
  const [focused, setFocused] = useState<string | undefined>(undefined);
  const previewed =
    !question.multiSelect &&
    question.options.some((option) => option.preview !== undefined);
  const shownLabel =
    pointed ?? focused ?? picked[0] ?? question.options[0]?.label;
  const shown = question.options.find((option) => option.label === shownLabel);
  return (
    <fieldset className="conversation-question">
      <legend>{question.header}</legend>
      <p>{question.text}</p>
      <div
        className="conversation-question-body"
        data-previewed={previewed || undefined}
      >
        <div className="conversation-question-options">
          {question.options.map((option) => (
            <label
              key={option.label}
              className="conversation-question-option"
              data-shown={(previewed && option === shown) || undefined}
              onMouseEnter={() => setPointed(option.label)}
              onMouseLeave={() => setPointed(undefined)}
            >
              <input
                type={question.multiSelect ? "checkbox" : "radio"}
                name={question.id}
                checked={picked.includes(option.label)}
                onChange={(event) => pick(option.label, event.target.checked)}
                onFocus={() => setFocused(option.label)}
                onBlur={() => setFocused(undefined)}
              />
              <span>{option.label}</span>
              {option.description ? (
                <span className="conversation-question-description">
                  {option.description}
                </span>
              ) : null}
            </label>
          ))}
          {question.allowsOther ? (
            <textarea
              className="conversation-question-other"
              aria-label={`${question.header}: other`}
              placeholder="Other"
              rows={1}
              value={other}
              onChange={(event) => setOther(event.target.value)}
              {...keys}
            />
          ) : null}
        </div>
        {previewed && shown !== undefined ? (
          <OptionPreview option={shown} />
        ) : null}
      </div>
    </fieldset>
  );
}

function QuestionForm({
  questions,
  busy,
  send,
}: {
  readonly questions: readonly Question[];
  readonly busy: boolean;
  readonly send: (answer: RequestAnswer) => void;
}) {
  const [picked, setPicked] = useState<Picked>({});
  const [other, setOther] = useState<Readonly<Record<string, string>>>({});
  const pick = (question: Question, label: string, on: boolean) => {
    setPicked((before) => {
      const current = before[question.id] ?? [];
      const next = question.multiSelect
        ? on
          ? [...current, label]
          : current.filter((item) => item !== label)
        : [label];
      return { ...before, [question.id]: next };
    });
  };
  const answer = () => {
    if (busy) return;
    const values: Record<string, string | readonly string[]> = {};
    for (const question of questions) {
      const typed = other[question.id]?.trim();
      const chosen = picked[question.id] ?? [];
      const all = typed ? [...chosen, typed] : chosen;
      values[question.id] = question.multiSelect ? all : (all[0] ?? "");
    }
    send({ kind: "answers", values });
  };
  // One set for every question's Other: only one of them has the keyboard.
  const keys = useMessageKeys(answer);
  return (
    <form
      className="conversation-request-questions"
      onSubmit={(event) => {
        event.preventDefault();
        answer();
      }}
    >
      {questions.map((question) => (
        <QuestionFields
          key={question.id}
          question={question}
          picked={picked[question.id] ?? []}
          pick={(label, on) => pick(question, label, on)}
          other={other[question.id] ?? ""}
          setOther={(text) =>
            setOther((before) => ({ ...before, [question.id]: text }))
          }
          keys={keys}
        />
      ))}
      <div className="conversation-request-choices">
        <button
          type="submit"
          className="conversation-request-choice"
          data-tone="allow"
          title={`Submit (${SEND_KEY})`}
          disabled={busy}
        >
          Submit
        </button>
      </div>
    </form>
  );
}

export function RequestCard({ request }: { readonly request: PendingRequest }) {
  const { answer, reportFailure } = useConversationActions();
  const focusComposer = useFocusComposer();
  const [busy, setBusy] = useState(false);
  const send = (reply: RequestAnswer) => {
    setBusy(true);
    void answer(request.id, reply)
      .catch(reportFailure)
      .finally(() => setBusy(false));
  };
  return (
    <div
      className="conversation-request"
      role="group"
      aria-label="The Agent is waiting for an answer"
      data-request-id={request.id}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // Back to the composer, and not an interrupt: the surface would
          // read the same key as "stop the turn".
          event.preventDefault();
          event.stopPropagation();
          focusComposer();
          return;
        }
        const target = event.target as HTMLElement;
        if (target.matches("input, textarea")) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (!/^[1-9]$/.test(event.key)) return;
        const button = event.currentTarget.querySelector<HTMLButtonElement>(
          `[data-choice-index="${Number(event.key) - 1}"]`,
        );
        if (!button || button.disabled) return;
        event.preventDefault();
        button.click();
      }}
    >
      <div className="conversation-request-eyebrow" aria-hidden="true">
        Needs your answer
      </div>
      <Subject request={request} />
      {request.subject.kind === "question" ? (
        <QuestionForm
          questions={request.subject.questions}
          busy={busy}
          send={send}
        />
      ) : null}
      {request.choices.length > 0 ? (
        <Choices choices={request.choices} busy={busy} send={send} />
      ) : null}
    </div>
  );
}
