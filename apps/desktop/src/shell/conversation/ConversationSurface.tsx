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
 *
 * Around the transcript: the header (settings, usage, Stop, the way out to a
 * terminal) above it, and below it a line naming the requests still waiting
 * and the composer. Esc and Ctrl+C stop a running turn from anywhere in the
 * pane, as they do in a terminal Agent; being shown puts the keyboard in the
 * composer, as being shown puts it in a terminal Agent's xterm. Cmd+Q and
 * the chords after it never reach here — main takes them first.
 */

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import type { AppAppearance } from "../../ipc/appShell";
import type { Transcript } from "../../model/conversation";
import { isImeComposing } from "../accessibility/ime";
import { Composer } from "./Composer";
import {
  ConversationActionsProvider,
  FocusComposerProvider,
  type ConversationActions,
  type SettingName,
} from "./ConversationContext";
import { EntryTreeContext, EntryView } from "./EntryView";
import { entryTree, NO_ENTRIES, type EntryTree } from "./entryTree";
import { useFollowScroll } from "./followScroll";
import { RequestCard } from "./RequestCard";
import { SessionHeader } from "./SessionHeader";
import "./conversation.css";

export function waitingSentence(count: number): string {
  return count === 1
    ? "1 request is waiting for an answer"
    : `${count} requests are waiting for an answer`;
}

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

  const composer = useRef<HTMLTextAreaElement>(null);
  const model = useRef<HTMLSelectElement>(null);
  const effort = useRef<HTMLSelectElement>(null);
  const mode = useRef<HTMLSelectElement>(null);
  const pickers = useMemo(() => ({ model, effort, mode }), []);

  const focusComposer = useCallback(() => {
    composer.current?.focus();
  }, []);

  // Being shown is a request to type into it.
  useLayoutEffect(() => {
    if (!hidden) focusComposer();
  }, [hidden, focusComposer]);

  const openSetting = useCallback(
    (setting: SettingName) => {
      const picker = pickers[setting].current;
      if (!picker) {
        // The command's route names a setting this session offers no choices
        // for: the adapter and the session facts disagree.
        throw new Error(
          `a command opens the ${setting} picker, but the session offers no ${setting} choices`,
        );
      }
      picker.focus();
      picker.showPicker();
    },
    [pickers],
  );

  const running =
    transcript.state.phase === "ready" && transcript.state.turn === "running";
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!running || isImeComposing(event.nativeEvent)) return;
    const stop =
      (event.key === "Escape" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey) ||
      (event.key === "c" && event.ctrlKey && !event.metaKey && !event.altKey);
    if (!stop) return;
    event.preventDefault();
    void actions.interrupt().catch(actions.reportFailure);
  };

  const showFirstRequest = () => {
    const card = content.current?.querySelector<HTMLElement>(
      ".conversation-request",
    );
    if (!card) {
      throw new Error(
        "requests are waiting, but no request card is drawn for any of them",
      );
    }
    // A card inside a subagent the person folded is still the thing to
    // answer: every fold around it opens, which the subagent records as the
    // person's own choice.
    for (
      let fold = card.parentElement?.closest("details");
      fold;
      fold = fold.parentElement?.closest("details")
    ) {
      fold.open = true;
    }
    card.scrollIntoView({ block: "center" });
    card.focus();
  };

  // One size for the whole page: the terminal's, zoom included, so Cmd+- on
  // the Agents page reads the same on a GUI Agent as on a TUI one.
  const style = {
    "--conversation-font-size": `${appearance?.terminalFontSize ?? DEFAULT_FONT_SIZE}px`,
  } as CSSProperties;

  const topLevel = tree.children.get(null) ?? NO_ENTRIES;
  return (
    <ConversationActionsProvider value={actions}>
      <FocusComposerProvider value={focusComposer}>
        <EntryTreeContext.Provider value={tree}>
          <section
            className="conversation-surface"
            aria-label={label}
            style={style}
            hidden={hidden}
            onKeyDown={onKeyDown}
          >
            <SessionHeader transcript={transcript} pickers={pickers} />
            <div className="conversation-body">
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
            </div>
            {transcript.requests.length > 0 ? (
              <button
                type="button"
                className="conversation-waiting"
                onClick={showFirstRequest}
              >
                {waitingSentence(transcript.requests.length)} ↑
              </button>
            ) : null}
            <Composer
              transcript={transcript}
              inputRef={composer}
              openSetting={openSetting}
            />
          </section>
        </EntryTreeContext.Provider>
      </FocusComposerProvider>
    </ConversationActionsProvider>
  );
}
