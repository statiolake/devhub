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
  type Decorations,
  type Toast,
} from "./decorations";

interface Cell {
  readonly width: number;
  readonly height: number;
}

export function Toasts({
  toasts,
  dismiss,
}: {
  readonly toasts: readonly Toast[];
  readonly dismiss: (key: number) => void;
}) {
  return (
    <div className="nvim-toasts" aria-live="polite">
      {toasts.map((toast) => (
        <ToastView key={toast.key} toast={toast} dismiss={dismiss} />
      ))}
    </div>
  );
}

const LEVEL_ICON: Record<Toast["level"], string> = {
  debug: "•",
  info: "i",
  warn: "!",
  error: "×",
};

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
  return (
    <div
      className={`nvim-toast nvim-toast-${toast.level}`}
      role={toast.level === "error" ? "alert" : "status"}
      onMouseDown={(event) => {
        event.preventDefault();
        dismiss(toast.key);
      }}
    >
      <span className="nvim-toast-icon" aria-hidden>
        {LEVEL_ICON[toast.level]}
      </span>
      <div className="nvim-toast-body">
        {toast.title ? (
          <div className="nvim-toast-title">{toast.title}</div>
        ) : null}
        <div className="nvim-toast-msg">{toast.msg}</div>
      </div>
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
}: {
  readonly decorations: Decorations;
  readonly boxes: readonly GridBox[];
  readonly cell: Cell;
  readonly state: NeovimUiState;
  readonly openLink: (url: string) => void;
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
}: {
  readonly markdown: string;
  readonly fraction: number;
  readonly dark: boolean;
  readonly style: React.CSSProperties;
  readonly openLink: (url: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = fraction * Math.max(0, el.scrollHeight - el.clientHeight);
  }, [fraction, markdown]);
  const components: Components = {
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
  return (
    <div
      ref={ref}
      className={`nvim-rich-float ${dark ? "nvim-rich-dark" : "nvim-rich-light"}`}
      style={style}
      onMouseDown={(event) => {
        // The float stays Neovim's: a click is not a drag into the grid.
        event.stopPropagation();
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

function HighlightedCode({
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
