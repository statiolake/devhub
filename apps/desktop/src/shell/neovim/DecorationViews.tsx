/**
 * The page's side of `decorations.ts`: toasts and inline images, each drawn
 * over the Neovim window it belongs to; and how markdown is drawn in the
 * editor (components' `markdown`, popups).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
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
import { veilMargin, veilMask, veilSigma, type VeilLine } from "./veil";
import type { OverPart } from "./painter";
import { createPortal } from "react-dom";

interface Cell {
  readonly width: number;
  readonly height: number;
}

/**
 * Notifications, in fidget's place and spirit: quiet lines at the bottom
 * right, the lowest on the row over the status line, their right edge a
 * cell in from the window's (the status line's file name's edge). No card,
 * no rule, no words for levels: a source's name on its own line over its
 * messages, half a line between sources, every line on the editor's own
 * line pitch so it interleaves with the code's rhythm instead of crossing
 * it. Text in the UI face at the editor's size — prose has no columns, and
 * a monospace line over code reads as more code — in tones the scheme
 * already has: the source in `Normal`, a message in `Comment` (an aside),
 * a title in `Comment` toward the ground; a warning or error tints its
 * message with the diagnostic's colour. Work in progress is a ring as long
 * as its percentage (a turning arc without one), a check in `DiagnosticOk`
 * when done. Under the lines, a backdrop as long as each line (`veil.ts`).
 */
export function Toasts({
  toasts,
  dismiss,
  bottom = 12,
  right = 12,
  surface,
  cell,
  fontSize,
}: {
  readonly toasts: readonly Toast[];
  readonly dismiss: (key: number) => void;
  /** Pixels from the editor's bottom: the status line's top. */
  readonly bottom?: number;
  /** Pixels from the editor's right: a cell in from the window's edge. */
  readonly right?: number;
  /** The colorscheme's colours; DevHub's own until known. */
  readonly surface?: Surface | undefined;
  /** The editor's cell: the pitch of the lines and their widest. */
  readonly cell?: Cell | undefined;
  /** The editor's font size: the lines' size. */
  readonly fontSize?: number | undefined;
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
  const line = cell?.height ?? 18;
  const sigma = veilSigma(line);
  const margin = veilMargin(sigma);
  const stackRef = useRef<HTMLDivElement>(null);
  const veilRef = useRef<HTMLDivElement>(null);
  const any = toasts.length > 0;
  useEffect(() => {
    if (!any) return undefined;
    // The veil follows the lines every frame while there are any: lines
    // fade, fold and move in CSS, and the shape moves with them.
    let frame = 0;
    let last = "";
    const follow = () => {
      frame = requestAnimationFrame(follow);
      const stack = stackRef.current;
      const veil = veilRef.current;
      if (!stack || !veil) return;
      const origin = veil.getBoundingClientRect();
      const lines: VeilLine[] = [];
      for (const el of stack.querySelectorAll<HTMLElement>(
        ".nvim-toast-source, .nvim-toast-text",
      )) {
        const r = el.getBoundingClientRect();
        let opacity = 1;
        for (
          let up: HTMLElement | null = el;
          up && up !== stack;
          up = up.parentElement
        ) {
          opacity *= Number(getComputedStyle(up).opacity);
        }
        lines.push({
          x: r.left - origin.left,
          y: r.top - origin.top,
          w: r.width,
          h: Math.min(r.height, line),
          opacity,
        });
      }
      const mask =
        veilMask(lines, origin.width, origin.height, sigma) ?? "none";
      if (mask === last) return;
      last = mask;
      veil.style.maskImage = mask;
      veil.style.visibility = mask === "none" ? "hidden" : "visible";
    };
    follow();
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [any, line, sigma]);
  return (
    <div
      className="nvim-toasts"
      aria-live="polite"
      style={{
        bottom,
        right,
        ...surfaceStyle(surface),
        ["--nvim-line" as string]: `${String(line)}px`,
        ...(cell ? { maxWidth: 48 * cell.width } : {}),
        ...(fontSize ? { fontSize } : {}),
      }}
    >
      <div
        className="nvim-toast-veil"
        ref={veilRef}
        aria-hidden
        style={{ inset: `-${String(margin)}px -${String(margin)}px 0` }}
      />
      <div className="nvim-toast-stack" ref={stackRef}>
        {toastGroups(toasts).map(({ group, toasts: list }) => (
          <div
            key={group}
            className={`nvim-toast-group${list.every((t) => leaving.has(toastId(t))) ? " nvim-toast-group-leaving" : ""}`}
          >
            <div className="nvim-toast-group-body">
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
          </div>
        ))}
      </div>
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
  set("--nvim-toast-ground", surface.ground ?? surface.bg);
  set("--nvim-toast-fg", surface.text ?? surface.fg);
  set("--nvim-toast-muted", surface.muted);
  set("--nvim-toast-warn", surface.warn);
  set("--nvim-toast-error", surface.error);
  set("--nvim-toast-ok", surface.ok);
  return out;
}

/**
 * A line's time ends with its fade (600 ms, slow enough to go unnoticed),
 * in place; its room closes once, when it is gone: nothing moves while its
 * text shows, and nothing moves frame by frame after it.
 */
const LEAVE_MS = 600;

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
      Math.max(0, toast.timeout - LEAVE_MS),
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
        <span className="nvim-toast-text">
          <span className="nvim-toast-msg">{toast.msg || toast.title}</span>
          {toast.msg !== "" &&
          toast.title !== "" &&
          toast.title !== toast.group ? (
            <span className="nvim-toast-title">{toast.title}</span>
          ) : null}
          {progress ? <ProgressMark progress={progress} /> : null}
        </span>
      </div>
    </div>
  );
}

/**
 * Work in progress, in a cap-high box after the text: a faint ring with an
 * arc as long as the percentage ("how far", drawn rather than printed); an
 * arc turning once in 1.2 s when there is no percentage; a check in
 * `DiagnosticOk` when done, the one change of state worth a colour.
 */
function ProgressMark({
  progress,
}: {
  readonly progress: NonNullable<Toast["progress"]>;
}) {
  // r = 5 less half the stroke; the stroke is a tenth of an em (the UI
  // face's regular stem) in the box's units (a cap is about 0.7 em).
  const r = 4.3;
  const around = 2 * Math.PI * r;
  const percent = progress.percent;
  return (
    <svg className="nvim-toast-mark" viewBox="0 0 10 10" aria-hidden>
      {progress.done ? (
        <path
          className="nvim-toast-check"
          d="M1.4 5.4 L4 8 L8.8 2.2"
          fill="none"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : percent !== undefined ? (
        <g transform="rotate(-90 5 5)">
          <circle className="nvim-toast-track" cx={5} cy={5} r={r} />
          <circle
            className="nvim-toast-arc"
            cx={5}
            cy={5}
            r={r}
            strokeDasharray={`${String((Math.min(100, Math.max(0, percent)) / 100) * around)} ${String(around)}`}
          />
        </g>
      ) : (
        <circle
          className="nvim-toast-arc nvim-toast-turning"
          cx={5}
          cy={5}
          r={r}
          strokeDasharray={`${String(0.75 * around)} ${String(around)}`}
        />
      )}
    </svg>
  );
}

/**
 * Each image in the rows its extmark reserves, in every window showing it,
 * on its text as that scrolls and cut to the window (`riders.ts`).
 */
export function InlineImages({
  decorations,
  boxes,
  cell,
  ride,
  over,
}: {
  readonly decorations: Decorations;
  readonly boxes: readonly GridBox[];
  readonly cell: Cell;
  /** Move them to their text (`riders.ts`) once laid out. */
  readonly ride: () => void;
  /** The element a grid's riders go in, its own clip. */
  readonly over: (grid: number, part: OverPart) => HTMLElement;
}) {
  useLayoutEffect(ride);
  return (
    <>
      {decorations.placedImages.map((place) => {
        const src = decorations.images.get(place.id);
        const box = boxes.find((b) => b.win === place.win);
        if (src === undefined || !box) return null;
        return createPortal(
          <div
            className="nvim-inline-image"
            data-ride-win={place.win}
            data-ride-base={place.base}
            style={{
              left: (box.col + place.col) * cell.width,
              top: (box.row + place.row) * cell.height,
              width: place.width * cell.width,
              height: place.rows * cell.height,
            }}
          >
            <img
              src={src}
              alt=""
              draggable={false}
              style={{ height: place.rows * cell.height }}
            />
          </div>,
          over(box.grid, "riders"),
          `${String(place.id)}:${String(place.win)}`,
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
