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
 * person maximized (`SubagentPanes`). Esc and Ctrl+C stop a running turn from anywhere in the
 * pane, as they do in a terminal Agent; being shown puts the keyboard in the
 * composer, as being shown puts it in a terminal Agent's xterm. Cmd+F opens
 * the find bar (`FindBar`), and F3 / Shift+F3 step through its matches from
 * anywhere in the pane while it is open. "Anywhere in the pane" includes the
 * keyboard being nowhere — on the page's body, where a click on the
 * transcript's words leaves it — so the pane shown takes those keys from the
 * document, not from its own element. Cmd+Q and
 * the chords after it never reach here — main takes them first.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { AppAppearance } from "../../ipc/appShell";
import {
  rewindTargets,
  type EntryId,
  type Transcript,
  type UserEntry,
} from "../../model/conversation";
import { isImeComposing } from "../accessibility/ime";
import { Composer, inputRefusal } from "./Composer";
import {
  AgentCwdProvider,
  ConversationActionsProvider,
  RewindMessageProvider,
  FocusComposerProvider,
  type ConversationActions,
  type SettingName,
} from "./ConversationContext";
import { EntryTreeContext, EntryView, SendingView } from "./EntryView";
import { FindBar, type FindBarHandle } from "./FindBar";
import { entryTree, NO_ENTRIES, type EntryTree } from "./entryTree";
import { useFollowScroll } from "./followScroll";
import { ArrowDownIcon } from "./icons";
import { SEND_KEY } from "./messageKeys";
import { RequestCard } from "./RequestCard";
import type { SettingPickerHandle } from "./SettingPickers";
import {
  SubagentColumn,
  SubagentLayoutProvider,
  SubagentPane,
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
        {SEND_KEY} sends, Return starts a new line, and / lists the Agent's
        commands.
      </div>
    </div>
  );
}

/**
 * Something to bring into view in the pane: the first element `selector`
 * finds, which must be drawn (`missing` says what broke if it is not). `open`
 * opens what of its own it has folded and says what takes the keyboard; by
 * default the element itself.
 */
interface Reveal {
  readonly selector: string;
  readonly missing: string;
  readonly open?: (found: HTMLElement) => HTMLElement;
}

/** The terminal's text size when the page has no appearance yet. */
const DEFAULT_FONT_SIZE = 13;

/**
 * The conversation's text size, a step larger than the terminal's.
 * Proportional prose at a terminal's size reads smaller than its monospace
 * does; at this step the terminal's 13 px is 15 px of prose, and the
 * transcript's code (0.88em) lands back near the terminal's own size.
 */
function conversationFontSize(terminalFontSize: number): number {
  return (terminalFontSize * 15) / 13;
}

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
  const { following, unseen, jumpToLatest } = useFollowScroll({
    scroller,
    content,
    // Set aside while a subagent fills the pane: held where it was, as a
    // parked surface is.
    hidden: hidden || maximized !== undefined,
    revision: transcript,
  });

  const composer = useRef<HTMLTextAreaElement>(null);
  const model = useRef<SettingPickerHandle>(null);
  const effort = useRef<SettingPickerHandle>(null);
  const mode = useRef<SettingPickerHandle>(null);
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
      picker.open();
    },
    [pickers],
  );

  // Cmd+F: the find bar, searching what is shown. Closing it gives the
  // keyboard back to where it was when it opened.
  const [finding, setFinding] = useState(false);
  const findBar = useRef<FindBarHandle>(null);
  const focusBeforeFind = useRef<HTMLElement | null>(null);
  const closeFind = useCallback(() => {
    setFinding(false);
    const before = focusBeforeFind.current;
    focusBeforeFind.current = null;
    if (before?.isConnected) before.focus();
    else focusComposer();
  }, [focusComposer]);
  const findRoot = useCallback(
    () =>
      maximized === undefined
        ? content.current
        : (surface.current?.querySelector<HTMLElement>(
            `[data-view="${CSS.escape(maximized.id)}"] .conversation-transcript`,
          ) ?? null),
    [maximized],
  );
  const findScope = useMemo(
    () =>
      maximized === undefined
        ? { key: "conversation", name: "Searching the conversation" }
        : {
            key: maximized.id,
            name: `Searching subagent ${maximized.spawns.label}`,
          },
    [maximized],
  );
  /** The find bar's keys; whether this one was one of them. */
  const findKey = (event: KeyboardEvent): boolean => {
    const onlyCommandOrShift = !event.altKey && !event.ctrlKey;
    if (
      event.metaKey &&
      !event.shiftKey &&
      onlyCommandOrShift &&
      event.key.toLowerCase() === "f"
    ) {
      event.preventDefault();
      if (finding) findBar.current?.focus();
      else {
        focusBeforeFind.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        setFinding(true);
      }
      return true;
    }
    if (finding && event.key === "F3" && !event.metaKey && onlyCommandOrShift) {
      event.preventDefault();
      findBar.current?.step(event.shiftKey ? -1 : 1);
      return true;
    }
    return false;
  };

  const running =
    transcript.state.phase === "ready" && transcript.state.turn === "running";
  const onKeyDown = (event: KeyboardEvent) => {
    if (isImeComposing(event)) return;
    if (findKey(event) || !running) return;
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
  // The pane's keys are the shown pane's wherever the keyboard is in it —
  // and also when it is nowhere: a click on the transcript's words, which
  // take no focus, leaves it on the page's body, outside the pane.
  const paneKeys = useRef(onKeyDown);
  paneKeys.current = onKeyDown;
  useEffect(() => {
    if (hidden) return;
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const inPane =
        target instanceof Node && surface.current?.contains(target) === true;
      const nowhere =
        target === document.body || target === document.documentElement;
      if (inPane || nowhere) paneKeys.current(event);
    };
    document.addEventListener("keydown", keyDown);
    return () => document.removeEventListener("keydown", keyDown);
  }, [hidden]);

  // Something drawn in the conversation while a subagent fills the pane is
  // shown by switching back first; it is then found once it is drawn.
  const [revealing, setRevealing] = useState<Reveal | undefined>(undefined);
  const { maximize } = subagents;
  const reveal = useCallback(
    (wanted: Reveal) => {
      const found = surface.current?.querySelector<HTMLElement>(
        wanted.selector,
      );
      if (!found) throw new Error(wanted.missing);
      if (found.closest(".conversation-body[hidden]")) {
        maximize(undefined);
        setRevealing(wanted);
        return;
      }
      // Inside a subagent the person folded it is still the thing asked
      // for: every fold around it opens, which the subagent records as the
      // person's own choice.
      for (
        let fold = found.parentElement?.closest("details");
        fold;
        fold = fold.parentElement?.closest("details")
      ) {
        fold.open = true;
      }
      const focused = wanted.open?.(found) ?? found;
      found.scrollIntoView({ block: "center" });
      focused.focus();
    },
    [maximize],
  );

  useLayoutEffect(() => {
    if (revealing === undefined) return;
    setRevealing(undefined);
    reveal(revealing);
  }, [revealing, reveal]);

  const showFirstRequest = useCallback(
    () =>
      reveal({
        selector: ".conversation-request",
        missing:
          "requests are waiting, but no request card is drawn for any of them",
      }),
    [reveal],
  );

  // A background task's call, opened: a subagent fills the pane, in a narrow
  // pane and a wide one alike; any other call is opened where it is drawn.
  const openTask = useCallback(
    (call: EntryId) => {
      if (subagents.all.some((each) => each.id === call)) {
        maximize(call);
        return;
      }
      reveal({
        selector: `[data-entry-id="${CSS.escape(call)}"]`,
        missing: `a background task names call ${call}, which is not drawn`,
        open: (entry) => {
          const fold = entry.querySelector<HTMLDetailsElement>(
            ":scope > .conversation-tool-entry > details.conversation-tool",
          );
          const summary = fold?.querySelector<HTMLElement>(":scope > summary");
          if (!fold || !summary) {
            throw new Error(
              `call ${entry.dataset.entryId} is not drawn as a tool call`,
            );
          }
          fold.open = true;
          return summary;
        },
      });
    },
    [subagents.all, maximize, reveal],
  );

  // One size for the whole page, a step from the terminal's, zoom included,
  // so Cmd+- on the Agents page scales a GUI Agent as it does a TUI one.
  const fontSize = conversationFontSize(
    appearance?.terminalFontSize ?? DEFAULT_FONT_SIZE,
  );
  const style = {
    "--conversation-font-size": `${fontSize}px`,
  } as CSSProperties;

  const topLevel = tree.children.get(null) ?? NO_ENTRIES;
  return (
    <ConversationActionsProvider value={actions}>
      <FocusComposerProvider value={focusComposer}>
        <RewindMessageProvider value={rewindMessage}>
          <AgentCwdProvider value={transcript.session.cwd}>
            <EntryTreeContext.Provider value={tree}>
              <SubagentLayoutProvider value={subagents}>
                <section
                  ref={surface}
                  className="conversation-surface"
                  aria-label={label}
                  style={style}
                  hidden={hidden}
                >
                  <div className="conversation-views">
                    {/* The Agent's own column, whose top right corner the
                      Continue button sits in (`ContinueElsewhere`). */}
                    <div className="conversation-main" data-agent-column="">
                      {finding ? (
                        <FindBar
                          ref={findBar}
                          root={findRoot}
                          scope={findScope}
                          revision={transcript}
                          onClose={closeFind}
                        />
                      ) : null}
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
                              <EntryView
                                key={entry.id}
                                entry={entry}
                                depth={0}
                              />
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
                        {following ? null : (
                          <button
                            type="button"
                            className="conversation-latest"
                            onClick={jumpToLatest}
                          >
                            <ArrowDownIcon />
                            {unseen ? "New output" : "Latest"}
                          </button>
                        )}
                      </div>
                      {maximized !== undefined ? (
                        <SubagentPane
                          key={maximized.id}
                          entry={maximized}
                          place="maximized"
                          tree={tree}
                        />
                      ) : null}
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
                        openTask={openTask}
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
          </AgentCwdProvider>
        </RewindMessageProvider>
      </FocusComposerProvider>
    </ConversationActionsProvider>
  );
}
