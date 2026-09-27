/**
 * What the Agent has working in the background, under the composer.
 *
 * The CLI's own footer says it ("2 background tasks"), and so does this, in
 * the same place: a quiet line beside the context readout, drawn only while
 * something is working. It says how many and what they are, in short; opened,
 * it lists each with its kind, and a task whose call is known is a way to
 * that call in the conversation, opened.
 *
 * What is listed is `Transcript.backgroundTasks` and nothing else: a task
 * that ends leaves the list because the conversation's account of it says so,
 * as a subagent that ends leaves the column.
 */

import { useId, useState } from "react";
import type { EntryId, RunningTask } from "../../model/conversation";
import { ChevronDownIcon, ChevronRightIcon } from "./icons";

export function backgroundSentence(count: number): string {
  return count === 1 ? "1 background task" : `${count} background tasks`;
}

export function BackgroundTasks({
  tasks,
  showCall,
}: {
  readonly tasks: readonly RunningTask[];
  /** Bring a call into view, opened. */
  readonly showCall: (call: EntryId) => void;
}) {
  const [open, setOpen] = useState(false);
  const list = useId();
  if (tasks.length === 0) return null;
  const sentence = backgroundSentence(tasks.length);
  return (
    <div className="conversation-background">
      <button
        type="button"
        className="conversation-background-toggle"
        aria-expanded={open}
        aria-controls={list}
        aria-label={sentence}
        onClick={() => setOpen((was) => !was)}
      >
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <span className="conversation-background-mark" aria-hidden="true" />
        <span className="conversation-background-count">{sentence}</span>
        {open ? null : (
          <span className="conversation-background-titles" aria-hidden="true">
            {tasks.map((task) => task.title).join(", ")}
          </span>
        )}
      </button>
      {open ? (
        <ul
          id={list}
          className="conversation-background-list"
          aria-label="Background tasks"
        >
          {tasks.map((task) => (
            <li key={task.id} className="conversation-background-task">
              <TaskLine task={task} showCall={showCall} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TaskLine({
  task,
  showCall,
}: {
  readonly task: RunningTask;
  readonly showCall: (call: EntryId) => void;
}) {
  const words = (
    <>
      <span className="conversation-background-title">{task.title}</span>
      <span className="conversation-background-kind">{task.kind}</span>
      <span className="conversation-background-state">Running</span>
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
      title="Show the call that started it"
      onClick={() => showCall(call)}
    >
      {words}
    </button>
  );
}
