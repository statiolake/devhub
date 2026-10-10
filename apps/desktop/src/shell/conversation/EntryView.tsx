/**
 * One entry of a transcript, and — for a tool call — everything under it.
 *
 * One component draws an entry wherever it stands: at the top level, or
 * inside a subagent inside a subagent. Depth is only an indentation, and the
 * indentation stops growing at the third level so a deep tree does not walk
 * off the side of the pane.
 *
 * Every entry is memoized on its own object. The fold replaces only the
 * entries an event touches, and `entryTree` keeps each parent's list of
 * children when none of them changed, so a delta redraws the answer it grew
 * and leaves the other two thousand where they are.
 */

import {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  workState,
  type AnswerEntry,
  type AssistantBlock,
  type AssistantEntry,
  type CommandEntry,
  type CompactionEntry,
  type Denial,
  type ImageRef,
  type LimitResume,
  type NoticeEntry,
  type PendingRequest,
  type PlanStep,
  type SendingMessage,
  type SentOrigin,
  type ToolEntry,
  type TranscriptEntry,
  type TurnEndEntry,
  type UserEntry,
} from "../../model/conversation";
import { CopyButton } from "./CopyButton";
import { REWIND_NOTE } from "./Composer";
import {
  useConversationActions,
  useRewindMessage,
} from "./ConversationContext";
import { Clip } from "./Clip";
import { REVEAL_EVENT } from "./findInTranscript";
import { DiffView, ImageView, JsonView, OutputView } from "./EntryParts";
import { SkillText } from "./skillTokens";
import { NO_ENTRIES, NO_REQUESTS, type EntryTree } from "./entryTree";
import { RewindIcon } from "./icons";
import { clockTime } from "../resetTime";
import { Markdown } from "./Markdown";
import { LinkedText } from "./LinkedText";
import { QuestionRecord, RequestCard } from "./RequestCard";
import { StatusMark, workNote } from "./StatusMark";
import { SubagentMessage } from "./SubagentMessage";
import {
  SubagentCardActions,
  SubagentElsewhere,
  useSubagentPlacement,
} from "./SubagentPanes";

export const EntryTreeContext = createContext<EntryTree | undefined>(undefined);

function useEntryTree(): EntryTree {
  const tree = useContext(EntryTreeContext);
  if (!tree) {
    throw new Error("a tool call was drawn outside a ConversationSurface");
  }
  return tree;
}

/** The deepest level that still indents. */
const MAX_INDENT = 3;

// ---------------------------------------------------------------------------
// User

/**
 * The person's bubble, on the right: their messages, those on their way, and
 * their answers to the Agent's questions are all this one bubble. A message
 * DevHub sent for them — a template's, or the one that goes on after a usage
 * limit — says so above it.
 */
const ORIGIN_NOTES: Readonly<Record<SentOrigin, string | undefined>> = {
  person: undefined,
  injection: "Sent by a template",
  "after-limit": "Sent automatically after the limit reset",
};

function PersonBubble({
  origin,
  children,
}: {
  readonly origin: SentOrigin;
  /** What the bubble holds; none draws no bubble. */
  readonly children: ReactNode;
}) {
  const note = ORIGIN_NOTES[origin];
  return (
    <>
      {note === undefined ? null : (
        <div className="conversation-user-origin">{note}</div>
      )}
      {children === null ? null : (
        <div className="conversation-user-text">{children}</div>
      )}
    </>
  );
}

/** What "Copy" on an answer to the Agent's questions copies: each question, then its answer. */
export function answerText(entry: AnswerEntry): string {
  return entry.answers
    .map((answer) =>
      [
        answer.header === ""
          ? answer.question
          : `${answer.header}: ${answer.question}`,
        ...answerLines(answer),
      ].join("\n"),
    )
    .join("\n\n");
}

function answerLines(answer: AnswerEntry["answers"][number]): string[] {
  if (answer.secret) return ["(hidden)"];
  const lines = [
    ...answer.chosen,
    ...(answer.written === undefined ? [] : [answer.written]),
  ];
  return [
    ...(lines.length === 0 ? ["(no answer)"] : lines),
    ...(answer.notes === undefined ? [] : [`Note: ${answer.notes}`]),
  ];
}

/**
 * The person's answer to questions the Agent asked, as their message: each
 * question, quietly, over what was chosen or written — every option of a
 * multi-select one, and a note when there is one.
 */
function AnswerView({ entry }: { readonly entry: AnswerEntry }) {
  return (
    <div className="conversation-user" data-origin="person">
      <PersonBubble origin="person">
        {entry.answers.map((answer, index) => (
          <div key={index} className="conversation-answer">
            <div className="conversation-answer-question">
              {answer.header === "" ? null : (
                <span className="conversation-answer-header">
                  {answer.header}
                </span>
              )}
              {answer.question}
            </div>
            {answer.secret ? (
              <div className="conversation-answer-empty">Hidden</div>
            ) : answer.chosen.length === 0 && answer.written === undefined ? (
              <div className="conversation-answer-empty">No answer</div>
            ) : (
              <ul className="conversation-answer-given">
                {answer.chosen.map((label) => (
                  <li key={label}>{label}</li>
                ))}
                {answer.written === undefined ? null : (
                  <li data-written="">{answer.written}</li>
                )}
              </ul>
            )}
            {answer.notes === undefined || answer.secret ? null : (
              <div className="conversation-answer-notes">
                Note: {answer.notes}
              </div>
            )}
          </div>
        ))}
      </PersonBubble>
      <div className="conversation-message-actions">
        <CopyButton text={answerText(entry)} label="Copy reply" />
      </div>
    </div>
  );
}

/**
 * A message from the person: a bubble on the right, as it reads in any chat,
 * with its actions under it on hover — Copy, and Rewind on each message the
 * conversation can be taken back to before (`rewindTargets`), which asks
 * once more before it drops anything.
 */
function UserView({ entry }: { readonly entry: UserEntry }) {
  if (entry.origin === "other") return <NotFromYouView entry={entry} />;
  return <PersonMessageView entry={entry} origin={entry.origin} />;
}

/** Past this many lines, a message not from the person is folded. */
export const NOT_FROM_YOU_LINES = 8;

/**
 * A message that reached the Agent as a user message DevHub did not send:
 * not the person's bubble but a muted card on the left that says so, its
 * words as they came, folded when they run long.
 */
function NotFromYouView({ entry }: { readonly entry: UserEntry }) {
  const [unfolded, setUnfolded] = useState(false);
  const lines = entry.text.split("\n");
  const long = lines.length > NOT_FROM_YOU_LINES;
  const folded = long && !unfolded;
  // Folded, its lines past the fold are hidden, not left out: the find bar
  // reaches them, and a match there unfolds it.
  const text = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = text.current;
    if (!element) return;
    const reveal = () => setUnfolded(true);
    element.addEventListener(REVEAL_EVENT, reveal);
    return () => element.removeEventListener(REVEAL_EVENT, reveal);
  }, []);
  return (
    <div className="conversation-other" data-folded={folded || undefined}>
      <div className="conversation-other-label">
        Message to the Agent (not from you)
      </div>
      {entry.text !== "" ? (
        <div ref={text} className="conversation-other-text" data-find-fold="">
          {lines.slice(0, NOT_FROM_YOU_LINES).join("\n")}
          {long ? (
            <span className="conversation-other-rest" hidden={folded}>
              {"\n" + lines.slice(NOT_FROM_YOU_LINES).join("\n")}
            </span>
          ) : null}
        </div>
      ) : null}
      <ImageStrip images={entry.images} />
      <div className="conversation-message-actions">
        {long ? (
          <button
            type="button"
            className="conversation-other-fold"
            aria-expanded={!folded}
            onClick={() => setUnfolded(folded)}
          >
            {folded ? "Show all" : "Show less"}
          </button>
        ) : null}
        <CopyButton text={entry.text} label="Copy message" />
      </div>
    </div>
  );
}

function PersonMessageView({
  entry,
  origin,
}: {
  readonly entry: UserEntry;
  readonly origin: SentOrigin;
}) {
  const { targets, rewind } = useRewindMessage();
  const { reportFailure } = useConversationActions();
  const [confirming, setConfirming] = useState(false);
  const rewindable = targets.has(entry.id);
  return (
    <div
      className="conversation-user"
      data-origin={origin}
      data-confirming={(confirming && rewindable) || undefined}
    >
      <PersonBubble origin={origin}>
        {entry.text !== "" ? <SkillText text={entry.text} /> : null}
      </PersonBubble>
      <ImageStrip images={entry.images} />
      <div className="conversation-message-actions">
        <CopyButton text={entry.text} label="Copy message" />
        {rewindable ? (
          <button
            type="button"
            className="conversation-rewind"
            aria-label="Rewind to here"
            title="Take the conversation back to before this message"
            onClick={() => setConfirming(true)}
          >
            <RewindIcon />
            <span className="conversation-copy-text">Rewind</span>
          </button>
        ) : null}
      </div>
      {confirming && rewindable ? (
        <div
          className="conversation-confirm"
          role="group"
          aria-label="Rewind to here"
        >
          <span className="conversation-confirm-note">{REWIND_NOTE}</span>
          <button
            type="button"
            className="conversation-confirm-go"
            onClick={() => {
              setConfirming(false);
              void rewind(entry).catch(reportFailure);
            }}
          >
            Rewind
          </button>
          <button
            type="button"
            className="conversation-confirm-cancel"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assistant

/** What "Copy" on an answer copies: its Markdown, block after block. */
export function answerSource(entry: AssistantEntry): string {
  return entry.blocks
    .flatMap((block) => (block.kind === "text" ? [block.markdown] : []))
    .join("\n\n");
}

function BlockView({
  block,
  streaming,
}: {
  readonly block: AssistantBlock;
  readonly streaming: boolean;
}) {
  switch (block.kind) {
    case "text":
      return <Markdown source={block.markdown} streaming={streaming} />;
    case "thinking":
      // Claude withholds the thinking itself and sends the block with no
      // text (only its signature): a fold with nothing inside would be drawn
      // once per message, so there is nothing to draw.
      if (block.text === "") return null;
      return (
        <details className="conversation-thinking">
          <summary>{streaming ? "Thinking…" : "Thought"}</summary>
          <div className="conversation-thinking-text">{block.text}</div>
        </details>
      );
    case "plan":
      return <PlanChecklist steps={block.steps} />;
  }
}

const STEP_LABELS: Readonly<Record<PlanStep["status"], string>> = {
  pending: "To do",
  in_progress: "Under way",
  completed: "Done",
};

/** A plan as a checklist: each step with a box that says how it stands. */
function PlanChecklist({ steps }: { readonly steps: readonly PlanStep[] }) {
  return (
    <ul className="conversation-checklist">
      {steps.map((step, index) => (
        <li key={index} data-status={step.status}>
          <span
            className="conversation-checklist-mark"
            role="img"
            aria-label={STEP_LABELS[step.status]}
          />
          {step.text}
        </li>
      ))}
    </ul>
  );
}

function AssistantView({ entry }: { readonly entry: AssistantEntry }) {
  const source = answerSource(entry);
  return (
    <div
      className="conversation-assistant"
      data-streaming={entry.streaming || undefined}
    >
      {entry.blocks.map((block, index) => (
        <BlockView
          key={index}
          block={block}
          // Only the last block can still be growing.
          streaming={entry.streaming && index === entry.blocks.length - 1}
        />
      ))}
      {source.length > 0 ? (
        <div className="conversation-message-actions">
          <CopyButton text={source} label="Copy answer" />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool calls and subagents

/**
 * A `<details>` whose default follows a condition until the person toggles
 * it. A subagent is open while it runs and closes when it finishes; once the
 * person has opened or closed it, their choice stands.
 */
function useDisclosure(openByDefault: boolean) {
  const [chosen, setChosen] = useState<boolean | undefined>(undefined);
  const open = chosen ?? openByDefault;
  return {
    open,
    onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => {
      const now = event.currentTarget.open;
      if (now !== open) setChosen(now);
    },
  };
}

/** Images in a row of thumbnails, each opening to itself whole. */
function ImageStrip({ images }: { readonly images: readonly ImageRef[] }) {
  if (images.length === 0) return null;
  return (
    <div className="conversation-images">
      {images.map((image, index) => (
        <ImageView key={index} image={image} />
      ))}
    </div>
  );
}

/** The images a call gave back, which are drawn on the call rather than folded into its output. */
function outputImages(entry: ToolEntry): readonly ImageRef[] {
  return (entry.output ?? []).flatMap((part) =>
    part.kind === "image" ? [part.image] : [],
  );
}

const ToolBody = memo(function ToolBody({
  entry,
}: {
  readonly entry: ToolEntry;
}) {
  const output = entry.output?.filter((part) => part.kind !== "image");
  return (
    <div className="conversation-tool-body">
      {entry.plan !== undefined ? (
        <>
          <div className="conversation-tool-section">Plan</div>
          <PlanChecklist steps={entry.plan} />
        </>
      ) : null}
      {entry.asked !== undefined ? (
        <>
          <div className="conversation-tool-section">Questions</div>
          <QuestionRecord asked={entry.asked} />
        </>
      ) : null}
      <div className="conversation-tool-section">Input</div>
      <JsonView value={entry.input} />
      {output !== undefined && output.length > 0 ? (
        <>
          <div className="conversation-tool-section">Output</div>
          <OutputView output={output} />
        </>
      ) : null}
    </div>
  );
});

/**
 * A title in the Agent's own form, `Verb: target`, split so the verb reads as
 * the row's word and the target as its detail. A title without the colon is
 * drawn whole. The colon stays in the text, so a copy reads as the Agent wrote
 * it.
 */
function ToolTitle({ title }: { readonly title: string }) {
  const colon = title.indexOf(": ");
  if (colon <= 0) {
    return <span className="conversation-tool-title">{title}</span>;
  }
  return (
    <span className="conversation-tool-title">
      <span className="conversation-tool-verb">
        {title.slice(0, colon + 1)}
      </span>{" "}
      <span className="conversation-tool-target">
        <LinkedText text={title.slice(colon + 2)} />
      </span>
    </span>
  );
}

function ToolSummary({ entry }: { readonly entry: ToolEntry }) {
  const note = workNote(entry);
  return (
    <summary className="conversation-tool-summary">
      <StatusMark state={workState(entry)} />
      <ToolTitle title={entry.title} />
      {entry.outsideSandbox ? (
        <span
          className="conversation-tool-sandbox"
          title="Ran outside the sandbox"
          aria-label="Ran outside the sandbox"
        >
          unsandboxed
        </span>
      ) : null}
      {note === undefined ? null : (
        <span className="conversation-tool-status">{note}</span>
      )}
    </summary>
  );
}

/**
 * A call's readable view: what it did, drawn for reading rather than as its
 * raw input and output, under its row and outside its fold — the change it
 * makes to files, the plan it set (the latest one; earlier ones stay in
 * their calls), the images it gave back. One slot for every tool, cut to a
 * height by the one `Clip`. A call with none of these has no readable view.
 */
function ReadableView({
  entry,
  planShown,
}: {
  readonly entry: ToolEntry;
  readonly planShown: boolean;
}) {
  const images = outputImages(entry);
  const plan = planShown ? entry.plan : undefined;
  if (entry.change === undefined && plan === undefined && images.length === 0)
    return null;
  return (
    <div className="conversation-readable">
      <Clip>
        {entry.change !== undefined ? <DiffView files={entry.change} /> : null}
        {plan !== undefined ? <PlanChecklist steps={plan} /> : null}
        <ImageStrip images={images} />
      </Clip>
    </div>
  );
}

const ToolView = memo(function ToolView({
  entry,
  childEntries,
  requests,
  depth,
  planShown,
}: {
  readonly entry: ToolEntry;
  readonly childEntries: readonly TranscriptEntry[];
  readonly requests: readonly PendingRequest[];
  readonly depth: number;
  /** Its plan is the Agent's latest, drawn unfolded. */
  readonly planShown: boolean;
}) {
  const spawns = entry.spawns;
  const subagent = useDisclosure(spawns?.state === "running");
  const { placeOf } = useSubagentPlacement();
  const place = placeOf(entry.id);
  return (
    <div
      className="conversation-tool-entry"
      data-status={workState(entry)}
      data-sandbox={entry.outsideSandbox ? "off" : undefined}
    >
      {/* Folded until asked for: output is most of a transcript's bulk, and
          a closed `<details>` keeps it out of layout. It is still in the
          document, so Cmd+F finds it and opens the entry it is in. */}
      <details className="conversation-tool">
        <ToolSummary entry={entry} />
        <ToolBody entry={entry} />
      </details>
      <ReadableView entry={entry} planShown={planShown} />
      {entry.background?.summary ? (
        // How a background task the call started ended, in the CLI's one
        // line; how it stands is the call's own mark.
        <div
          className="conversation-tool-background"
          data-state={entry.background.state}
        >
          {entry.background.summary}
        </div>
      ) : null}
      <DenialLine denial={entry.denial} />
      {requests.map((request) => (
        <RequestCard key={request.id} request={request} />
      ))}
      {spawns ? (
        <details
          className="conversation-subagent"
          data-state={spawns.state}
          data-place={place}
          open={subagent.open}
          onToggle={subagent.onToggle}
        >
          <summary className="conversation-subagent-summary">
            <span className="conversation-subagent-label">{spawns.label}</span>
            {spawns.model ? (
              <span className="conversation-subagent-model">
                {spawns.model}
              </span>
            ) : null}
          </summary>
          {/* Its work is drawn in one place at a time (`SubagentPanes`):
              here, unless it is in the column or filling the pane. */}
          {place === "inline" ? (
            <div
              className="conversation-subagent-entries"
              data-indent={Math.min(depth + 1, MAX_INDENT)}
            >
              {spawns.prompt ? (
                <div className="conversation-subagent-prompt">
                  {spawns.prompt}
                </div>
              ) : null}
              {childEntries.map((child) => (
                <EntryView key={child.id} entry={child} depth={depth + 1} />
              ))}
              <SubagentMessage entry={entry} />
            </div>
          ) : (
            <SubagentElsewhere place={place} />
          )}
        </details>
      ) : null}
      {spawns ? <SubagentCardActions entry={{ ...entry, spawns }} /> : null}
    </div>
  );
});

/**
 * A call the CLI's own permission check refused, said on the call in one
 * quiet line — who refused it and why — with the CLI's whole account folded
 * under it.
 */
function DenialLine({ denial }: { readonly denial: Denial | undefined }) {
  if (denial === undefined) return null;
  if (denial.detail === undefined)
    return <div className="conversation-tool-denial">{denial.summary}</div>;
  return (
    <details className="conversation-tool-denial">
      <summary>{denial.summary}</summary>
      <div className="conversation-tool-denial-detail">{denial.detail}</div>
    </details>
  );
}

/**
 * Looks up the tool call's own children and requests, and hands them down as
 * props: the lookup runs whenever the tree does, and the drawing only when
 * what it drew has changed.
 */
function ToolEntryView({
  entry,
  depth,
}: {
  readonly entry: ToolEntry;
  readonly depth: number;
}) {
  const tree = useEntryTree();
  return (
    <ToolView
      entry={entry}
      childEntries={tree.children.get(entry.id) ?? NO_ENTRIES}
      requests={tree.requests.get(entry.id) ?? NO_REQUESTS}
      depth={depth}
      planShown={tree.latestPlan === entry.id}
    />
  );
}

// ---------------------------------------------------------------------------
// Commands the CLI ran itself

/**
 * A slash command or shell-mode line, as one quiet line: what was typed,
 * and under it what it printed. It is the CLI's, not a message to the model.
 */
function CommandView({ entry }: { readonly entry: CommandEntry }) {
  return (
    <div
      className="conversation-command"
      data-failed={entry.failed || undefined}
    >
      <code className="conversation-command-line">
        {entry.line ?? "Command output"}
      </code>
      {entry.output !== undefined && entry.output !== "" ? (
        <pre className="conversation-command-output">
          <code>{entry.output}</code>
        </pre>
      ) : null}
    </div>
  );
}

/**
 * Where the CLI compacted the conversation: a divider across the transcript,
 * since everything above it is a summary to the model from here on.
 */
function CompactionView({ entry }: { readonly entry: CompactionEntry }) {
  const facts = [
    entry.trigger,
    entry.preTokens === undefined
      ? undefined
      : entry.postTokens === undefined
        ? `from ${entry.preTokens.toLocaleString("en-US")} tokens`
        : `from ${entry.preTokens.toLocaleString("en-US")} to ${entry.postTokens.toLocaleString("en-US")} tokens`,
  ].filter((fact): fact is string => fact !== undefined);
  return (
    <div className="conversation-compaction" role="separator">
      <span className="conversation-compaction-text">
        Conversation compacted
        {facts.length > 0 ? ` · ${facts.join(" · ")}` : ""}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notices and turn ends

function NoticeView({ entry }: { readonly entry: NoticeEntry }) {
  return (
    <div
      className="conversation-notice"
      data-level={entry.level}
      role={entry.level === "error" ? "alert" : undefined}
    >
      <div className="conversation-notice-text">{entry.text}</div>
      {entry.raw !== undefined ? (
        <details className="conversation-notice-raw">
          <summary>Event as received</summary>
          <JsonView value={entry.raw} />
        </details>
      ) : null}
    </div>
  );
}

/**
 * A turn that did not complete, and why: the one turn end the transcript draws.
 *
 * A turn that completed says nothing. The Agent's last words already end it,
 * and a divider of durations, tokens and cost under every answer was ink about
 * the meter rather than the work; what a session has used is the context
 * readout under the composer and the Sidebar's rate-limit readout.
 */
const OUTCOME_LABELS: Readonly<
  Record<Exclude<TurnEndEntry["outcome"], "completed">, string>
> = {
  interrupted: "Turn interrupted",
  failed: "Turn failed",
};

function TurnEndView({
  entry,
  outcome,
}: {
  readonly entry: TurnEndEntry;
  readonly outcome: keyof typeof OUTCOME_LABELS;
}) {
  return (
    <div
      className="conversation-turn-end"
      data-outcome={outcome}
      role="separator"
    >
      <div className="conversation-turn-end-facts">
        {OUTCOME_LABELS[outcome]}
      </div>
      {entry.detail ? (
        <div className="conversation-turn-end-detail">{entry.detail}</div>
      ) : null}
    </div>
  );
}

/**
 * A message written to the Agent that its CLI has not taken yet: the
 * person's bubble, drawn at once where the message will land, and quieter
 * until the CLI's echo puts the message itself there.
 */
export function SendingView({ message }: { readonly message: SendingMessage }) {
  return (
    <div
      className="conversation-entry"
      data-kind="user"
      data-sending=""
      data-entry-id={`sending:${message.id}`}
    >
      <div
        className="conversation-user"
        data-origin={message.origin}
        title="Sending…"
        aria-busy="true"
      >
        <PersonBubble origin={message.origin}>
          {message.text !== "" ? message.text : null}
        </PersonBubble>
        <ImageStrip images={message.images} />
      </div>
    </div>
  );
}

/**
 * The CLI compacting the conversation now (`Transcript.compacting`): the
 * compaction's divider, dashed and in progress, at the end of the
 * transcript, until the compaction's own divider takes its place.
 */
export function CompactingView() {
  return (
    <div
      className="conversation-entry"
      data-kind="compacting"
      data-entry-id="compacting"
    >
      <div className="conversation-compaction" data-running="" role="status">
        <span className="conversation-compaction-text">
          Compacting the conversation…
        </span>
      </div>
    </div>
  );
}

/**
 * What DevHub will do about the usage limit the conversation stopped at
 * (`Transcript.limitResume`): one quiet line at its end, as the CLI's own
 * information is, with the one thing that can be done about it — Cancel the
 * message that is to go on, or Dismiss the line that says why none will. A
 * write that failed keeps a warning's weight.
 */
export function LimitResumeView({ resume }: { readonly resume: LimitResume }) {
  const { cancelLimitResume, reportFailure } = useConversationActions();
  const [text, level, action] = limitResumeLine(resume, Date.now());
  return (
    <div
      className="conversation-entry"
      data-kind="limit-resume"
      data-entry-id="limit-resume"
    >
      <div className="conversation-notice" data-level={level}>
        <span className="conversation-notice-text">{text}</span>
        <button
          type="button"
          className="conversation-notice-action"
          onClick={() => void cancelLimitResume().catch(reportFailure)}
        >
          {action}
        </button>
      </div>
    </div>
  );
}

/** The line's words, its level, and what its button says. */
export function limitResumeLine(
  resume: LimitResume,
  now: number,
): readonly [string, "info" | "warning", "Cancel" | "Dismiss"] {
  switch (resume.kind) {
    case "scheduled":
      return [
        `Rate limited — resuming at ${clockTime(resume.at, now)}`,
        "info",
        "Cancel",
      ];
    case "unscheduled":
      return [
        `Rate limited — not resuming by itself: ${resume.reason}`,
        "info",
        "Dismiss",
      ];
    case "failed":
      return [
        `Rate limited — could not resume: ${resume.failure}`,
        "warning",
        "Dismiss",
      ];
  }
}

// ---------------------------------------------------------------------------

export const EntryView = memo(function EntryView({
  entry,
  depth,
}: {
  readonly entry: TranscriptEntry;
  readonly depth: number;
}) {
  // A completed turn's end is not drawn at all — not even as an empty entry,
  // which would still take the gap between entries (see `TurnEndView`).
  if (entry.kind === "turn-end" && entry.outcome === "completed") return null;
  return (
    <div
      className="conversation-entry"
      data-kind={entry.kind}
      data-entry-id={entry.id}
    >
      {entryBody(entry, depth)}
    </div>
  );
});

function entryBody(entry: TranscriptEntry, depth: number) {
  switch (entry.kind) {
    case "user":
      return <UserView entry={entry} />;
    case "answer":
      return <AnswerView entry={entry} />;
    case "assistant":
      return <AssistantView entry={entry} />;
    case "tool":
      return <ToolEntryView entry={entry} depth={depth} />;
    case "command":
      return <CommandView entry={entry} />;
    case "compaction":
      return <CompactionView entry={entry} />;
    case "notice":
      return <NoticeView entry={entry} />;
    case "turn-end":
      return entry.outcome === "completed" ? null : (
        <TurnEndView entry={entry} outcome={entry.outcome} />
      );
  }
}
