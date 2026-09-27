/**
 * Where a subagent's work is drawn: inline in the card of the call that
 * started it, in a column beside the conversation, or filling the pane.
 *
 * One rule places every subagent, and its entries are drawn in exactly one
 * of those places at a time, so a request card, a selection or a Cmd+F hit is
 * never in two of them:
 *
 * - Maximized: the one subagent the person maximized fills the pane, the
 *   conversation and the column set aside until they switch back.
 * - Beside: when the pane is wide enough, a listed subagent is in the column.
 * - Inline: everywhere else, in its card, as it always was.
 *
 * One selection says which subagents are listed, and both the column and the
 * switcher bar list exactly those, in transcript order: a subagent while it
 * runs, or as the person chose once they put it beside or took it out (the
 * same rule as the inline card's fold), and the one filling the pane until
 * the person leaves it. Every other one is reached from its card.
 *
 * A narrow pane has no column, so a subagent is either inline or maximized,
 * and the switcher bar under the view moves between the conversation and
 * each listed subagent. A wide pane shows the switcher only while a subagent
 * is maximized: it is the way back.
 */

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  EntryId,
  ToolEntry,
  Transcript,
  TranscriptEntry,
} from "../../model/conversation";
import { EntryView } from "./EntryView";
import { NO_ENTRIES, type EntryTree } from "./entryTree";
import { useFollowScroll } from "./followScroll";
import { SubagentMessage } from "./SubagentMessage";

/** How wide the pane must be for a column beside the conversation. */
export const WIDE_PANE_PX = 1040;

export type SubagentPlace = "inline" | "beside" | "maximized";

export type SubagentEntry = ToolEntry & {
  readonly spawns: NonNullable<ToolEntry["spawns"]>;
};

export const SUBAGENT_STATE_LABELS: Readonly<
  Record<SubagentEntry["spawns"]["state"], string>
> = {
  running: "Running",
  idle: "Idle",
  completed: "Done",
  failed: "Failed",
  unknown: "Unknown",
};

/** Every call that started a subagent, at any depth, in transcript order. */
export function subagentsOf(transcript: Transcript): readonly SubagentEntry[] {
  return transcript.entries.filter(
    (entry): entry is SubagentEntry =>
      entry.kind === "tool" && entry.spawns !== undefined,
  );
}

/**
 * The subagents the column and the switcher list, in transcript order: each
 * as the person chose, or else while it runs, and the one filling the pane.
 */
export function listedSubagents(
  subagents: readonly SubagentEntry[],
  chosen: ReadonlyMap<EntryId, boolean>,
  maximized: EntryId | undefined,
): readonly SubagentEntry[] {
  return subagents.filter(
    (each) =>
      each.id === maximized ||
      (chosen.get(each.id) ?? each.spawns.state === "running"),
  );
}

export interface SubagentLayout {
  readonly wide: boolean;
  /** The subagents the column and the switcher list: `listedSubagents`. */
  readonly listed: readonly SubagentEntry[];
  /** The subagent filling the pane, or undefined while the conversation does. */
  readonly maximized: SubagentEntry | undefined;
  /** The subagents in the column: the listed ones, while it is shown. */
  readonly beside: readonly SubagentEntry[];
  readonly switcher: boolean;
  readonly placeOf: (id: EntryId) => SubagentPlace;
  /** Fill the pane with a subagent, or with the conversation (undefined). */
  readonly maximize: (id: EntryId | undefined) => void;
  /** Put a subagent in the column, or take it out. */
  readonly setBeside: (id: EntryId, beside: boolean) => void;
}

/** The pane's width, as the browser lays it out. */
function useWide(surface: RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) {
      throw new Error("the conversation's surface was not mounted");
    }
    const observer = new ResizeObserver((entries) => {
      const last = entries.at(-1);
      // A parked surface has no box: its width says nothing about the pane.
      if (!last || last.contentRect.width === 0) return;
      setWide(last.contentRect.width >= WIDE_PANE_PX);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [surface]);
  return wide;
}

const NO_SUBAGENTS: readonly SubagentEntry[] = [];

export function useSubagentLayout(
  transcript: Transcript,
  surface: RefObject<HTMLElement | null>,
): SubagentLayout {
  const wide = useWide(surface);
  const subagents = useMemo(() => subagentsOf(transcript), [transcript]);
  const [maximizedId, maximize] = useState<EntryId | undefined>(undefined);
  const [chosen, setChosen] = useState<ReadonlyMap<EntryId, boolean>>(
    () => new Map(),
  );

  // A subagent that is gone (its turn was taken back) fills nothing.
  const maximized = subagents.find((each) => each.id === maximizedId);
  const listed = useMemo(
    () => listedSubagents(subagents, chosen, maximized?.id),
    [subagents, chosen, maximized],
  );
  const beside = wide && maximized === undefined ? listed : NO_SUBAGENTS;

  const placeOf = useCallback(
    (id: EntryId): SubagentPlace =>
      maximized?.id === id
        ? "maximized"
        : beside.some((each) => each.id === id)
          ? "beside"
          : "inline",
    [maximized, beside],
  );

  const setBeside = useCallback((id: EntryId, value: boolean) => {
    setChosen((current) => new Map(current).set(id, value));
  }, []);

  return {
    wide,
    listed,
    maximized,
    beside,
    switcher: maximized !== undefined || (!wide && listed.length > 0),
    placeOf,
    maximize,
    setBeside,
  };
}

const SubagentLayoutContext = createContext<SubagentLayout | undefined>(
  undefined,
);

export const SubagentLayoutProvider = SubagentLayoutContext.Provider;

export function useSubagentPlacement(): SubagentLayout {
  const layout = useContext(SubagentLayoutContext);
  if (!layout) {
    throw new Error("a subagent was drawn outside a ConversationSurface");
  }
  return layout;
}

// ---------------------------------------------------------------------------

/** The actions on a subagent wherever it is drawn: where else it can go. */
export function SubagentActions({
  entry,
  place,
}: {
  readonly entry: SubagentEntry;
  readonly place: SubagentPlace;
}) {
  const layout = useSubagentPlacement();
  const label = entry.spawns.label;
  return (
    <div className="conversation-subagent-actions">
      {place === "inline" && layout.wide ? (
        <button
          type="button"
          className="conversation-subagent-action"
          aria-label={`Show ${label} beside the conversation`}
          title="Show beside the conversation"
          onClick={() => layout.setBeside(entry.id, true)}
        >
          Beside
        </button>
      ) : null}
      {place === "beside" ? (
        <button
          type="button"
          className="conversation-subagent-action"
          aria-label={`Put ${label} back in the conversation`}
          title="Put back in the conversation"
          onClick={() => layout.setBeside(entry.id, false)}
        >
          Close
        </button>
      ) : null}
      {place === "maximized" ? (
        <button
          type="button"
          className="conversation-subagent-action"
          aria-label="Back to the conversation"
          onClick={() => layout.maximize(undefined)}
        >
          Back
        </button>
      ) : (
        <button
          type="button"
          className="conversation-subagent-action"
          aria-label={`Maximize ${label}`}
          title="Fill the pane with this subagent"
          onClick={() => layout.maximize(entry.id)}
        >
          Maximize
        </button>
      )}
    </div>
  );
}

/** What a subagent's card says while its work is drawn somewhere else. */
export function SubagentElsewhere({
  place,
}: {
  readonly place: Exclude<SubagentPlace, "inline">;
}) {
  return (
    <div className="conversation-subagent-elsewhere">
      {place === "beside"
        ? "Shown in the column beside the conversation."
        : "Shown filling the pane."}
    </div>
  );
}

/**
 * A subagent's own transcript, in a pane of its own: the column's, or the
 * whole view's when maximized. It follows new output as the conversation
 * does. Its message box goes where its work is drawn, so it is here, under
 * the transcript, and not in the card.
 */
export function SubagentPane({
  entry,
  place,
  tree,
}: {
  readonly entry: SubagentEntry;
  readonly place: "beside" | "maximized";
  readonly tree: EntryTree;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const children: readonly TranscriptEntry[] =
    tree.children.get(entry.id) ?? NO_ENTRIES;
  useFollowScroll({ scroller, content, hidden: false, revision: tree });
  const { spawns } = entry;
  return (
    <section
      className="conversation-subagent-pane"
      data-place={place}
      data-state={spawns.state}
      data-view={entry.id}
      aria-label={`Subagent: ${spawns.label}`}
    >
      <header className="conversation-subagent-pane-header">
        <span className="conversation-subagent-label">{spawns.label}</span>
        {spawns.model ? (
          <span className="conversation-subagent-model">{spawns.model}</span>
        ) : null}
        <span className="conversation-subagent-state">
          {SUBAGENT_STATE_LABELS[spawns.state]}
        </span>
        <SubagentActions entry={entry} place={place} />
      </header>
      <div className="conversation-scroll" ref={scroller}>
        <div
          className="conversation-transcript conversation-selectable"
          ref={content}
        >
          {spawns.prompt ? (
            <div className="conversation-subagent-prompt">{spawns.prompt}</div>
          ) : null}
          {children.map((child) => (
            <EntryView key={child.id} entry={child} depth={0} />
          ))}
        </div>
      </div>
      <SubagentMessage entry={entry} />
    </section>
  );
}

/** The column beside the conversation: one pane per subagent, stacked. */
export function SubagentColumn({ tree }: { readonly tree: EntryTree }) {
  const { beside } = useSubagentPlacement();
  if (beside.length === 0) return null;
  return (
    <aside className="conversation-subagent-column" aria-label="Subagents">
      {beside.map((entry) => (
        <SubagentPane key={entry.id} entry={entry} place="beside" tree={tree} />
      ))}
    </aside>
  );
}

/**
 * The bar under the view that moves between the conversation and each
 * listed subagent: a tab strip, with the arrow keys moving along it. It
 * wraps rather than scrolls, so no tab is ever out of sight.
 */
export function SubagentSwitcher() {
  const layout = useSubagentPlacement();
  const bar = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const current = layout.maximized?.id;
  // A tab chosen from the keyboard takes the keyboard with it.
  useLayoutEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    bar.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.focus();
  }, [current]);
  if (!layout.switcher) return null;
  const views: readonly (EntryId | undefined)[] = [
    undefined,
    ...layout.listed.map((each) => each.id),
  ];
  const move = (by: number) => {
    const at = views.indexOf(current);
    const next = views[(at + by + views.length) % views.length];
    moved.current = true;
    layout.maximize(next);
  };
  return (
    <div
      ref={bar}
      className="conversation-switcher"
      role="tablist"
      aria-label="Conversation and subagents"
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") move(1);
        else if (event.key === "ArrowLeft") move(-1);
        else return;
        event.preventDefault();
      }}
    >
      <button
        type="button"
        role="tab"
        className="conversation-switcher-tab"
        aria-selected={current === undefined}
        tabIndex={current === undefined ? 0 : -1}
        onClick={() => layout.maximize(undefined)}
      >
        Conversation
      </button>
      {layout.listed.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="tab"
          className="conversation-switcher-tab"
          data-state={entry.spawns.state}
          aria-selected={current === entry.id}
          tabIndex={current === entry.id ? 0 : -1}
          title={`${entry.spawns.label} — ${SUBAGENT_STATE_LABELS[entry.spawns.state]}`}
          onClick={() => layout.maximize(entry.id)}
        >
          <span className="conversation-switcher-mark" aria-hidden="true" />
          <span className="conversation-switcher-label">
            {entry.spawns.label}
          </span>
        </button>
      ))}
    </div>
  );
}
