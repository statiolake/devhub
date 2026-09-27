/**
 * The line under the composer's box: what the Agent has working in the
 * background, and beside it how full the context is.
 *
 * The CLI's own footer says it ("2 background tasks"), and so does this, in
 * the same place: a quiet line beside the context readout, drawn only while
 * something is working. It says how many and what they are, in short. Opened,
 * it lists each under that row, across the composer's whole width: its state
 * as the glyph a tool call's row has, its title, and its kind. A task whose
 * call is known opens it: a subagent fills the pane (`SubagentPanes`), any
 * other task's call is brought into view in the conversation, opened — the
 * same in a narrow pane and a wide one.
 *
 * What is listed is `Transcript.backgroundTasks` and nothing else: a task
 * that ends leaves the list because the conversation's account of it says so,
 * as a subagent that ends leaves the column.
 */

import { useId, useState, type ReactNode } from "react";
import type { EntryId, RunningTask } from "../../model/conversation";
import { ChevronDownIcon, ChevronRightIcon } from "./icons";
import { StatusMark } from "./StatusMark";

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
              <TaskLine task={task} openTask={openTask} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TaskLine({
  task,
  openTask,
}: {
  readonly task: RunningTask;
  readonly openTask: (call: EntryId) => void;
}) {
  const words = (
    <>
      {/* Every task listed is at work: the list holds nothing else. */}
      <StatusMark state="running" />
      <span className="conversation-background-title">{task.title}</span>
      <span className="conversation-background-kind">{task.kind}</span>
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
