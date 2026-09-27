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

import { useState, type ReactNode } from "react";
import type {
  AskedQuestion,
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
 * The preview of an option, in its monospace box: beside the options, on the
 * card and in the answered call's record.
 */
function OptionPreview({ option }: { readonly option: QuestionOption }) {
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

/** Whether a question lays its options out beside a preview: single-select, and some option has one. */
function previewed(question: Question): boolean {
  return (
    !question.multiSelect &&
    question.options.some((option) => option.preview !== undefined)
  );
}

/**
 * An option as a row of a list, as DevHub's pickers draw one: a check where
 * it is chosen, its label, and its description on one quiet line under it.
 * `control` is the card's radio or checkbox, there for the keyboard and
 * assistive technology; the answered record has none.
 */
function OptionRow({
  label,
  description,
  picked,
  shown,
  point,
  control,
}: {
  readonly label: string;
  readonly description: string;
  readonly picked: boolean;
  readonly shown: boolean;
  readonly point: (on: boolean) => void;
  readonly control?: ReactNode;
}) {
  const Row = control === undefined ? "div" : "label";
  return (
    <Row
      className="conversation-question-option"
      data-picked={picked || undefined}
      data-shown={shown || undefined}
      onMouseEnter={() => point(true)}
      onMouseLeave={() => point(false)}
    >
      {control}
      <span className="conversation-question-mark" aria-hidden="true">
        {picked ? "✓" : ""}
      </span>
      <span className="conversation-question-text">
        <span className="conversation-question-label">{label}</span>
        {description === "" ? null : (
          <span
            className="conversation-question-description"
            title={description}
          >
            {description}
          </span>
        )}
      </span>
    </Row>
  );
}

/**
 * A question's header as a small caption over its words, its options as a
 * list, and — when it is laid out beside a preview — the preview of the
 * option pointed at, else `resting`'s, as the CLI shows it.
 */
function QuestionLayout({
  question,
  resting,
  rows,
  after,
  Frame,
}: {
  readonly question: Question;
  readonly resting: string | undefined;
  readonly rows: (
    shown: (label: string) => boolean,
    point: (label: string, on: boolean) => void,
  ) => ReactNode;
  readonly after?: ReactNode;
  readonly Frame: "fieldset" | "div";
}) {
  const [pointed, setPointed] = useState<string | undefined>(undefined);
  const beside = previewed(question);
  const shownLabel = pointed ?? resting ?? question.options[0]?.label;
  const shown = question.options.find((option) => option.label === shownLabel);
  const Header = Frame === "fieldset" ? "legend" : "div";
  return (
    <Frame className="conversation-question">
      {question.header === "" ? null : (
        <Header className="conversation-question-header">
          {question.header}
        </Header>
      )}
      <p className="conversation-question-words">{question.text}</p>
      <div
        className="conversation-question-body"
        data-previewed={beside || undefined}
      >
        <div className="conversation-question-options">
          {rows(
            (label) => beside && label === shown?.label,
            (label, on) =>
              setPointed((was) =>
                on ? label : was === label ? undefined : was,
              ),
          )}
          {after}
        </div>
        {beside && shown !== undefined ? (
          <OptionPreview option={shown} />
        ) : null}
      </div>
    </Frame>
  );
}

/**
 * One question on the card, to answer: its options, picked by a click or
 * from the keyboard, and a field for words of the person's own.
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
  const [focused, setFocused] = useState<string | undefined>(undefined);
  return (
    <QuestionLayout
      Frame="fieldset"
      question={question}
      resting={focused ?? picked[0]}
      rows={(shown, point) =>
        question.options.map((option) => (
          <OptionRow
            key={option.label}
            label={option.label}
            description={option.description}
            picked={picked.includes(option.label)}
            shown={shown(option.label)}
            point={(on) => point(option.label, on)}
            control={
              <input
                className="conversation-question-control"
                type={question.multiSelect ? "checkbox" : "radio"}
                name={question.id}
                checked={picked.includes(option.label)}
                onChange={(event) => pick(option.label, event.target.checked)}
                onFocus={() => setFocused(option.label)}
                onBlur={() => setFocused(undefined)}
              />
            }
          />
        ))
      }
      after={
        question.allowsOther ? (
          <textarea
            className="conversation-question-other"
            aria-label={`${question.header}: other`}
            placeholder="Other"
            rows={1}
            value={other}
            onChange={(event) => setOther(event.target.value)}
            {...keys}
          />
        ) : null
      }
    />
  );
}

/**
 * What a call asked the person, kept in its fold for reference once it is
 * answered: each question as the card showed it — every option, the ones
 * chosen checked, what was written instead, and the previews. The answer
 * itself is said once, in the person's bubble (`AnswerView`).
 */
export function QuestionRecord({
  asked,
}: {
  readonly asked: readonly AskedQuestion[];
}) {
  return (
    <div className="conversation-question-record">
      {asked.map(({ question, answer }) => {
        const chosen = answer.secret ? [] : answer.chosen;
        return (
          <QuestionLayout
            key={question.id}
            Frame="div"
            question={question}
            resting={chosen[0]}
            rows={(shown, point) => [
              ...question.options.map((option) => (
                <OptionRow
                  key={option.label}
                  label={option.label}
                  description={option.description}
                  picked={chosen.includes(option.label)}
                  shown={shown(option.label)}
                  point={(on) => point(option.label, on)}
                />
              )),
              answer.written === undefined || answer.secret ? null : (
                <OptionRow
                  key="written"
                  label={answer.written}
                  description="Written instead"
                  picked
                  shown={false}
                  point={() => {}}
                />
              ),
            ]}
            after={
              answer.secret ? (
                <p className="conversation-question-note">Answer hidden</p>
              ) : answer.notes === undefined ? null : (
                <p className="conversation-question-note">
                  Note: {answer.notes}
                </p>
              )
            }
          />
        );
      })}
    </div>
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
