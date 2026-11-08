/**
 * The page's side of `decorations.ts`: toasts and inline images, each drawn
 * over the Neovim window it belongs to; and how markdown is drawn in the
 * editor (components' `markdown`, popups).
 */

import { useEffect, useState, type ReactNode } from "react";
import type { Components } from "react-markdown";
import {
  grammarFor,
  highlight,
  type Colouring,
} from "../conversation/highlight";
import type { GridBox } from "./redraw";
import { toastGroups, type Decorations, type Toast } from "./decorations";

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
      {toast.msg !== "" && toast.title !== "" && toast.title !== toast.group ? (
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
 * How a markdown body is drawn in the editor (a component's `markdown`, a
 * popup's): links open in the browser, fenced code is coloured.
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
