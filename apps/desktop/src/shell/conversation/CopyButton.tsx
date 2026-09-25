import { useEffect, useState } from "react";
import { useConversationActions } from "./ConversationContext";
import { CheckIcon, CopyIcon } from "./icons";

/** How long "Copied" stands on the button after a copy lands. */
export const COPIED_MS = 1500;

/**
 * Put one piece of the transcript on the clipboard: an answer's Markdown
 * source, or one code block's contents.
 *
 * Through the page's `writeClipboard`, not `navigator.clipboard`: the browser
 * API is gated on the document having focus, and the Agents view does not
 * always have it at the moment of a click from another view's keyboard.
 *
 * "Copied" is drawn only once the write has resolved. A write that failed is
 * handed to the page's root and the button says nothing, because saying
 * "Copied" about a clipboard that was not written is the one thing it must not
 * do.
 */
export function CopyButton({
  text,
  label,
}: {
  readonly text: string;
  /** What is being copied, for the accessible name: "Copy answer". */
  readonly label: string;
}) {
  const { writeClipboard, reportFailure } = useConversationActions();
  const [copiedAt, setCopiedAt] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (copiedAt === undefined) return;
    const timer = window.setTimeout(() => setCopiedAt(undefined), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copiedAt]);

  return (
    <button
      type="button"
      className="conversation-copy"
      aria-label={label}
      data-copied={copiedAt !== undefined || undefined}
      onClick={() => {
        void writeClipboard(text).then(
          () => setCopiedAt(Date.now()),
          reportFailure,
        );
      }}
    >
      {copiedAt !== undefined ? <CheckIcon /> : <CopyIcon />}
      <span className="conversation-copy-text">
        {copiedAt !== undefined ? "Copied" : "Copy"}
      </span>
    </button>
  );
}
