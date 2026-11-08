/**
 * The page's side of `decorations.ts`: toasts and inline images, each drawn
 * over the Neovim window it belongs to; and how markdown is drawn in the
 * editor (components' `markdown`, popups).
 */

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import {
  grammarFor,
  highlight,
  type Colouring,
} from "../conversation/highlight";
import type { Surface } from "./chrome";
import { markPieces, type MdMark } from "./components";
import type { GridBox } from "./redraw";
import { toastGroups, type Decorations, type Toast } from "./decorations";

interface Cell {
  readonly width: number;
  readonly height: number;
}

/**
 * Notifications: compact lines at the bottom right, above the status line,
 * under the name of their source; each source a small card in the floats'
 * colours (`surface`, as `gui.popup` wears them), so it reads over any
 * text. The cards of a stack share one width (the widest's, within
 * bounds) and one right edge, as VS Code's and Zed's notifications do; a
 * line leads with its mark (the level, a spinner, a tick) and its text
 * starts after it. A line whose time is up fades and folds away; a card
 * whose every line is leaving fades as one. Work in progress spins (on its
 * line only), shows its percentage, and ticks when done.
 */
export function Toasts({
  toasts,
  dismiss,
  bottom = 12,
  surface,
}: {
  readonly toasts: readonly Toast[];
  readonly dismiss: (key: number) => void;
  /** Pixels from the editor's bottom: above Neovim's status line. */
  readonly bottom?: number;
  /** The colorscheme's floats' colours; DevHub's own until known. */
  readonly surface?: Surface | undefined;
}) {
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const leave = useCallback((id: string) => {
    setLeaving((before) => new Set(before).add(id));
  }, []);
  const live = new Set(toasts.map(toastId));
  if ([...leaving].some((id) => !live.has(id))) {
    // Forget lines that are gone (a render-time prune, no effect needed).
    setLeaving(new Set([...leaving].filter((id) => live.has(id))));
  }
  return (
    <div
      className="nvim-toasts"
      aria-live="polite"
      style={{ bottom, ...surfaceStyle(surface) }}
    >
      {toastGroups(toasts).map(({ group, toasts: list }) => (
        <div
          key={group}
          className={`nvim-toast-group${list.every((t) => leaving.has(toastId(t))) ? " nvim-toast-group-leaving" : ""}`}
        >
          {group !== "" ? (
            <div className="nvim-toast-source">{group}</div>
          ) : null}
          {list.map((toast) => (
            <ToastView
              key={toastId(toast)}
              toast={toast}
              leaving={leaving.has(toastId(toast))}
              leave={leave}
              dismiss={dismiss}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A notification as it is now: an update is a new line, its time anew. */
function toastId(toast: Toast): string {
  return `${String(toast.key)}:${String(toast.rev)}`;
}

/** The surface's colours as the stack's custom properties. */
function surfaceStyle(surface: Surface | undefined): Record<string, string> {
  if (!surface) return {};
  const css = (v: number | undefined) =>
    v === undefined
      ? undefined
      : `#${v.toString(16).padStart(6, "0").slice(-6)}`;
  const out: Record<string, string> = {};
  const set = (name: string, v: number | undefined) => {
    const c = css(v);
    if (c !== undefined) out[name] = c;
  };
  set("--nvim-toast-bg", surface.bg);
  set("--nvim-toast-fg", surface.fg);
  set("--nvim-toast-muted", surface.muted);
  set("--nvim-toast-info", surface.info);
  set("--nvim-toast-warn", surface.warn);
  set("--nvim-toast-error", surface.error);
  set("--nvim-toast-ok", surface.ok);
  return out;
}

const LEVEL_ICON: Record<Toast["level"], string> = {
  debug: "·",
  info: "i",
  warn: "!",
  error: "×",
};

/** How long a notification takes to fade, at the end of its time. */
const FADE_MS = 400;

function ToastView({
  toast,
  leaving,
  leave,
  dismiss,
}: {
  readonly toast: Toast;
  readonly leaving: boolean;
  readonly leave: (id: string) => void;
  readonly dismiss: (key: number) => void;
}) {
  useEffect(() => {
    if (toast.timeout <= 0) return undefined;
    const fade = window.setTimeout(
      () => {
        leave(toastId(toast));
      },
      Math.max(0, toast.timeout - FADE_MS),
    );
    const gone = window.setTimeout(() => {
      dismiss(toast.key);
    }, toast.timeout);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(gone);
    };
  }, [toast, leave, dismiss]);
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
      className={`nvim-toast nvim-toast-${toast.level}${toast.rev > 1 ? " nvim-toast-updated" : ""}${leaving ? " nvim-toast-leaving" : ""}`}
      role={toast.level === "error" ? "alert" : "status"}
      onMouseDown={(event) => {
        event.preventDefault();
        dismiss(toast.key);
      }}
    >
      <div className="nvim-toast-line">
        <span className="nvim-toast-mark" aria-hidden>
          {icon}
        </span>
        <span className="nvim-toast-msg">{toast.msg || toast.title}</span>
        {toast.msg !== "" &&
        toast.title !== "" &&
        toast.title !== toast.group ? (
          <span className="nvim-toast-title">{toast.title}</span>
        ) : null}
        {progress?.percent !== undefined && !progress.done ? (
          <span className="nvim-toast-percent">
            {Math.round(progress.percent)}%
          </span>
        ) : null}
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

/** Marks over a markdown's fenced code, and how a group is drawn. */
export interface CodeMarks {
  /** The markdown source, whose lines the marks name. */
  readonly source: string;
  readonly marks: readonly MdMark[];
  readonly style: (hl: string) => CSSProperties;
}

/** A mark over one line of a code block: its columns and its look. */
interface LineMark {
  readonly line: number;
  readonly from: number;
  readonly to: number;
  readonly style: CSSProperties;
}

/**
 * The marks over the code block whose node starts on source line `start`
 * (1-based; a fence's line, or the first line of an indented block), as
 * lines of the code.
 */
function blockMarks(marked: CodeMarks, start: number): LineMark[] {
  const fence = /^\s{0,3}(```|~~~)/.test(
    marked.source.split("\n")[start - 1] ?? "",
  );
  const first = fence ? start + 1 : start;
  return marked.marks
    .filter((m) => m.line >= first)
    .map((m) => ({
      line: m.line - first,
      from: m.from,
      to: m.to,
      style: marked.style(m.hl),
    }));
}

/**
 * How a markdown body is drawn in the editor (a component's `markdown`, a
 * popup's): links open in the browser, fenced code is coloured, and marks
 * (an LSP signature's active parameter) are drawn over it.
 */
export function markdownComponents(
  dark: boolean,
  openLink: (url: string) => void,
  marked?: CodeMarks,
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
    code: ({ className, children, node }) => {
      const text = String(children ?? "");
      const language = /language-([\w+-]+)/.exec(className ?? "")?.[1];
      const block = language !== undefined || text.includes("\n");
      if (!block) return <code>{children}</code>;
      const start = node?.position?.start.line;
      const code = text.replace(/\n$/, "");
      const lines = code.split("\n").length;
      const marks =
        marked && start !== undefined
          ? blockMarks(marked, start).filter((m) => m.line < lines)
          : [];
      return (
        <HighlightedCode
          code={code}
          language={language}
          dark={dark}
          marks={marks}
        />
      );
    },
  };
}

export function HighlightedCode({
  code,
  language,
  dark,
  marks = [],
}: {
  readonly code: string;
  readonly language: string | undefined;
  readonly dark: boolean;
  readonly marks?: readonly LineMark[];
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
  const lines: readonly (readonly { text: string; colour?: string }[])[] =
    colouring
      ? colouring.map((line) =>
          line.map((token) => {
            const colour = dark ? token.dark : token.light;
            return colour ? { text: token.text, colour } : { text: token.text };
          }),
        )
      : code.split("\n").map((text) => [{ text }]);
  const body: ReactNode = lines.map((line, index) => {
    const here = marks.filter((m) => m.line === index);
    return (
      <span key={index}>
        {markPieces(line, here).map((piece, t) => {
          const colour = piece.token.colour;
          const mark = here[piece.mark];
          const style: CSSProperties = {
            ...(colour ? { color: colour } : {}),
            ...(mark ? mark.style : {}),
          };
          return (
            <span
              key={t}
              className={mark ? "nvim-code-mark" : undefined}
              style={Object.keys(style).length > 0 ? style : undefined}
            >
              {piece.text}
            </span>
          );
        })}
        {index < lines.length - 1 ? "\n" : null}
      </span>
    );
  });
  return (
    <pre className="nvim-rich-code">
      <code>{body}</code>
    </pre>
  );
}
