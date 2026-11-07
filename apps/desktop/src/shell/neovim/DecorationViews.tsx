/**
 * The page's side of `decorations.ts`: toasts, inline images and rich
 * floats, each drawn over the Neovim window it belongs to.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  grammarFor,
  highlight,
  type Colouring,
} from "../conversation/highlight";
import { cssColor, resolveColors } from "./painter";
import type { GridBox, NeovimUiState } from "./redraw";
import {
  richScrollFraction,
  toastGroups,
  type Decorations,
  type Toast,
} from "./decorations";

interface Cell {
  readonly width: number;
  readonly height: number;
}

/**
 * Notifications, fidget-like: compact lines at the bottom right, above the
 * status line, under the name of their source; each fades when its time is
 * up. Work in progress spins, shows its percentage, and ticks when done.
 */
export function Toasts({
  toasts,
  dismiss,
  bottom = 12,
}: {
  readonly toasts: readonly Toast[];
  readonly dismiss: (key: number) => void;
  /** Pixels from the editor's bottom: above Neovim's status line. */
  readonly bottom?: number;
}) {
  return (
    <div className="nvim-toasts" aria-live="polite" style={{ bottom }}>
      {toastGroups(toasts).map(({ group, toasts: list }) => (
        <div key={group} className="nvim-toast-group">
          {group !== "" ? (
            <div className="nvim-toast-source">
              {list.some((t) => t.progress && !t.progress.done) ? (
                <span className="nvim-toast-spinner" aria-hidden />
              ) : null}
              {group}
            </div>
          ) : null}
          {list.map((toast) => (
            <ToastView
              key={`${String(toast.key)}:${String(toast.rev)}`}
              toast={toast}
              dismiss={dismiss}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

const LEVEL_ICON: Record<Toast["level"], string> = {
  debug: "·",
  info: "i",
  warn: "!",
  error: "×",
};

/** How long a notification takes to fade, at the end of its time. */
const FADE_MS = 500;

function ToastView({
  toast,
  dismiss,
}: {
  readonly toast: Toast;
  readonly dismiss: (key: number) => void;
}) {
  useEffect(() => {
    if (toast.timeout <= 0) return undefined;
    const timer = window.setTimeout(() => {
      dismiss(toast.key);
    }, toast.timeout);
    return () => {
      window.clearTimeout(timer);
    };
  }, [toast, dismiss]);
  const progress = toast.progress;
  const icon = progress ? (
    progress.done ? (
      <span className="nvim-toast-done">✓</span>
    ) : (
      <span className="nvim-toast-spinner" />
    )
  ) : (
    <span className="nvim-toast-icon">{LEVEL_ICON[toast.level]}</span>
  );
  return (
    <div
      className={`nvim-toast nvim-toast-${toast.level}${toast.rev > 1 ? " nvim-toast-updated" : ""}`}
      role={toast.level === "error" ? "alert" : "status"}
      style={
        toast.timeout > 0
          ? {
              animationDelay: `0ms, ${String(Math.max(0, toast.timeout - FADE_MS))}ms`,
            }
          : {
              animation:
                toast.rev > 1 ? "none" : "nvim-toast-in 160ms ease-out",
            }
      }
      onMouseDown={(event) => {
        event.preventDefault();
        dismiss(toast.key);
      }}
    >
      <span className="nvim-toast-msg">{toast.msg || toast.title}</span>
      {toast.msg !== "" && toast.title !== "" ? (
        <span className="nvim-toast-title">{toast.title}</span>
      ) : null}
      {progress?.percent !== undefined && !progress.done ? (
        <span className="nvim-toast-percent">
          {Math.round(progress.percent)}%
        </span>
      ) : null}
      <span className="nvim-toast-mark" aria-hidden>
        {icon}
      </span>
    </div>
  );
}

/** Each image in the rows its extmark reserves, in every window showing it. */
export function InlineImages({
  decorations,
  boxes,
  cell,
}: {
  readonly decorations: Decorations;
  readonly boxes: readonly GridBox[];
  readonly cell: Cell;
}) {
  return (
    <>
      {decorations.placedImages.map((place) => {
        const src = decorations.images.get(place.id);
        const box = boxes.find((b) => b.win === place.win);
        if (src === undefined || !box) return null;
        return (
          <div
            key={`${String(place.id)}:${String(place.win)}`}
            className="nvim-inline-image"
            style={{
              left: (box.col + place.col) * cell.width,
              top: (box.row + place.row) * cell.height,
              width: place.width * cell.width,
              height: place.rows * cell.height,
              zIndex: box.z + 1,
            }}
          >
            <img
              src={src}
              alt=""
              draggable={false}
              style={{ height: place.full * cell.height }}
            />
          </div>
        );
      })}
    </>
  );
}

/**
 * A float's markdown drawn natively over its text area. Neovim keeps the
 * window: its keys scroll it (the content follows its topline) and close it
 * (the content goes with it). A failure to draw leaves Neovim's grid.
 */
export function RichFloats({
  decorations,
  boxes,
  cell,
  state,
  openLink,
  refocus,
}: {
  readonly decorations: Decorations;
  readonly boxes: readonly GridBox[];
  readonly cell: Cell;
  readonly state: NeovimUiState;
  readonly openLink: (url: string) => void;
  readonly refocus: () => void;
}) {
  return (
    <>
      {decorations.placedRich.map((place) => {
        const markdown = decorations.rich.get(place.id);
        const box = boxes.find((b) => b.win === place.win);
        if (markdown === undefined || !box) return null;
        const inset = place.border ? 1 : 0;
        const width = box.width - 2 * inset;
        const height = box.height - 2 * inset;
        if (width <= 0 || height <= 0) return null;
        const grid = state.grids.get(box.grid);
        const hl = grid
          ? grid.hls[inset * grid.width + Math.max(0, grid.width - 1 - inset)]
          : 0;
        const colors = resolveColors(
          hl ? state.hl.get(hl) : undefined,
          state.defaults,
        );
        return (
          <RichFloat
            key={place.id}
            markdown={markdown}
            fraction={richScrollFraction(place)}
            dark={luminance(colors.bg) < 0.5}
            style={{
              left: (box.col + inset) * cell.width,
              top: (box.row + inset) * cell.height,
              width: width * cell.width,
              height: height * cell.height,
              zIndex: box.z + 1,
              background: cssColor(colors.bg),
              color: cssColor(colors.fg),
              ["--nvim-line" as string]: `${String(cell.height)}px`,
            }}
            openLink={openLink}
            refocus={refocus}
          />
        );
      })}
    </>
  );
}

function luminance(rgb: number): number {
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function RichFloat({
  markdown,
  fraction,
  dark,
  style,
  openLink,
  refocus,
}: {
  readonly markdown: string;
  readonly fraction: number;
  readonly dark: boolean;
  readonly style: React.CSSProperties;
  readonly openLink: (url: string) => void;
  readonly refocus: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = fraction * Math.max(0, el.scrollHeight - el.clientHeight);
  }, [fraction, markdown]);
  const components = markdownComponents(dark, openLink);
  return (
    <div
      ref={ref}
      className={`nvim-rich-float ${dark ? "nvim-rich-dark" : "nvim-rich-light"}`}
      style={style}
      onMouseUp={() => {
        // A plain click gives the keyboard back to Neovim; a selection stays
        // (to be copied).
        if (window.getSelection()?.isCollapsed !== false) refocus();
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={components}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

/**
 * How a markdown body is drawn in the editor (a rich float, a component's
 * `markdown`): links open in the browser, fenced code is coloured.
 */
export function markdownComponents(
  dark: boolean,
  openLink: (url: string) => void,
): Components {
  return {
    a: ({ href, children }) => (
      <a
        href={href}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (href && /^https?:\/\//.test(href)) openLink(href);
        }}
        onClick={(event) => {
          event.preventDefault();
        }}
      >
        {children}
      </a>
    ),
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }) => {
      const text = String(children ?? "");
      const language = /language-([\w+-]+)/.exec(className ?? "")?.[1];
      const block = language !== undefined || text.includes("\n");
      if (!block) return <code>{children}</code>;
      return (
        <HighlightedCode
          code={text.replace(/\n$/, "")}
          language={language}
          dark={dark}
        />
      );
    },
  };
}

export function HighlightedCode({
  code,
  language,
  dark,
}: {
  readonly code: string;
  readonly language: string | undefined;
  readonly dark: boolean;
}) {
  const grammar = grammarFor(language);
  const [colouring, setColouring] = useState<Colouring | undefined>();
  useEffect(() => {
    if (grammar === undefined) return undefined;
    let live = true;
    highlight(code, grammar).then(
      (result) => {
        if (live) setColouring(result);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [code, grammar]);
  let body: ReactNode = code;
  if (colouring) {
    body = colouring.map((line, index) => (
      <span key={index}>
        {line.map((token, t) => {
          const colour = dark ? token.dark : token.light;
          return (
            <span key={t} style={colour ? { color: colour } : undefined}>
              {token.text}
            </span>
          );
        })}
        {index < colouring.length - 1 ? "\n" : null}
      </span>
    ));
  }
  return (
    <pre className="nvim-rich-code">
      <code>{body}</code>
    </pre>
  );
}
