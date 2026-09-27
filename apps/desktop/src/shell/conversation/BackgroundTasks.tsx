/**
 * The line under the composer's box: what the Agent has working in the
 * background, and beside it how full the context is.
 *
 * The CLI's own footer says it ("2 background tasks"), and so does this, in
 * the same place: a quiet line beside the context readout, drawn only while
 * something is working. It says how many and what they are, in short. Opened,
 * it lists each under that row, across the composer's whole width: its state
 * as the glyph a tool call's row has, its title, its kind, and how long it
 * has run, from the time the CLI wrote on the call that started it
 * (`RunningTask.startedAt`), ticking. A task whose
 * call is known opens it: a subagent fills the pane (`SubagentPanes`), any
 * other task's call is brought into view in the conversation, opened — the
 * same in a narrow pane and a wide one. At its right end each has Stop,
 * which asks once more and then asks the CLI to stop it; a task the adapter
 * says cannot be stopped (`RunningTask.stoppable`) has it greyed, its tooltip
 * saying why.
 *
 * What is listed is `Transcript.backgroundTasks` and nothing else: a task
 * that ends leaves the list because the conversation's account of it says so,
 * as a subagent that ends leaves the column.
 */

import { useEffect, useId, useState, type ReactNode } from "react";
import type { EntryId, RunningTask } from "../../model/conversation";
import { useConversationActions } from "./ConversationContext";
import { ChevronDownIcon, ChevronRightIcon, StopIcon } from "./icons";
import { StatusMark } from "./StatusMark";

/**
 * How long something has run, as the CLI says it: `45s`, `3m 12s`,
 * `1h 5m`. A start the clock has not reached yet (another machine's clock
 * ahead of this one) reads as `0s`.
 */
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** The time now, moving once a second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

export function backgroundSentence(count: number): string {
  return count === 1 ? "1 background task" : `${count} background tasks`;
}

export function ComposerFooter({
  tasks,
  openTask,
  readout,
}: {
  readonly tasks: readonly RunningTask[];
  /** Open the call a task was started by: its subagent, or the call itself. */
  readonly openTask: (call: EntryId) => void;
  /** What stands at the right of the row: the context readout. */
  readonly readout: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const list = useId();
  const sentence = backgroundSentence(tasks.length);
  const shown = open && tasks.length > 0;
  const now = useNow(
    shown && tasks.some((task) => task.startedAt !== undefined),
  );
  return (
    <div className="conversation-footer">
      <div className="conversation-footer-row">
        {tasks.length === 0 ? null : (
          <button
            type="button"
            className="conversation-background-toggle"
            aria-expanded={shown}
            aria-controls={list}
            aria-label={sentence}
            onClick={() => setOpen((was) => !was)}
          >
            {shown ? <ChevronDownIcon /> : <ChevronRightIcon />}
            <span className="conversation-background-mark" aria-hidden="true" />
            <span className="conversation-background-count">{sentence}</span>
            {shown ? null : (
              <span
                className="conversation-background-titles"
                aria-hidden="true"
              >
                {tasks.map((task) => task.title).join(", ")}
              </span>
            )}
          </button>
        )}
        {readout}
      </div>
      {shown ? (
        <ul
          id={list}
          className="conversation-background-list"
          aria-label="Background tasks"
        >
          {tasks.map((task) => (
            <li key={task.id} className="conversation-background-task">
              <TaskLine task={task} openTask={openTask} now={now} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * What pressing Stop asks before it stops, by the task's kind: what stopping
 * ends, and what it leaves.
 */
export function stopQuestion(kind: string): string {
  switch (kind) {
    case "shell":
      return "Stop this background shell? Its command is ended.";
    case "subagent":
      return "Stop this subagent? Its work so far stays, and it won't resume on its own.";
    default:
      return "Stop this background task?";
  }
}

function TaskLine({
  task,
  openTask,
  now,
}: {
  readonly task: RunningTask;
  readonly openTask: (call: EntryId) => void;
  readonly now: number;
}) {
  const { stopTask, reportFailure } = useConversationActions();
  const [confirming, setConfirming] = useState(false);
  const { stoppable } = task;
  return (
    <>
      <div className="conversation-background-row">
        <TaskWords task={task} openTask={openTask} now={now} />
        <button
          type="button"
          className="conversation-background-stop"
          aria-label="Stop"
          title={stoppable === true ? "Stop this task" : stoppable.reason}
          disabled={stoppable !== true}
          aria-expanded={confirming}
          onClick={() => setConfirming(true)}
        >
          <StopIcon />
        </button>
      </div>
      {/* The task leaves the list only when the CLI says it ended: Stop
          asks, and the row stays until then. */}
      {confirming && stoppable === true ? (
        <div className="conversation-confirm" role="group" aria-label="Stop">
          <span className="conversation-confirm-note">
            {stopQuestion(task.kind)}
          </span>
          <button
            type="button"
            className="conversation-confirm-go"
            onClick={() => {
              setConfirming(false);
              void stopTask(task.id).catch(reportFailure);
            }}
          >
            Stop
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
    </>
  );
}

function TaskWords({
  task,
  openTask,
  now,
}: {
  readonly task: RunningTask;
  readonly openTask: (call: EntryId) => void;
  readonly now: number;
}) {
  const words = (
    <>
      {/* Every task listed is at work: the list holds nothing else. */}
      <StatusMark state="running" />
      <span className="conversation-background-title">{task.title}</span>
      <span className="conversation-background-kind">{task.kind}</span>
      {task.startedAt === undefined ? null : (
        <span
          className="conversation-background-elapsed"
          title="How long it has run"
        >
          {elapsedText(now - task.startedAt)}
        </span>
      )}
    </>
  );
  const { call } = task;
  // Until the CLI says which call started it, there is nowhere to go.
  if (call === undefined)
    return <span className="conversation-background-line">{words}</span>;
  return (
    <button
      type="button"
      className="conversation-background-line"
      title="Open what started it"
      onClick={() => openTask(call)}
    >
      {words}
    </button>
  );
}
