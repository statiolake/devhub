/**
 * Saying something to one subagent, from where its work is drawn.
 *
 * Offered only on a subagent whose `spawns.takesMessages` is true: the
 * adapter says so from what its CLI offers (a Codex thread app-server says
 * takes direct input). The words go to that subagent, not to the Agent that
 * started it — into its running turn, or starting one — and come back like
 * everything else, as its transcript. Enter sends, Shift+Enter is a new line,
 * and a key an input method is still composing is the input method's.
 *
 * The text is cleared only once main has it; a send that fails is handed to
 * the page's root and the text stays.
 */

import { useRef, useState } from "react";
import type { ToolEntry } from "../../model/conversation";
import { isImeComposing } from "../accessibility/ime";
import { useConversationActions } from "./ConversationContext";
import { SendIcon } from "./icons";

export function SubagentMessage({ entry }: { readonly entry: ToolEntry }) {
  const { instruct, reportFailure } = useConversationActions();
  const [text, setText] = useState("");
  const composing = useRef(false);
  if (entry.spawns?.takesMessages !== true) return null;
  const label = `Message to ${entry.spawns.label}`;

  const submit = () => {
    const line = text;
    if (line.trim() === "") return;
    void instruct(entry.id, line).then(() => {
      setText((current) => (current === line ? "" : current));
    }, reportFailure);
  };

  return (
    <div className="conversation-subagent-message">
      <textarea
        className="conversation-subagent-message-input"
        aria-label={label}
        placeholder={`Message ${entry.spawns.label} directly`}
        rows={1}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (isImeComposing(event.nativeEvent, composing.current)) return;
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.ctrlKey
          ) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <button
        type="button"
        className="conversation-subagent-message-send"
        aria-label={`Send to ${entry.spawns.label}`}
        title="Send to this subagent (Enter)"
        disabled={text.trim() === ""}
        onClick={submit}
      >
        <SendIcon />
      </button>
    </div>
  );
}
