/**
 * Draws a declarative component tree (`components.ts`): DevHub's type, laid
 * out by the browser, in the colours of the highlight groups each node names.
 *
 * A node with an `action` is clickable; the click goes to `onAction`, which
 * sends it to Neovim, where its Lua function runs. Nothing else here acts.
 */

import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "./DecorationViews";
import {
  barRects,
  linePoints,
  rgbCss,
  type ComponentNode,
  type HlAttrs,
  type HlTable,
  type Run,
  type Size,
  type StackNode,
} from "./components";
import { formatKeys } from "../../model/keyNotation";
import { formatPosition, modeLabel } from "./statusline";

export interface ComponentTheme {
  readonly hl: HlTable;
  /** The ground the tree is drawn on, and its text. */
  readonly fg: number;
  readonly bg: number;
  readonly dark: boolean;
  /** The grid's font family, for `mono` text and Nerd Font icons. */
  readonly mono: string;
  readonly openLink: (url: string) => void;
  readonly onAction: (action: number) => void;
  /**
   * What the slots show (`SlotNode`), from Neovim's redraw: a footer's
   * window's cursor, the mode, the pending command. None: blank.
   */
  readonly slots?: Slots | undefined;
}

export interface Slots {
  readonly position?:
    | {
        readonly curline: number;
        readonly curcol: number;
        readonly lineCount: number;
      }
    | undefined;
  readonly mode?: string | undefined;
  readonly showcmd?: string | undefined;
}

const Theme = createContext<ComponentTheme | undefined>(undefined);

export function ComponentTree({
  node,
  theme,
}: {
  readonly node: ComponentNode;
  readonly theme: ComponentTheme;
}) {
  return (
    <Theme.Provider value={theme}>
      <Node node={node} />
    </Theme.Provider>
  );
}

function useTheme(): ComponentTheme {
  const theme = useContext(Theme);
  if (!theme) throw new Error("a component outside a ComponentTree");
  return theme;
}

/** A group's foreground, as CSS (or `undefined` when it has none). */
export function fgOf(
  hl: HlTable,
  name: string | undefined,
): string | undefined {
  const attrs = name !== undefined ? hl.get(name) : undefined;
  const rgb = attrs?.reverse === true ? attrs.bg : attrs?.fg;
  return rgb !== undefined ? rgbCss(rgb) : undefined;
}

function bgOf(hl: HlTable, name: string | undefined): string | undefined {
  const attrs = name !== undefined ? hl.get(name) : undefined;
  const rgb = attrs?.reverse === true ? attrs.fg : attrs?.bg;
  return rgb !== undefined ? rgbCss(rgb) : undefined;
}

function runStyle(attrs: HlAttrs | undefined, ink = false): CSSProperties {
  if (!attrs) return {};
  const fg = attrs.reverse === true ? attrs.bg : attrs.fg;
  if (ink) return fg !== undefined ? { color: rgbCss(fg) } : {};
  return {
    ...(fg !== undefined ? { color: rgbCss(fg) } : {}),
    ...(attrs.bold === true ? { fontWeight: 600 } : {}),
    ...(attrs.italic === true ? { fontStyle: "italic" } : {}),
    ...(attrs.strikethrough === true
      ? { textDecoration: "line-through" }
      : attrs.underline === true
        ? { textDecoration: "underline" }
        : {}),
  };
}

/**
 * A mark over code (a signature's active parameter) in its group's
 * colours, its ground a rounded chip; a group with neither a ground nor a
 * weight of its own is drawn bold and underlined, so the mark still shows.
 */
function markStyle(hl: HlTable, name: string): CSSProperties {
  const attrs = hl.get(name);
  const style = runStyle(attrs);
  const bg = bgOf(hl, name);
  if (bg !== undefined) {
    return { ...style, background: bg, borderRadius: 3 };
  }
  if (attrs?.bold === true || attrs?.underline === true) return style;
  return { ...style, fontWeight: 700, textDecoration: "underline" };
}

/** The colour of a checked box, a bar, a line, unless a node names one. */
const ACCENT = "DiagnosticInfo";

const FONT_SIZE: Record<Size, number> = { xs: 10.5, sm: 11.5, md: 13, lg: 15 };

function clickable(
  action: number | undefined,
  onAction: (action: number) => void,
): Record<string, unknown> {
  if (action === undefined) return {};
  return {
    "data-action": action,
    role: "button",
    onMouseDown: (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onAction(action);
    },
  };
}

/**
 * A `markdown` node. Its renderers are made once per look (and per marks),
 * not at each render: react-markdown takes each renderer as a component
 * type, so a new one would mount its code blocks anew at every redraw of
 * the Neovim — a popup's code drawn plain again before it is coloured.
 */
function MarkdownView({
  node,
  grow,
  extra,
}: {
  readonly node: Extract<ComponentNode, { type: "markdown" }>;
  readonly grow: CSSProperties;
  readonly extra: Record<string, unknown>;
}): ReactNode {
  const theme = useTheme();
  const { dark, openLink } = theme;
  // The groups are needed only to draw marks; the code that marks name
  // (`source`) only then too.
  const marked = node.marks ? theme.hl : undefined;
  const source = node.marks ? node.text : undefined;
  const components = useMemo(
    () =>
      markdownComponents(
        dark,
        openLink,
        node.marks && marked && source !== undefined
          ? {
              source,
              marks: node.marks,
              style: (name) => markStyle(marked, name),
            }
          : undefined,
      ),
    [dark, openLink, marked, source, node.marks],
  );
  return (
    <div
      className="nvc-markdown"
      style={{
        ...grow,
        ...(node.size ? { fontSize: FONT_SIZE[node.size] } : {}),
      }}
      {...extra}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={components}
      >
        {node.text}
      </ReactMarkdown>
    </div>
  );
}

function Node({ node }: { readonly node: ComponentNode }): ReactNode {
  const theme = useTheme();
  const { hl } = theme;
  const extra = {
    ...clickable(node.action, theme.onAction),
    // the node a popup lines up with its anchor's column (`popupAnchorX`)
    ...(node.anchor === true ? { "data-anchor": "" } : {}),
  };
  const grow: CSSProperties =
    node.grow === true ? { flex: "1 1 0", minWidth: 0 } : {};
  const title = node.tip !== undefined ? { title: node.tip } : {};
  switch (node.type) {
    case "stack":
    case "hstack": {
      const accent = fgOf(hl, node.accent);
      const ground =
        bgOf(hl, node.bg) ??
        (node.bg !== undefined ? tint(fgOf(hl, node.bg), 10) : undefined);
      const style: CSSProperties = {
        ...grow,
        ...(node.gap !== undefined ? { gap: node.gap } : {}),
        ...(node.pad
          ? { padding: `${String(node.pad[0])}px ${String(node.pad[1])}px` }
          : {}),
        ...(node.align ? { alignItems: ALIGN[node.align] } : {}),
        ...(node.justify ? { justifyContent: JUSTIFY[node.justify] } : {}),
        ...(node.indent !== undefined ? { marginLeft: node.indent } : {}),
        // The accent rings the stack in its colour (`.nvc-accent`): never a
        // stripe down one side of a rounded box.
        ...(accent ? ({ "--nvc-accent": accent } as CSSProperties) : {}),
        ...(ground ? { background: ground } : {}),
        ...(node.round === true ? { borderRadius: 4 } : {}),
      };
      const className = [
        node.type === "stack" ? "nvc-stack" : "nvc-hstack",
        node.wrap === true ? "nvc-wrap" : "",
        node.card === true ? "nvc-card" : "",
        accent ? "nvc-accent" : "",
        node.action !== undefined ? "nvc-clickable" : "",
      ]
        .filter(Boolean)
        .join(" ");
      if (
        node.type === "stack" &&
        (node.band !== undefined || node.pane !== undefined)
      )
        return (
          <Column
            node={node}
            className={className}
            style={style}
            band={bgOf(hl, node.band)}
            attrs={{ ...title, ...extra }}
          />
        );
      return (
        <div className={className} style={style} {...title} {...extra}>
          {node.children.map((child, index) => (
            <Node key={index} node={child} />
          ))}
        </div>
      );
    }
    case "text": {
      const style: CSSProperties = {
        ...grow,
        ...runStyle(
          node.hl !== undefined ? hl.get(node.hl) : undefined,
          node.ink === true,
        ),
        ...(node.size ? { fontSize: FONT_SIZE[node.size] } : {}),
        ...(node.bold === true ? { fontWeight: 600 } : {}),
      };
      const className = [
        "nvc-text",
        node.wrap === true ? "nvc-text-wrap" : "",
        node.dim === true ? "nvc-dim" : "",
        node.upper === true ? "nvc-upper" : "",
        node.mono === true ? "nvc-mono" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return (
        <span className={className} style={style} {...title} {...extra}>
          {node.runs.map((r, index) => (
            <RunView key={index} run={r} />
          ))}
        </span>
      );
    }
    case "markdown":
      return <MarkdownView node={node} grow={grow} extra={extra} />;
    case "badge": {
      const color = fgOf(hl, node.hl) ?? rgbCss(theme.fg);
      const ground = bgOf(hl, node.hl);
      return (
        <span
          className={`nvc-badge${node.pill === true ? " nvc-pill" : ""}${node.mono === true ? " nvc-mono" : ""}${node.size === "sm" || node.size === "xs" ? ` nvc-badge-${node.size}` : ""}`}
          style={{
            ...grow,
            color,
            background: ground ?? tint(color, 18),
          }}
          {...title}
          {...extra}
        >
          {node.text}
        </span>
      );
    }
    case "kbd":
      return (
        <kbd className="nvc-kbd" {...extra}>
          {formatKeys(node.text)}
        </kbd>
      );
    case "button": {
      const color = fgOf(hl, node.hl);
      return (
        <span
          className="nvc-button nvc-clickable"
          style={{
            ...grow,
            ...(color
              ? {
                  color,
                  background: tint(color, 14),
                  borderColor: tint(color, 35),
                }
              : {}),
          }}
          {...title}
          {...extra}
        >
          {node.icon !== undefined ? (
            <span className="nvc-icon">{node.icon}</span>
          ) : null}
          {node.text}
          {node.key !== undefined ? (
            <kbd className="nvc-kbd">{formatKeys(node.key)}</kbd>
          ) : null}
        </span>
      );
    }
    case "checkbox": {
      const accent = fgOf(hl, node.hl ?? ACCENT) ?? rgbCss(theme.fg);
      const on = node.state !== false;
      return (
        <span className="nvc-checkbox-row" style={grow} {...title} {...extra}>
          <span
            className={`nvc-checkbox${on ? " nvc-checkbox-on" : ""}`}
            role="checkbox"
            aria-checked={node.state === "mixed" ? "mixed" : node.state}
            style={
              on
                ? {
                    background: node.state === true ? accent : "transparent",
                    borderColor: accent,
                    color: accent,
                  }
                : {}
            }
          >
            {node.state === true ? (
              <svg viewBox="0 0 12 12" aria-hidden>
                <path d="M2.5 6.2 5 8.6 9.6 3.6" />
              </svg>
            ) : node.state === "mixed" ? (
              <svg viewBox="0 0 12 12" aria-hidden>
                <path d="M3 6h6" />
              </svg>
            ) : null}
          </span>
          {node.label !== undefined ? (
            <span className="nvc-text">{node.label}</span>
          ) : null}
        </span>
      );
    }
    case "progress": {
      const color = fgOf(hl, node.hl ?? ACCENT) ?? rgbCss(theme.fg);
      return (
        <span className="nvc-progress-row" style={grow} {...title} {...extra}>
          <span
            className="nvc-progress"
            role="progressbar"
            aria-valuenow={Math.round(node.value * 100)}
            style={
              node.width !== undefined
                ? { width: node.width, flex: "none" }
                : {}
            }
          >
            <span
              style={{
                width: `${String(node.value * 100)}%`,
                background: color,
              }}
            />
          </span>
          {node.label !== undefined ? (
            <span className="nvc-text nvc-dim">{node.label}</span>
          ) : null}
        </span>
      );
    }
    case "icon":
      return (
        <span
          className="nvc-icon"
          style={{
            ...(fgOf(hl, node.hl) ? { color: fgOf(hl, node.hl) } : {}),
            ...(node.size ? { fontSize: FONT_SIZE[node.size] } : {}),
          }}
          {...title}
          {...extra}
        >
          {node.glyph}
        </span>
      );
    case "avatar": {
      const color = fgOf(hl, node.hl) ?? rgbCss(theme.fg);
      const size = node.size ?? 22;
      return (
        <span
          className="nvc-avatar"
          style={{
            width: size,
            height: size,
            fontSize: Math.round(size * 0.48),
            background: color,
            color: rgbCss(theme.bg),
          }}
          {...title}
          {...extra}
        >
          {node.text}
        </span>
      );
    }
    case "spacer":
      return (
        <span
          className="nvc-spacer"
          style={
            node.size !== undefined
              ? { flex: "none", width: node.size, height: node.size }
              : { flex: "1 1 0" }
          }
        />
      );
    case "divider":
      return (
        <span
          className={node.vertical === true ? "nvc-divider-v" : "nvc-divider"}
        />
      );
    case "sparkline": {
      const width = node.width ?? 64;
      const height = node.height ?? 16;
      const color = fgOf(hl, node.hl ?? ACCENT) ?? rgbCss(theme.fg);
      return (
        <svg
          className="nvc-chart"
          width={width}
          height={height}
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          {...extra}
        >
          {node.kind === "bar" ? (
            barRects(node.values, width, height).map((b, i) => (
              <rect
                key={i}
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                rx={0.5}
                fill={color}
              />
            ))
          ) : (
            <polyline
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={linePoints(node.values, width, height)
                .map((p) => p.join(","))
                .join(" ")}
            />
          )}
        </svg>
      );
    }
    case "chart": {
      const width = node.width ?? 240;
      const height = node.height ?? 64;
      const all = node.series.flatMap((s) => s.values);
      const range =
        all.length > 0
          ? { min: Math.min(...all), max: Math.max(...all) }
          : undefined;
      const muted = fgOf(hl, "Comment") ?? rgbCss(theme.fg, 0.4);
      return (
        <span className="nvc-chart-box" {...extra}>
          <svg
            className="nvc-chart"
            width={width}
            height={height}
            viewBox={`0 0 ${String(width)} ${String(height)}`}
          >
            <line
              x1={0}
              y1={height - 0.5}
              x2={width}
              y2={height - 0.5}
              stroke={muted}
              strokeWidth={1}
              opacity={0.5}
            />
            {node.series.map((s, i) => (
              <polyline
                key={i}
                fill="none"
                stroke={fgOf(hl, s.hl ?? ACCENT) ?? rgbCss(theme.fg)}
                strokeWidth={1.5}
                strokeLinejoin="round"
                points={linePoints(s.values, width, height, range)
                  .map((p) => p.join(","))
                  .join(" ")}
              />
            ))}
          </svg>
          {node.series.some((s) => s.label !== undefined) ? (
            <span className="nvc-chart-legend">
              {node.series.map((s, i) =>
                s.label !== undefined ? (
                  <span key={i}>
                    <i
                      style={{
                        background:
                          fgOf(hl, s.hl ?? ACCENT) ?? rgbCss(theme.fg),
                      }}
                    />
                    {s.label}
                  </span>
                ) : null,
              )}
            </span>
          ) : null}
        </span>
      );
    }
    case "line":
      return (
        <span
          className="nvc-line"
          style={{
            ...(node.grow === true ? { flex: "1 1 0" } : {}),
            ...({
              "--nvc-line":
                fgOf(hl, node.hl) ?? fgOf(hl, "WinSeparator") ?? "currentColor",
            } as CSSProperties),
          }}
          {...title}
          {...extra}
        />
      );
    case "slot": {
      const slots = theme.slots;
      const value =
        node.slot === "position"
          ? slots?.position
            ? formatPosition(node.format, slots.position)
            : ""
          : node.slot === "mode"
            ? slots?.mode !== undefined
              ? modeLabel(slots.mode)
              : ""
            : (slots?.showcmd ?? "");
      return (
        <span
          className={`nvc-text nvc-slot nvc-slot-${node.slot}`}
          style={{
            ...grow,
            ...runStyle(
              node.hl !== undefined ? hl.get(node.hl) : undefined,
              node.ink === true,
            ),
          }}
          {...title}
          {...extra}
        >
          {value}
        </span>
      );
    }
    case "image":
      return (
        <img
          className="nvc-image"
          src={node.src}
          alt=""
          draggable={false}
          style={{
            ...(node.width !== undefined ? { width: node.width } : {}),
            ...(node.height !== undefined ? { height: node.height } : {}),
          }}
          {...extra}
        />
      );
  }
}

/**
 * A column that is a list (`band`: one band behind the selected child,
 * moved to the next selection by transform only — placed at once when it
 * appears, gliding from one row to the next after) or a pane (`pane`: it
 * scrolls inside past `maxHeight`, back to the top when its content
 * changes; its popup's `scroll(by, pane)` finds it by `data-pane`).
 */
function Column({
  node,
  className,
  style,
  band,
  attrs,
}: {
  readonly node: StackNode;
  readonly className: string;
  readonly style: CSSProperties;
  readonly band: string | undefined;
  readonly attrs: Record<string, unknown>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const hidden = useRef(true);
  const banded = node.band !== undefined;
  const selected = node.selected ?? 0;
  useLayoutEffect(() => {
    const el = box.current;
    const b = bandRef.current;
    if (!el || !b) return;
    // the band is the first child; the selected one is after it
    const row = selected > 0 ? el.children[selected] : undefined;
    if (!(row instanceof HTMLElement)) {
      b.style.opacity = "0";
      hidden.current = true;
      return;
    }
    const place = `translateY(${String(row.offsetTop)}px)`;
    b.style.height = `${String(row.offsetHeight)}px`;
    if (hidden.current) {
      // appears in place: no glide from where it last was
      b.classList.remove("nvc-band-live");
      b.style.transform = place;
      void b.offsetWidth;
      b.classList.add("nvc-band-live");
      b.style.opacity = "1";
      hidden.current = false;
    } else {
      b.style.transform = place;
    }
  });
  // A pane's content changed (another item's documentation): from its top.
  const content = useMemo(
    () => (node.pane !== undefined ? JSON.stringify(node.children) : ""),
    [node.pane, node.children],
  );
  useLayoutEffect(() => {
    if (box.current && node.pane !== undefined) box.current.scrollTop = 0;
  }, [content, node.pane]);
  return (
    <div
      ref={box}
      className={`${className}${banded ? " nvc-banded" : ""}${node.pane !== undefined ? " nvc-pane" : ""}`}
      style={{
        ...style,
        // A popup short of room takes it from its pane first
        // (`--nvim-pane-cut`, `LayerViews.tsx`), down to three lines.
        ...(node.maxHeight !== undefined
          ? {
              maxHeight: `max(min(${String(node.maxHeight)}px, 3lh), calc(${String(node.maxHeight)}px - var(--nvim-pane-cut, 0px)))`,
            }
          : {}),
      }}
      {...(node.pane !== undefined
        ? {
            "data-pane": node.pane,
            "data-pane-max": node.maxHeight ?? "",
          }
        : {})}
      {...attrs}
    >
      {banded ? (
        <div
          ref={bandRef}
          className="nvc-band"
          style={band !== undefined ? { background: band } : {}}
          aria-hidden
        />
      ) : null}
      {node.children.map((child, index) => (
        <Node key={index} node={child} />
      ))}
    </div>
  );
}

function RunView({ run }: { readonly run: Run }) {
  const theme = useTheme();
  const style: CSSProperties = {
    ...runStyle(run.hl !== undefined ? theme.hl.get(run.hl) : undefined),
    ...(run.bold === true ? { fontWeight: 600 } : {}),
    ...(run.italic === true ? { fontStyle: "italic" } : {}),
    ...(run.strike === true ? { textDecoration: "line-through" } : {}),
    ...(run.underline === true ? { textDecoration: "underline" } : {}),
  };
  const plain = Object.keys(style).length === 0 && run.dim !== true;
  if (plain) return <>{run.text}</>;
  const className = [
    run.dim === true ? "nvc-dim" : "",
    run.mono === true ? "nvc-mono" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={className || undefined} style={style}>
      {run.text}
    </span>
  );
}

const ALIGN = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  baseline: "baseline",
  stretch: "stretch",
} as const;

const JUSTIFY = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
} as const;

/** A colour at `percent` over nothing: a tint of it on any ground. */
function tint(color: string | undefined, percent: number): string | undefined {
  return color === undefined
    ? undefined
    : `color-mix(in srgb, ${color} ${String(percent)}%, transparent)`;
}
