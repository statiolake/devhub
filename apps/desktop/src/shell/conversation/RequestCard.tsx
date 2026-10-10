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
 * A request answered by filling something in — questions, an elicitation's
 * fields, which may be none — has a form, whose submit is the first answer
 * in the row, before the adapter's choices.
 *
 * From the keyboard, as in the CLIs' own dialogs: with the card focused, 1–9
 * press its answers in order, and Esc goes back to the composer. What is typed
 * into it is written under the composer's keys (`messageKeys.ts`): Return is a
 * new line and ⌘Return answers.
 */

import { useId, useState, type ReactNode } from "react";
import type {
  AskedQuestion,
  PendingRequest,
  Question,
  QuestionOption,
  RequestAnswer,
  RequestChoice,
} from "../../model/conversation";
import {
  formContent,
  initialValues,
  type FormField,
  type FormValues,
} from "../../model/elicitationForm";
import {
  useConversationActions,
  useFocusComposer,
} from "./ConversationContext";
import { DiffView, JsonView } from "./EntryParts";
import { ExternalLink, Markdown } from "./Markdown";
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
      // Its fields are the form below.
      return (
        <>
          <div className="conversation-request-title">{subject.server}</div>
          <p className="conversation-request-reason">{subject.message}</p>
          {subject.url === undefined ? null : (
            <p className="conversation-request-url">
              <ExternalLink href={subject.url}>{subject.url}</ExternalLink>
            </p>
          )}
        </>
      );
  }
}

/**
 * The card's answers in one row, numbered in order: the submit of its form
 * first, when it has one (`submit`, the form's element id and the word on
 * its button), then the adapter's choices.
 */
function Choices({
  submit,
  choices,
  busy,
  send,
}: {
  readonly submit:
    | { readonly form: string; readonly label: string }
    | undefined;
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
  const first = submit === undefined ? 0 : 1;
  return (
    <div className="conversation-request-choices">
      {submit === undefined ? null : (
        <button
          type="submit"
          form={submit.form}
          className="conversation-request-choice"
          data-tone="allow"
          data-choice-index={0}
          aria-keyshortcuts="1"
          title={`${submit.label} (${SEND_KEY})`}
          disabled={busy}
        >
          <ChoiceKey index={0} />
          {submit.label}
        </button>
      )}
      {choices.map((choice, at) => {
        const index = first + at;
        return (
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
              else
                send({ kind: "choice", choiceId: choice.id, text: undefined });
            }}
          >
            <ChoiceKey index={index} />
            {choice.label}
            {choice.takesText ? "…" : null}
          </button>
        );
      })}
    </div>
  );
}

/** The digit that presses an answer from the keyboard: the first nine have one. */
function ChoiceKey({ index }: { readonly index: number }) {
  return index < 9 ? (
    <span className="conversation-request-key" aria-hidden>
      {index + 1}
    </span>
  ) : null;
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
  multiple,
}: {
  readonly multiple: boolean;
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
      data-kind={multiple ? "checkbox" : "radio"}
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
  position,
}: {
  readonly question: Question;
  readonly resting: string | undefined;
  readonly rows: (
    shown: (label: string) => boolean,
    point: (label: string, on: boolean) => void,
  ) => ReactNode;
  readonly after?: ReactNode;
  readonly Frame: "fieldset" | "div";
  readonly position?: { readonly index: number; readonly count: number };
}) {
  const [pointed, setPointed] = useState<string | undefined>(undefined);
  const beside = previewed(question);
  const shownLabel = pointed ?? resting ?? question.options[0]?.label;
  const shown = question.options.find((option) => option.label === shownLabel);
  const Header = Frame === "fieldset" ? "legend" : "div";
  return (
    <Frame className="conversation-question">
      {question.header === "" && position === undefined ? null : (
        <div className="conversation-question-top">
          {question.header === "" ? null : (
            <Header className="conversation-question-header">
              {question.header}
            </Header>
          )}
          {position === undefined || position.count < 2 ? null : (
            <span className="conversation-question-step">
              {position.index + 1} of {position.count}
            </span>
          )}
        </div>
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
  position,
}: {
  readonly position: { readonly index: number; readonly count: number };
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
      position={position}
      question={question}
      resting={focused ?? picked[0]}
      rows={(shown, point) =>
        question.options.map((option) => (
          <OptionRow
            key={option.label}
            label={option.label}
            description={option.description}
            multiple={question.multiSelect}
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
          <div
            className="conversation-question-other-row"
            data-filled={other.trim() === "" ? undefined : true}
            data-kind={question.multiSelect ? "checkbox" : "radio"}
          >
            <span className="conversation-question-mark" aria-hidden="true">
              {other.trim() === "" ? "" : "✓"}
            </span>
            <textarea
              className="conversation-question-other"
              aria-label={`${question.header}: other`}
              placeholder="Other — type your own answer"
              rows={1}
              value={other}
              onChange={(event) => setOther(event.target.value)}
              {...keys}
            />
          </div>
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
                  multiple={question.multiSelect}
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
                  multiple={question.multiSelect}
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
  id,
  questions,
  busy,
  send,
}: {
  readonly id: string;
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
      id={id}
      className="conversation-request-questions"
      onSubmit={(event) => {
        event.preventDefault();
        answer();
      }}
    >
      {questions.map((question, index) => (
        <QuestionFields
          key={question.id}
          position={{ index, count: questions.length }}
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
    </form>
  );
}

/**
 * An elicitation's form: a control for each field, and under a field what is
 * wrong with it once the person has tried to accept. With no fields it is
 * nothing to see, and accepting it sends nothing filled in.
 */
function ElicitationForm({
  id,
  fields,
  busy,
  send,
}: {
  readonly id: string;
  readonly fields: readonly FormField[];
  readonly busy: boolean;
  readonly send: (answer: RequestAnswer) => void;
}) {
  const [values, setValues] = useState<FormValues>(() => initialValues(fields));
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>(
    {},
  );
  const set = (key: string, value: string | readonly string[]) =>
    setValues((before) => ({ ...before, [key]: value }));
  return (
    <form
      id={id}
      className="conversation-request-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        const found = formContent(fields, values).problems;
        setProblems(found);
        if (Object.keys(found).length === 0) send({ kind: "answers", values });
      }}
    >
      {fields.map((field) => (
        <FieldControl
          key={field.key}
          field={field}
          value={values[field.key]!}
          problem={problems[field.key]}
          set={(value) => set(field.key, value)}
        />
      ))}
    </form>
  );
}

function FieldControl({
  field,
  value,
  problem,
  set,
}: {
  readonly field: FormField;
  readonly value: string | readonly string[];
  readonly problem: string | undefined;
  readonly set: (value: string | readonly string[]) => void;
}) {
  const id = useId();
  const { input } = field;
  const label = field.required ? `${field.label} *` : field.label;
  const said = (
    <>
      {field.description === undefined ? null : (
        <p className="conversation-form-description" id={`${id}-description`}>
          {field.description}
        </p>
      )}
      {problem === undefined ? null : (
        <p className="conversation-form-problem" id={`${id}-problem`}>
          {problem}
        </p>
      )}
    </>
  );
  const describedBy =
    [
      field.description === undefined ? undefined : `${id}-description`,
      problem === undefined ? undefined : `${id}-problem`,
    ]
      .filter((part) => part !== undefined)
      .join(" ") || undefined;
  if (input.kind === "choice") {
    const chosen = typeof value === "string" ? [value] : value;
    return (
      <fieldset
        className="conversation-question conversation-form-field"
        data-invalid={problem === undefined ? undefined : true}
        aria-describedby={describedBy}
      >
        <legend className="conversation-question-header">{label}</legend>
        <div className="conversation-question-options">
          {input.options.map((option) => (
            <OptionRow
              key={option.value}
              multiple={input.multiple}
              label={option.label}
              description=""
              picked={chosen.includes(option.value)}
              shown={false}
              point={() => {}}
              control={
                <input
                  className="conversation-question-control"
                  type={input.multiple ? "checkbox" : "radio"}
                  name={`${id}-${field.key}`}
                  checked={chosen.includes(option.value)}
                  onChange={(event) =>
                    set(
                      !input.multiple
                        ? option.value
                        : event.target.checked
                          ? [...chosen, option.value]
                          : chosen.filter((item) => item !== option.value),
                    )
                  }
                />
              }
            />
          ))}
        </div>
        {said}
      </fieldset>
    );
  }
  if (typeof value !== "string")
    throw new Error(`field ${field.key} holds a list, but takes one value`);
  if (input.kind === "boolean") {
    return (
      <div
        className="conversation-form-field"
        data-invalid={problem === undefined ? undefined : true}
      >
        <label className="conversation-form-check">
          <input
            type="checkbox"
            checked={value === "true"}
            aria-describedby={describedBy}
            onChange={(event) => set(String(event.target.checked))}
          />
          {label}
        </label>
        {said}
      </div>
    );
  }
  return (
    <div
      className="conversation-form-field"
      data-invalid={problem === undefined ? undefined : true}
    >
      <label className="conversation-question-header" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="conversation-form-input"
        type={inputType(input)}
        step={input.kind === "number" && !input.integer ? "any" : undefined}
        min={input.kind === "number" ? input.minimum : undefined}
        max={input.kind === "number" ? input.maximum : undefined}
        value={value}
        aria-invalid={problem === undefined ? undefined : true}
        aria-describedby={describedBy}
        onChange={(event) => set(event.target.value)}
      />
      {said}
    </div>
  );
}

function inputType(
  input: Extract<FormField["input"], { kind: "text" | "number" }>,
): string {
  if (input.kind === "number") return "number";
  switch (input.format) {
    case "email":
      return "email";
    case "uri":
      return "url";
    case "date":
      return "date";
    case "date-time":
    case undefined:
      return "text";
  }
}

/** The form a request is answered by filling in, and the word on its submit. */
function formOf(
  request: PendingRequest,
  id: string,
  busy: boolean,
  send: (answer: RequestAnswer) => void,
): { readonly element: ReactNode; readonly submit: string } | undefined {
  const { subject } = request;
  switch (subject.kind) {
    case "question":
      return {
        element: (
          <QuestionForm
            id={id}
            questions={subject.questions}
            busy={busy}
            send={send}
          />
        ),
        submit: "Submit",
      };
    case "elicitation":
      return {
        element: (
          <ElicitationForm
            id={id}
            fields={subject.fields}
            busy={busy}
            send={send}
          />
        ),
        submit: "Accept",
      };
    case "tool":
    case "command":
    case "file-change":
      return undefined;
  }
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
  const formId = useId();
  const form = formOf(request, formId, busy, send);
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
      {form?.element}
      {form !== undefined || request.choices.length > 0 ? (
        <Choices
          submit={
            form === undefined
              ? undefined
              : { form: formId, label: form.submit }
          }
          choices={request.choices}
          busy={busy}
          send={send}
        />
      ) : null}
    </div>
  );
}
