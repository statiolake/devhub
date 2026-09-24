/**
 * A GUI Agent's conversation, drawn: the Agents page's counterpart of
 * `TerminalSurface`.
 *
 * It draws a `Transcript` and nothing else. Where the Transcript comes from —
 * the snapshot and the events that follow it — is the page's wiring; this
 * component is handed the current one and draws it, which is also what lets a
 * test hand it a fixture.
 *
 * The whole transcript is in the document, always. There is no windowing:
 * each entry is `content-visibility: auto`, so the browser skips laying out
 * and painting what is off screen, while Cmd+F, a drag selection and a copy
 * still reach every word of it and the scroll is the browser's own, pixel for
 * pixel. See `conversation.css`.
 */

import { useMemo, useRef, type CSSProperties } from "react";
import type { AppAppearance } from "../../ipc/appShell";
import type { Transcript } from "../../model/conversation";
import {
  ConversationActionsProvider,
  type ConversationActions,
} from "./ConversationContext";
import { EntryTreeContext, EntryView } from "./EntryView";
import { entryTree, NO_ENTRIES, type EntryTree } from "./entryTree";
import { useFollowScroll } from "./followScroll";
import { RequestCard } from "./RequestCard";
import "./conversation.css";

/** The transcript's text size when the page has no appearance yet. */
const DEFAULT_FONT_SIZE = 13;

export function ConversationSurface({
  transcript,
  actions,
  appearance,
  hidden,
  label,
}: {
  readonly transcript: Transcript;
  readonly actions: ConversationActions;
  readonly appearance: AppAppearance | undefined;
  /** Parked in the pool: mounted, not shown. */
  readonly hidden: boolean;
  /** The Agent's name, for the screen reader. */
  readonly label: string;
}) {
  const previousTree = useRef<EntryTree | undefined>(undefined);
  const tree = useMemo(() => {
    const next = entryTree(transcript, previousTree.current);
    previousTree.current = next;
    return next;
  }, [transcript]);

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const { unseen, jumpToLatest } = useFollowScroll({
    scroller,
    content,
    hidden,
    revision: transcript,
  });

  // One size for the whole page: the terminal's, zoom included, so Cmd+- on
  // the Agents page reads the same on a GUI Agent as on a TUI one.
  const style = {
    "--conversation-font-size": `${appearance?.terminalFontSize ?? DEFAULT_FONT_SIZE}px`,
  } as CSSProperties;

  const topLevel = tree.children.get(null) ?? NO_ENTRIES;
  return (
    <ConversationActionsProvider value={actions}>
      <EntryTreeContext.Provider value={tree}>
        <section
          className="conversation-surface"
          aria-label={label}
          style={style}
          hidden={hidden}
        >
          <div className="conversation-scroll" ref={scroller}>
            <div className="conversation-transcript" ref={content}>
              {topLevel.map((entry) => (
                <EntryView key={entry.id} entry={entry} depth={0} />
              ))}
              {tree.unattached.map((request) => (
                <div
                  className="conversation-entry"
                  data-kind="request"
                  data-entry-id={`request:${request.id}`}
                  key={request.id}
                >
                  <RequestCard request={request} />
                </div>
              ))}
            </div>
          </div>
          {unseen ? (
            <button
              type="button"
              className="conversation-latest"
              onClick={jumpToLatest}
            >
              ↓ New output
            </button>
          ) : null}
        </section>
      </EntryTreeContext.Provider>
    </ConversationActionsProvider>
  );
}
