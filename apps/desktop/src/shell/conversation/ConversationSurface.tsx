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
 * Around the transcript: the header (usage, the way out to a terminal) above
 * it, and below it a line naming the requests still waiting and the composer
 * (with the settings and Stop in its toolbar). Before the first entry, the
 * transcript's place says what the pane is for. Beside the conversation, when
 * the pane is wide, a column of subagents; in its place, a subagent the
 * person maximized; under it, the switcher between them (`SubagentPanes`). Esc and Ctrl+C stop a running turn from anywhere in the
 * pane, as they do in a terminal Agent; being shown puts the keyboard in the
 * composer, as being shown puts it in a terminal Agent's xterm. Cmd+Q and
 * the chords after it never reach here — main takes them first.
 */

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import type { AppAppearance } from "../../ipc/appShell";
import {
  rewindTargets,
  type Transcript,
  type UserEntry,
} from "../../model/conversation";
import { isImeComposing } from "../accessibility/ime";
import { Composer, inputRefusal } from "./Composer";
import {
  ConversationActionsProvider,
  RewindMessageProvider,
  FocusComposerProvider,
  type ConversationActions,
  type SettingName,
} from "./ConversationContext";
import { EntryTreeContext, EntryView, SendingView } from "./EntryView";
import { entryTree, NO_ENTRIES, type EntryTree } from "./entryTree";
import { useFollowScroll } from "./followScroll";
import { ArrowDownIcon } from "./icons";
import { RequestCard } from "./RequestCard";
import { SessionHeader } from "./SessionHeader";
import {
  SubagentColumn,
  SubagentLayoutProvider,
  SubagentPane,
  SubagentSwitcher,
  useSubagentLayout,
} from "./SubagentPanes";
import "./conversation.css";

export function waitingSentence(count: number): string {
  return count === 1
    ? "1 request is waiting for an answer"
    : `${count} requests are waiting for an answer`;
}

/** What the transcript's place shows before anything has been said. */
function EmptyTranscript() {
  return (
    <div className="conversation-empty">
      <div className="conversation-empty-title">What should the Agent do?</div>
      <div className="conversation-empty-hint">
        Enter sends, Shift+Enter starts a new line, and / lists the Agent's
        commands.
      </div>
    </div>
  );
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

  const surface = useRef<HTMLElement>(null);
  const subagents = useSubagentLayout(transcript, surface);
  const { maximized } = subagents;

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const { unseen, jumpToLatest } = useFollowScroll({
    scroller,
    content,
    // Set aside while a subagent fills the pane: held where it was, as a
    // parked surface is.
    hidden: hidden || maximized !== undefined,
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

  // A rewound message's words go back to the composer, each rewind once.
  const [restored, setRestored] = useState<UserEntry | undefined>(undefined);
  const targets = useMemo(() => rewindTargets(transcript), [transcript]);
  const rewindMessage = useMemo(
    () => ({
      targets,
      rewind: async (entry: UserEntry) => {
        if ((await actions.rewind(entry.id)) === "rewound") setRestored(entry);
      },
    }),
    [targets, actions],
  );

  // Being shown is a request to type into it, and so is becoming able to
  // take input while shown: a pane shown while its conversation is still
  // connecting has a disabled composer, which cannot take the keyboard, so the
  // keyboard goes there the moment it can.
  const accepting = inputRefusal(transcript.state) === undefined;
  useLayoutEffect(() => {
    if (!hidden && accepting) focusComposer();
  }, [hidden, accepting, focusComposer]);

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

  // A request card in the conversation while a subagent fills the pane is
  // shown by switching back first; the card is then found once it is drawn.
  const [revealing, setRevealing] = useState(false);
  const { maximize } = subagents;
  const showFirstRequest = useCallback(() => {
    const card = surface.current?.querySelector<HTMLElement>(
      ".conversation-request",
    );
    if (!card) {
      throw new Error(
        "requests are waiting, but no request card is drawn for any of them",
      );
    }
    if (card.closest(".conversation-body[hidden]")) {
      maximize(undefined);
      setRevealing(true);
      return;
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
  }, [maximize]);

  useLayoutEffect(() => {
    if (!revealing) return;
    setRevealing(false);
    showFirstRequest();
  }, [revealing, showFirstRequest]);

  // One size for the whole page: the terminal's, zoom included, so Cmd+- on
  // the Agents page reads the same on a GUI Agent as on a TUI one.
  const style = {
    "--conversation-font-size": `${appearance?.terminalFontSize ?? DEFAULT_FONT_SIZE}px`,
  } as CSSProperties;

  const topLevel = tree.children.get(null) ?? NO_ENTRIES;
  return (
    <ConversationActionsProvider value={actions}>
      <FocusComposerProvider value={focusComposer}>
        <RewindMessageProvider value={rewindMessage}>
          <EntryTreeContext.Provider value={tree}>
            <SubagentLayoutProvider value={subagents}>
              <section
                ref={surface}
                className="conversation-surface"
                aria-label={label}
                style={style}
                hidden={hidden}
                onKeyDown={onKeyDown}
              >
                <SessionHeader transcript={transcript} />
                <div className="conversation-views">
                  <div className="conversation-main">
                    <div
                      className="conversation-body"
                      data-view="conversation"
                      hidden={maximized !== undefined}
                    >
                      <div className="conversation-scroll" ref={scroller}>
                        {topLevel.length === 0 &&
                        transcript.sending.length === 0 &&
                        tree.unattached.length === 0 ? (
                          <EmptyTranscript />
                        ) : null}
                        <div
                          className="conversation-transcript conversation-selectable"
                          ref={content}
                        >
                          {topLevel.map((entry) => (
                            <EntryView key={entry.id} entry={entry} depth={0} />
                          ))}
                          {transcript.sending.map((message) => (
                            <SendingView key={message.id} message={message} />
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
                          <ArrowDownIcon />
                          New output
                        </button>
                      ) : null}
                    </div>
                    {maximized !== undefined ? (
                      <SubagentPane
                        key={maximized.id}
                        entry={maximized}
                        place="maximized"
                        tree={tree}
                      />
                    ) : null}
                    <SubagentSwitcher />
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
                      pickers={pickers}
                      openSetting={openSetting}
                      restored={restored}
                    />
                  </div>
                  <SubagentColumn tree={tree} />
                </div>
              </section>
            </SubagentLayoutProvider>
          </EntryTreeContext.Provider>
        </RewindMessageProvider>
      </FocusComposerProvider>
    </ConversationActionsProvider>
  );
}
