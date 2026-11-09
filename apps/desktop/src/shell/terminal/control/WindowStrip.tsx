import { useLayoutEffect, useRef, useState } from "react";
import type {
  StatusColor,
  StatusLine,
  StatusRun,
  StatusStyle,
  WindowInfo,
} from "../../../ipc/terminalControl";
import "./tabs.css";

/**
 * The session's windows as tabs, and its status-left and status-right
 * around them (`docs/terminal-mode.md`, "The window tabs"; the look is
 * `tabs.css`). Everything it says is tmux's: each tab is the person's
 * `window-status-format` expanded by tmux (`ptyHost/control/statusLine.ts`),
 * its leading `#I` a keycap; it sits where `status-position` and
 * `status-justify` put it, and is not there under `status off`. Choosing a
 * window is tmux's keys (prefix and the index, `C-n`, `C-p`); a click
 * selects one too, as it does in tmux, and a right-click opens tmux's window
 * menu. When the tabs do not fit, the inactive ones farthest from the active
 * one fold to their keycap, which keeps its alert dot.
 */

interface Props {
  readonly windows: readonly WindowInfo[];
  readonly status: StatusLine | undefined;
  /** A tmux colour in the theme's palette. */
  readonly color: (color: StatusColor) => string;
  readonly onSelect: (window: number) => void;
  readonly onMenu: (window: number, clientX: number) => void;
}

/**
 * Which tabs fold to their keycap so the row fits in `room`: the inactive
 * ones, farthest from the active one first (the later of two as far). Each
 * tab's width is given unfolded (`full`) and folded (`folded`), by its
 * place in the row. `fits` is false when even all of them folded do not.
 */
export function foldTabs(
  full: readonly number[],
  folded: readonly number[],
  active: number,
  room: number,
  gap: number,
): { readonly folded: ReadonlySet<number>; readonly fits: boolean } {
  const widths = [...full];
  const total = () =>
    widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, widths.length - 1);
  const out = new Set<number>();
  const order = widths
    .map((_, i) => i)
    .filter((i) => i !== active)
    .sort(
      (a, b) =>
        Math.abs(b - active) - Math.abs(a - active) ||
        (active < 0 ? a - b : b - a),
    );
  for (const i of order) {
    if (total() <= room) break;
    widths[i] = folded[i] ?? widths[i];
    out.add(i);
  }
  return { folded: out, fits: total() <= room };
}

function styleOf(
  style: StatusStyle,
  color: (color: StatusColor) => string,
): React.CSSProperties {
  const decoration = [
    style.underline === true ? "underline" : "",
    style.strikethrough === true ? "line-through" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    ...(style.bold === true ? { fontWeight: "var(--tabs-bold)" } : {}),
    ...(style.italic === true ? { fontStyle: "italic" } : {}),
    ...(style.dim === true ? { opacity: "var(--tabs-dim)" } : {}),
    ...(decoration === "" ? {} : { textDecoration: decoration }),
    ...(style.fg === undefined ? {} : { color: color(style.fg) }),
  } as React.CSSProperties;
}

function Runs({
  runs,
  color,
}: {
  readonly runs: readonly StatusRun[];
  readonly color: (color: StatusColor) => string;
}) {
  return (
    <>
      {runs.map((run, i) => (
        <span key={i} style={styleOf(run, color)}>
          {run.text}
        </span>
      ))}
    </>
  );
}

const plain = (runs: readonly StatusRun[]) =>
  runs.map((run) => run.text).join("");

function Tab({
  window: w,
  folded,
  ruler = false,
  color,
  onSelect,
  onMenu,
}: {
  readonly window: WindowInfo;
  readonly folded: boolean;
  readonly ruler?: boolean;
  readonly color: (color: StatusColor) => string;
  readonly onSelect?: (window: number) => void;
  readonly onMenu?: (window: number, clientX: number) => void;
}) {
  const tab = w.tab;
  const label = tab?.label ?? [{ text: w.name }];
  // tmux clears a window's alerts when it is selected.
  const alert = w.active
    ? undefined
    : tab?.bell === true
      ? "bell"
      : tab?.activity === true
        ? "activity"
        : undefined;
  const content = (
    <>
      {(tab?.key !== false || folded) && (
        <span className="control-tab-key">{w.index}</span>
      )}
      {!folded && label.length > 0 && (
        <span className="control-tab-label">
          <Runs runs={label} color={color} />
        </span>
      )}
      {!folded && w.zoomed && (
        <svg
          className="control-tab-zoom"
          viewBox="0 0 10 10"
          aria-hidden="true"
        >
          <path d="M1 3.5V1h2.5M6.5 1H9v2.5M9 6.5V9H6.5M3.5 9H1V6.5" />
        </svg>
      )}
      {alert !== undefined && (
        <span
          className="control-tab-dot"
          data-alert={alert}
          style={
            tab?.alert === undefined
              ? undefined
              : { background: color(tab.alert) }
          }
        />
      )}
    </>
  );
  const style = styleOf(tab?.style ?? {}, color);
  if (ruler)
    return (
      <span
        className="control-tab"
        data-folded={folded ? "true" : undefined}
        aria-current={w.active ? "true" : undefined}
        style={style}
      >
        {content}
      </span>
    );
  const says = [
    `${String(w.index)} ${plain(label)}`,
    w.zoomed ? "zoomed" : "",
    alert ?? "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <button
      type="button"
      className="control-tab"
      data-window={w.id}
      data-folded={folded ? "true" : undefined}
      aria-current={w.active ? "true" : undefined}
      aria-label={says}
      style={style}
      // The keys stay in the terminal.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onSelect?.(w.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu?.(w.id, event.clientX);
      }}
    >
      {content}
    </button>
  );
}

export function WindowStrip({
  windows,
  status,
  color,
  onSelect,
  onMenu,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const middleRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState<ReadonlySet<number>>(new Set());
  const [fits, setFits] = useState(true);
  const [side, setSide] = useState(0);
  // A resize renders again, and the effect below measures again.
  const [, setSize] = useState(0);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const observer = new ResizeObserver(() => setSize((n) => n + 1));
    observer.observe(root);
    if (leftRef.current !== null) observer.observe(leftRef.current);
    if (rightRef.current !== null) observer.observe(rightRef.current);
    return () => observer.disconnect();
  }, [status?.shown]);

  // Measured after every render: what the tabs say, the fonts and the room
  // all change their widths. Each state is set only when it changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const middle = middleRef.current;
    const ruler = rulerRef.current;
    const list = listRef.current;
    if (middle === null || ruler === null || list === null) return;
    // `absolute-centre`: the tabs centred on the whole line, so both sides
    // are as wide as the wider.
    const nextSide = Math.max(
      leftRef.current?.offsetWidth ?? 0,
      rightRef.current?.offsetWidth ?? 0,
    );
    if (nextSide !== side) setSide(nextSide);
    const measured = [...ruler.children].map(
      (el) => (el as HTMLElement).offsetWidth,
    );
    const full = measured.filter((_, i) => i % 2 === 0);
    const small = measured.filter((_, i) => i % 2 === 1);
    const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
    const active = windows.findIndex((w) => w.active);
    const next = foldTabs(full, small, active, middle.clientWidth, gap);
    const ids = new Set([...next.folded].map((i) => windows[i].id));
    if (ids.size !== folded.size || [...ids].some((id) => !folded.has(id)))
      setFolded(ids);
    if (next.fits !== fits) setFits(next.fits);
    // Too many even folded: the active one is kept in view.
    if (!next.fits) {
      const tab = list.querySelector<HTMLElement>('[aria-current="true"]');
      if (tab !== null)
        list.scrollLeft =
          tab.offsetLeft - (list.clientWidth - tab.offsetWidth) / 2;
    } else list.scrollLeft = 0;
  });

  if (status?.shown === false || windows.length === 0) return null;
  return (
    <div
      ref={rootRef}
      className="control-tabs"
      data-position={status?.position ?? "bottom"}
      data-justify={status?.justify ?? "left"}
      style={{ "--tabs-side": `${String(side)}px` } as React.CSSProperties}
    >
      <div ref={leftRef} className="control-tabs-left">
        <Runs runs={status?.left ?? []} color={color} />
      </div>
      <div ref={middleRef} className="control-tabs-middle">
        <nav
          ref={listRef}
          className="control-tabs-list"
          aria-label="tmux windows"
          data-overflow={fits ? undefined : "true"}
        >
          {windows.map((w) => (
            <Tab
              key={w.id}
              window={w}
              folded={!w.active && folded.has(w.id)}
              color={color}
              onSelect={onSelect}
              onMenu={onMenu}
            />
          ))}
        </nav>
      </div>
      <div ref={rightRef} className="control-tabs-right">
        <Runs runs={status?.right ?? []} color={color} />
      </div>
      <div
        ref={rulerRef}
        className="control-tabs-list control-tabs-ruler"
        aria-hidden="true"
      >
        {windows.flatMap((w) => [
          <Tab
            key={`${String(w.id)}-full`}
            window={w}
            folded={false}
            ruler
            color={color}
          />,
          <Tab
            key={`${String(w.id)}-folded`}
            window={w}
            folded
            ruler
            color={color}
          />,
        ])}
      </div>
    </div>
  );
}
