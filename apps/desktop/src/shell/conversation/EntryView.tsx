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
  useState,
  type SyntheticEvent,
} from "react";
import type {
  AssistantBlock,
  AssistantEntry,
  NoticeEntry,
  PendingRequest,
  ToolEntry,
  TranscriptEntry,
  TurnEndEntry,
  Usage,
  UserEntry,
} from "../../model/conversation";
import { CopyButton } from "./CopyButton";
import { useEditMessage } from "./ConversationContext";
import { JsonView, OutputView } from "./EntryParts";
import { NO_ENTRIES, NO_REQUESTS, type EntryTree } from "./entryTree";
import { EditIcon } from "./icons";
import { Markdown } from "./Markdown";
import { RequestCard } from "./RequestCard";
import {
  SUBAGENT_STATE_LABELS,
  SubagentActions,
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
 * A message from the person: a bubble on the right, as it reads in any chat,
 * with its actions under it on hover — Copy, and Edit on the person's last
 * message while the session can take its turn back.
 */
function UserView({ entry }: { readonly entry: UserEntry }) {
  const { editable, editing, start } = useEditMessage();
  return (
    <div
      className="conversation-user"
      data-origin={entry.origin}
      data-editing={editing === entry.id || undefined}
    >
      {entry.origin === "injection" ? (
        <div className="conversation-user-origin">Sent by a template</div>
      ) : null}
      <div className="conversation-user-text">{entry.text}</div>
      <div className="conversation-message-actions">
        <CopyButton text={entry.text} label="Copy message" />
        {editable === entry.id ? (
          <button
            type="button"
            className="conversation-edit"
            aria-label="Edit message"
            title="Edit this message and send it again"
            onClick={() => start(entry)}
          >
            <EditIcon />
            <span className="conversation-copy-text">Edit</span>
          </button>
        ) : null}
      </div>
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
      return (
        <ol className="conversation-plan">
          {block.steps.map((step, index) => (
            <li key={index} data-status={step.status}>
              {step.text}
            </li>
          ))}
        </ol>
      );
  }
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

const TOOL_STATUS_LABELS: Readonly<Record<ToolEntry["status"], string>> = {
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  denied: "Denied",
  interrupted: "Interrupted",
};

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

const ToolBody = memo(function ToolBody({
  entry,
}: {
  readonly entry: ToolEntry;
}) {
  return (
    <div className="conversation-tool-body">
      <div className="conversation-tool-section">Input</div>
      <JsonView value={entry.input} />
      {entry.output ? (
        <>
          <div className="conversation-tool-section">Output</div>
          <OutputView output={entry.output} />
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
      <span className="conversation-tool-target">{title.slice(colon + 2)}</span>
    </span>
  );
}

function ToolSummary({ entry }: { readonly entry: ToolEntry }) {
  return (
    <summary className="conversation-tool-summary">
      <span
        className="conversation-tool-mark"
        data-status={entry.status}
        aria-hidden="true"
      />
      <ToolTitle title={entry.title} />
      <span className="conversation-tool-status">
        {TOOL_STATUS_LABELS[entry.status]}
      </span>
    </summary>
  );
}

const ToolView = memo(function ToolView({
  entry,
  childEntries,
  requests,
  depth,
}: {
  readonly entry: ToolEntry;
  readonly childEntries: readonly TranscriptEntry[];
  readonly requests: readonly PendingRequest[];
  readonly depth: number;
}) {
  const spawns = entry.spawns;
  const subagent = useDisclosure(spawns?.state === "running");
  const { placeOf } = useSubagentPlacement();
  const place = placeOf(entry.id);
  return (
    <div className="conversation-tool-entry" data-status={entry.status}>
      {/* Folded until asked for: output is most of a transcript's bulk, and
          a closed `<details>` keeps it out of layout. It is still in the
          document, so Cmd+F finds it and opens the entry it is in. */}
      <details className="conversation-tool">
        <ToolSummary entry={entry} />
        <ToolBody entry={entry} />
      </details>
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
            <span className="conversation-subagent-state">
              {SUBAGENT_STATE_LABELS[spawns.state]}
            </span>
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
            </div>
          ) : (
            <SubagentElsewhere place={place} />
          )}
        </details>
      ) : null}
      {spawns && place === "inline" ? (
        <SubagentActions entry={{ ...entry, spawns }} place={place} />
      ) : null}
    </div>
  );
});

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
    />
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

const OUTCOME_LABELS: Readonly<Record<TurnEndEntry["outcome"], string>> = {
  completed: "Turn completed",
  interrupted: "Turn interrupted",
  failed: "Turn failed",
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

function formatTokens(count: number): string {
  return count < 1000 ? `${count}` : `${(count / 1000).toFixed(1)}k`;
}

/** What a turn cost, in the terms the CLI reported. Nothing not reported. */
export function usageFacts(usage: Usage): readonly string[] {
  const facts: string[] = [];
  if (usage.inputTokens !== undefined)
    facts.push(`${formatTokens(usage.inputTokens)} in`);
  if (usage.outputTokens !== undefined)
    facts.push(`${formatTokens(usage.outputTokens)} out`);
  if (usage.costUsd !== undefined) facts.push(`$${usage.costUsd.toFixed(2)}`);
  return facts;
}

function TurnEndView({ entry }: { readonly entry: TurnEndEntry }) {
  const facts = [
    OUTCOME_LABELS[entry.outcome],
    ...(entry.durationMs === undefined
      ? []
      : [formatDuration(entry.durationMs)]),
    ...(entry.usage ? usageFacts(entry.usage) : []),
  ];
  return (
    <div
      className="conversation-turn-end"
      data-outcome={entry.outcome}
      role="separator"
    >
      <div className="conversation-turn-end-facts">{facts.join(" · ")}</div>
      {entry.detail ? (
        <div className="conversation-turn-end-detail">{entry.detail}</div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

export const EntryView = memo(function EntryView({
  entry,
  depth,
}: {
  readonly entry: TranscriptEntry;
  readonly depth: number;
}) {
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
    case "assistant":
      return <AssistantView entry={entry} />;
    case "tool":
      return <ToolEntryView entry={entry} depth={depth} />;
    case "notice":
      return <NoticeView entry={entry} />;
    case "turn-end":
      return <TurnEndView entry={entry} />;
  }
}
