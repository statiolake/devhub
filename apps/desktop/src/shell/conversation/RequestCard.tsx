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
 */

import { useState } from "react";
import type {
  PendingRequest,
  Question,
  RequestAnswer,
  RequestChoice,
} from "../../model/conversation";
import { useConversationActions } from "./ConversationContext";
import { DiffView, JsonView } from "./EntryParts";

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
  if (writing) {
    return (
      <form
        className="conversation-request-text"
        onSubmit={(event) => {
          event.preventDefault();
          send({ kind: "choice", choiceId: writing.id, text });
        }}
      >
        <textarea
          aria-label={writing.label}
          value={text}
          autoFocus
          onChange={(event) => setText(event.target.value)}
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
      {choices.map((choice) => (
        <button
          key={choice.id}
          type="button"
          className="conversation-request-choice"
          data-tone={choice.tone}
          disabled={busy}
          onClick={() => {
            if (choice.takesText) setWriting(choice);
            else send({ kind: "choice", choiceId: choice.id, text: undefined });
          }}
        >
          {choice.label}
          {choice.takesText ? "…" : null}
        </button>
      ))}
    </div>
  );
}

type Picked = Readonly<Record<string, readonly string[]>>;

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
  return (
    <form
      className="conversation-request-questions"
      onSubmit={(event) => {
        event.preventDefault();
        const values: Record<string, string | readonly string[]> = {};
        for (const question of questions) {
          const typed = other[question.id]?.trim();
          const chosen = picked[question.id] ?? [];
          const all = typed ? [...chosen, typed] : chosen;
          values[question.id] = question.multiSelect ? all : (all[0] ?? "");
        }
        send({ kind: "answers", values });
      }}
    >
      {questions.map((question) => (
        <fieldset key={question.id} className="conversation-question">
          <legend>{question.header}</legend>
          <p>{question.text}</p>
          {question.options.map((option) => (
            <label key={option.label} className="conversation-question-option">
              <input
                type={question.multiSelect ? "checkbox" : "radio"}
                name={question.id}
                checked={(picked[question.id] ?? []).includes(option.label)}
                onChange={(event) =>
                  pick(question, option.label, event.target.checked)
                }
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
            <input
              type="text"
              className="conversation-question-other"
              aria-label={`${question.header}: other`}
              placeholder="Other"
              value={other[question.id] ?? ""}
              onChange={(event) =>
                setOther((before) => ({
                  ...before,
                  [question.id]: event.target.value,
                }))
              }
            />
          ) : null}
        </fieldset>
      ))}
      <div className="conversation-request-choices">
        <button
          type="submit"
          className="conversation-request-choice"
          data-tone="allow"
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
    >
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
