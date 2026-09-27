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
 * One selection says which subagents the column lists, in transcript order: a
 * subagent until it ends (running, or idle and able to run again), unless
 * the person took it out with the card's Beside toggle. One that ends leaves,
 * whatever the person chose; it is reached from its card, as every other one
 * is, and one at work also from the background tasks under the composer.
 *
 * The column is laid out as VS Code lays out its views (`subagentColumn.ts`):
 * a sash on its edge sets its width, a sash between two open panes shares
 * their height, and a pane folds to its header in its place, the open ones
 * taking the room.
 *
 * A narrow pane has no column, so a subagent is either inline or maximized.
 * A maximized one's header has the way back to the conversation.
 */

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  workState,
  type EntryId,
  type ToolEntry,
  type Transcript,
  type TranscriptEntry,
} from "../../model/conversation";
import { EntryView } from "./EntryView";
import { NO_ENTRIES, type EntryTree } from "./entryTree";
import { useFollowScroll } from "./followScroll";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ColumnIcon,
  MaximizeIcon,
} from "./icons";
import {
  INITIAL_COLUMN,
  SASH_STEP_PX,
  sashesOf,
  weightOf,
  withDefaultWidth,
  withEqualHeights,
  withFold,
  withPanesOf,
  withSashMoved,
  withWidth,
  type ColumnState,
  type MeasuredPane,
} from "./subagentColumn";
import { StatusMark, workNote } from "./StatusMark";
import { SubagentMessage } from "./SubagentMessage";

/** How wide the pane must be for a column beside the conversation. */
export const WIDE_PANE_PX = 1040;

export type SubagentPlace = "inline" | "beside" | "maximized";

export type SubagentEntry = ToolEntry & {
  readonly spawns: NonNullable<ToolEntry["spawns"]>;
};

/**
 * Whether a subagent has ended: it will not run again, so the column lets it
 * go. An idle one (a teammate waiting between tasks) has not.
 */
export const SUBAGENT_ENDED: Readonly<
  Record<SubagentEntry["spawns"]["state"], boolean>
> = {
  running: false,
  idle: false,
  completed: true,
  failed: true,
  unknown: true,
};

/** Every call that started a subagent, at any depth, in transcript order. */
export function subagentsOf(transcript: Transcript): readonly SubagentEntry[] {
  return transcript.entries.filter(
    (entry): entry is SubagentEntry =>
      entry.kind === "tool" && entry.spawns !== undefined,
  );
}

/**
 * The subagents the column lists, in transcript order: each one that has not
 * ended, unless the person took it out.
 */
export function listedSubagents(
  subagents: readonly SubagentEntry[],
  chosen: ReadonlyMap<EntryId, boolean>,
): readonly SubagentEntry[] {
  return subagents.filter(
    (each) =>
      !SUBAGENT_ENDED[each.spawns.state] && (chosen.get(each.id) ?? true),
  );
}

export interface SubagentLayout {
  readonly wide: boolean;
  /** Every call that started a subagent: `subagentsOf`. */
  readonly all: readonly SubagentEntry[];
  /** The subagents the column lists: `listedSubagents`. */
  readonly listed: readonly SubagentEntry[];
  /** The subagent filling the pane, or undefined while the conversation does. */
  readonly maximized: SubagentEntry | undefined;
  /** The subagents in the column: the listed ones, while it is shown. */
  readonly beside: readonly SubagentEntry[];
  readonly placeOf: (id: EntryId) => SubagentPlace;
  /** Fill the pane with a subagent, or with the conversation (undefined). */
  readonly maximize: (id: EntryId | undefined) => void;
  /** Put a subagent in the column, or take it out. */
  readonly setBeside: (id: EntryId, beside: boolean) => void;
  /** The column's sizes and folds. */
  readonly column: ColumnState;
  readonly changeColumn: (change: (state: ColumnState) => ColumnState) => void;
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
    () => listedSubagents(subagents, chosen),
    [subagents, chosen],
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

  const [storedColumn, changeColumn] = useState<ColumnState>(INITIAL_COLUMN);
  // A pane that left the column takes its size and fold with it, now, so it
  // comes back open at an ordinary size.
  const column = withPanesOf(
    storedColumn,
    new Set(listed.map((each) => each.id)),
  );
  if (column !== storedColumn) changeColumn(column);

  return {
    wide,
    all: subagents,
    listed,
    maximized,
    beside,
    placeOf,
    maximize,
    setBeside,
    column,
    changeColumn,
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

/**
 * Where else a subagent's work can go, under its card: beside the
 * conversation until it ends (a toggle, pressed while it is there), and
 * filling the pane while its work is in the card (in the column, its pane has
 * its own).
 */
export function SubagentCardActions({
  entry,
}: {
  readonly entry: SubagentEntry;
}) {
  const layout = useSubagentPlacement();
  const label = entry.spawns.label;
  const beside = layout.placeOf(entry.id) === "beside";
  return (
    <div className="conversation-subagent-actions">
      {layout.wide && !SUBAGENT_ENDED[entry.spawns.state] ? (
        <IconAction
          label={`Show ${label} beside the conversation`}
          tip={
            beside
              ? "Beside the conversation: press to put it back here"
              : "Show beside the conversation"
          }
          pressed={beside}
          onPress={() => layout.setBeside(entry.id, !beside)}
        >
          <ColumnIcon />
        </IconAction>
      ) : null}
      {beside ? null : (
        <IconAction
          label={`Maximize ${label}`}
          tip="Fill the pane with this subagent"
          onPress={() => layout.maximize(entry.id)}
        >
          <MaximizeIcon />
        </IconAction>
      )}
    </div>
  );
}

/** A small icon button: its name for the screen reader, its tip on hover. */
function IconAction({
  label,
  tip,
  pressed,
  expanded,
  onPress,
  children,
}: {
  readonly label: string;
  readonly tip: string;
  readonly pressed?: boolean;
  readonly expanded?: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="conversation-subagent-action"
      aria-label={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      title={tip}
      onClick={(event) => {
        event.stopPropagation();
        onPress();
      }}
    >
      {children}
    </button>
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
 * whole view's when maximized. Every pane has this one header: ← back to the
 * conversation on its left when it fills the pane; a fold on its left and
 * Maximize on its right when it is in the column. Folded, a column's pane is
 * only its header, and pressing the header unfolds it. It follows new output
 * as the conversation does. Its message box goes where its work is drawn, so
 * it is here, under the transcript, and not in the card.
 */
export function SubagentPane({
  entry,
  place,
  tree,
  style,
}: {
  readonly entry: SubagentEntry;
  readonly place: "beside" | "maximized";
  readonly tree: EntryTree;
  readonly style?: CSSProperties;
}) {
  const layout = useSubagentPlacement();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const children: readonly TranscriptEntry[] =
    tree.children.get(entry.id) ?? NO_ENTRIES;
  const folded = place === "beside" && layout.column.folded.has(entry.id);
  useFollowScroll({ scroller, content, hidden: folded, revision: tree });
  const { spawns } = entry;
  const note = workNote(entry);
  const fold = (value: boolean) =>
    layout.changeColumn((state) => withFold(state, entry.id, value));
  return (
    <section
      className="conversation-subagent-pane"
      data-place={place}
      data-state={spawns.state}
      data-folded={folded || undefined}
      data-view={entry.id}
      aria-label={`Subagent: ${spawns.label}`}
      style={style}
    >
      <header
        className="conversation-subagent-pane-header"
        onClick={place === "beside" ? () => fold(!folded) : undefined}
      >
        {place === "maximized" ? (
          <IconAction
            label="Back to the conversation"
            tip="Back to the conversation"
            onPress={() => layout.maximize(undefined)}
          >
            <ArrowLeftIcon />
          </IconAction>
        ) : (
          <IconAction
            label={`${folded ? "Unfold" : "Fold"} ${spawns.label}`}
            tip={folded ? "Unfold" : "Fold"}
            expanded={!folded}
            onPress={() => fold(!folded)}
          >
            {folded ? <ChevronRightIcon /> : <ChevronDownIcon />}
          </IconAction>
        )}
        <StatusMark state={workState(entry)} />
        <span className="conversation-subagent-label">{spawns.label}</span>
        {spawns.model ? (
          <span className="conversation-subagent-model">{spawns.model}</span>
        ) : null}
        {note === undefined ? null : (
          <span className="conversation-subagent-state">{note}</span>
        )}
        {place === "beside" ? (
          <div className="conversation-subagent-actions">
            <IconAction
              label={`Maximize ${spawns.label}`}
              tip="Fill the pane with this subagent"
              onPress={() => layout.maximize(entry.id)}
            >
              <MaximizeIcon />
            </IconAction>
          </div>
        ) : null}
      </header>
      <div className="conversation-scroll" ref={scroller} hidden={folded}>
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
      {folded ? null : <SubagentMessage entry={entry} />}
    </section>
  );
}

/**
 * A line the pointer drags, the arrow keys step and a double-click puts back:
 * the column's edge, or the line between two of its panes. `onMove` is given
 * how far it has moved since the drag began, so each move is measured from
 * where the sizes were rather than added up step by step.
 */
function Sash({
  label,
  orientation,
  onBegin,
  onMove,
  onReset,
}: {
  readonly label: string;
  /** Vertical: it moves left and right. Horizontal: up and down. */
  readonly orientation: "vertical" | "horizontal";
  readonly onBegin: () => void;
  readonly onMove: (delta: number) => void;
  readonly onReset: () => void;
}) {
  const origin = useRef<number | undefined>(undefined);
  const at = (event: ReactPointerEvent) =>
    orientation === "vertical" ? event.clientX : event.clientY;
  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    origin.current = undefined;
  };
  const [back, forth] =
    orientation === "vertical"
      ? ["ArrowLeft", "ArrowRight"]
      : ["ArrowUp", "ArrowDown"];
  return (
    <div
      className="conversation-sash"
      data-orientation={orientation}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      tabIndex={0}
      onPointerDown={(event) => {
        origin.current = at(event);
        event.currentTarget.setPointerCapture(event.pointerId);
        onBegin();
      }}
      onPointerMove={(event) => {
        if (origin.current === undefined) return;
        onMove(at(event) - origin.current);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const step =
          event.key === back
            ? -SASH_STEP_PX
            : event.key === forth
              ? SASH_STEP_PX
              : undefined;
        if (step === undefined) return;
        event.preventDefault();
        onBegin();
        onMove(step);
      }}
    />
  );
}

/**
 * The column beside the conversation: one pane per listed subagent, stacked,
 * with a sash on its edge and one between each two open panes.
 */
export function SubagentColumn({ tree }: { readonly tree: EntryTree }) {
  const { beside, column, changeColumn } = useSubagentPlacement();
  const aside = useRef<HTMLElement>(null);
  // The sizes as they were when a sash was taken hold of: each move is
  // measured from these.
  const width = useRef(0);
  const heights = useRef<readonly MeasuredPane[]>([]);
  if (beside.length === 0) return null;

  const open = beside.map((entry) => !column.folded.has(entry.id));
  const openPanes = beside.filter((_, index) => open[index]);
  const sashes = sashesOf(open);

  const holdWidth = () => {
    width.current = aside.current?.getBoundingClientRect().width ?? 0;
  };
  const holdHeights = () => {
    heights.current = openPanes.map((entry) => ({
      id: entry.id,
      height:
        aside.current
          ?.querySelector(`[data-view="${CSS.escape(entry.id)}"]`)
          ?.getBoundingClientRect().height ?? 0,
    }));
  };

  return (
    <aside
      ref={aside}
      className="conversation-subagent-column"
      aria-label="Subagents"
      style={
        column.width === undefined
          ? undefined
          : ({
              "--subagent-column-width": `${column.width}px`,
            } as CSSProperties)
      }
    >
      <Sash
        label="Resize the subagent column"
        orientation="vertical"
        onBegin={holdWidth}
        onMove={(delta) => {
          const across =
            aside.current?.parentElement?.getBoundingClientRect().width ?? 0;
          // The sash is on the column's left: moving left widens it.
          changeColumn((state) =>
            withWidth(state, width.current - delta, across),
          );
        }}
        onReset={() => changeColumn(withDefaultWidth)}
      />
      {beside.map((entry, index) => {
        const sash = sashes.find((each) => each.before === index);
        return (
          <Fragment key={entry.id}>
            {sash ? (
              <Sash
                label={`Resize ${paneLabel(openPanes, sash.above)} and ${paneLabel(openPanes, sash.below)}`}
                orientation="horizontal"
                onBegin={holdHeights}
                onMove={(delta) =>
                  changeColumn((state) =>
                    withSashMoved(
                      state,
                      heights.current,
                      sash.above,
                      sash.below,
                      delta,
                    ),
                  )
                }
                onReset={() => changeColumn(withEqualHeights)}
              />
            ) : null}
            <SubagentPane
              entry={entry}
              place="beside"
              tree={tree}
              style={
                open[index]
                  ? { flexGrow: weightOf(column, entry.id) }
                  : undefined
              }
            />
          </Fragment>
        );
      })}
    </aside>
  );
}

function paneLabel(panes: readonly SubagentEntry[], index: number): string {
  const pane = panes[index];
  if (!pane) throw new Error(`no open pane ${index} in the column`);
  return pane.spawns.label;
}
