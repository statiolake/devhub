/**
 * The notice center: every notice that reached the screen this run.
 *
 * Drawn by the toasts page itself, in place of the stack, because the page
 * already holds every notice and is already a layer over the whole window —
 * a panel here is the stack grown into a list, measured and placed by the
 * same rule (`stackSize.ts`, `toastsView.ts`), with no second copy of the
 * notices in another page. `Cmd+Q M` (Show Notifications) opens it; main puts
 * the keyboard in this view, and Escape gives it back to the surface.
 *
 * Arrow keys move between entries, Delete removes one, Cmd+C copies one with
 * nothing selected. An entry's actions are offered while it is current — what
 * it reports is still in force — and its words are always selectable.
 */

import { useEffect, useRef, useState } from "react";
import type {
  CenterEntry,
  NoticeCenter as Center,
} from "../../model/noticeCenter";
import { isImeComposing } from "../accessibility/ime";
import type { Notice } from "../notices";
import { noticeText } from "./ToastStack";

export interface NoticeCenterProps {
  readonly entries: Center<Notice>;
  /** The entries that were unread when the center opened. */
  readonly unread: ReadonlySet<number>;
  readonly onClose: () => void;
  readonly onRemove: (key: number) => void;
  readonly onClearAll: () => void;
  readonly onRetry: () => void;
  readonly onOpenSettings: () => void;
  readonly onOpenMicrophoneSettings?: () => void;
  readonly onCopy: (text: string) => Promise<void>;
  readonly ref?: (element: HTMLElement | null) => void;
}

/** What kind of thing it is, and whether it still holds. */
export function entryState(entry: CenterEntry<Notice>): string {
  if (entry.notice.live === "alert") return "Error";
  return entry.current ? "Ongoing" : "Resolved";
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Entry({
  entry,
  unread,
  tabIndex,
  onRemove,
  onRetry,
  onOpenSettings,
  onOpenMicrophoneSettings,
  onCopy,
}: {
  readonly entry: CenterEntry<Notice>;
  readonly unread: boolean;
  readonly tabIndex: number;
  readonly onRemove: () => void;
  readonly onRetry: () => void;
  readonly onOpenSettings: () => void;
  readonly onOpenMicrophoneSettings?: () => void;
  readonly onCopy: (text: string) => Promise<void>;
}) {
  const { notice } = entry;
  const state = entryState(entry);
  return (
    <li
      className="notice-entry"
      data-key={entry.key}
      data-severity={notice.live}
      data-unread={unread ? "true" : undefined}
      tabIndex={tabIndex}
      aria-label={`${state}${unread ? ", new" : ""}: ${notice.summary}`}
    >
      <span className="toast-mark" aria-hidden="true">
        {notice.live === "alert" ? "!" : "i"}
      </span>
      <div className="notice-entry-body">
        <p className="notice-entry-meta">
          <time dateTime={new Date(entry.at).toISOString()}>
            {clockTime(entry.at)}
          </time>
          {` · ${state}`}
          {unread ? <span className="notice-entry-new"> · New</span> : null}
        </p>
        <p className="toast-summary">{notice.summary}</p>
        {notice.detail ? <p className="toast-detail">{notice.detail}</p> : null}
        <div className="notice-entry-actions">
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              void onCopy(noticeText(notice));
            }}
          >
            Copy
          </button>
          {entry.current && notice.actions.includes("retry") ? (
            <button type="button" className="toast-action" onClick={onRetry}>
              Try Again
            </button>
          ) : null}
          {entry.current && notice.actions.includes("open_settings") ? (
            <button
              type="button"
              className="toast-action"
              onClick={onOpenSettings}
            >
              Open Settings
            </button>
          ) : null}
          {entry.current &&
          notice.actions.includes("open_microphone_settings") &&
          onOpenMicrophoneSettings ? (
            <button
              type="button"
              className="toast-action"
              onClick={onOpenMicrophoneSettings}
            >
              Open Microphone Settings
            </button>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        className="toast-close"
        aria-label="Remove"
        onClick={onRemove}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M3 3l6 6M9 3l-6 6" />
        </svg>
      </button>
    </li>
  );
}

export function NoticeCenter({
  entries,
  unread,
  onClose,
  onRemove,
  onClearAll,
  onRetry,
  onOpenSettings,
  onOpenMicrophoneSettings,
  onCopy,
  ref,
}: NoticeCenterProps) {
  const panel = useRef<HTMLElement | null>(null);
  // The entry the arrows are on: one tab stop for the whole list.
  const [active, setActive] = useState(0);
  const activeIndex = Math.min(active, Math.max(0, entries.length - 1));

  const items = () =>
    Array.from(
      panel.current?.querySelectorAll<HTMLElement>(".notice-entry") ?? [],
    );
  const focusEntry = (index: number) => {
    const list = items();
    const clamped = Math.max(0, Math.min(index, list.length - 1));
    setActive(clamped);
    list[clamped]?.focus();
  };

  // Opened from the keyboard, so the keyboard lands on the newest entry.
  useEffect(() => {
    const first = panel.current?.querySelector<HTMLElement>(".notice-entry");
    (first ?? panel.current)?.focus();
  }, []);

  const unreadCount = entries.filter((entry) => unread.has(entry.key)).length;

  return (
    <section
      ref={(element) => {
        panel.current = element;
        ref?.(element);
      }}
      className="notice-center"
      role="dialog"
      aria-label="Notifications"
      tabIndex={-1}
      onFocus={(event) => {
        const index = items().indexOf(event.target as HTMLElement);
        if (index >= 0) setActive(index);
      }}
      onKeyDown={(event) => {
        if (isImeComposing(event.nativeEvent)) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        const target = event.target as HTMLElement;
        if (!target.classList.contains("notice-entry")) return;
        const index = items().indexOf(target);
        const entry = entries[index];
        switch (event.key) {
          case "ArrowDown":
            event.preventDefault();
            focusEntry(index + 1);
            return;
          case "ArrowUp":
            event.preventDefault();
            focusEntry(index - 1);
            return;
          case "Home":
            event.preventDefault();
            focusEntry(0);
            return;
          case "End":
            event.preventDefault();
            focusEntry(entries.length - 1);
            return;
          case "Delete":
          case "Backspace":
            if (!entry) return;
            event.preventDefault();
            onRemove(entry.key);
            // The next one takes its place under the keyboard.
            requestAnimationFrame(() => {
              const list = items();
              (
                list[Math.min(index, list.length - 1)] ?? panel.current
              )?.focus();
            });
            return;
          default:
        }
        if (
          entry &&
          event.metaKey &&
          !event.shiftKey &&
          !event.altKey &&
          event.key.toLowerCase() === "c"
        ) {
          event.preventDefault();
          const selected = window.getSelection()?.toString() ?? "";
          void onCopy(selected === "" ? noticeText(entry.notice) : selected);
        }
      }}
    >
      <header className="notice-center-header">
        <h2 className="notice-center-title">Notifications</h2>
        {unreadCount > 0 ? (
          <span className="notice-center-count">{`${String(unreadCount)} new`}</span>
        ) : null}
        <button
          type="button"
          className="toast-action"
          disabled={entries.length === 0}
          onClick={() => {
            onClearAll();
            panel.current?.focus();
          }}
        >
          Clear All
        </button>
        <button
          type="button"
          className="toast-close"
          aria-label="Close"
          onClick={onClose}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </header>
      {entries.length === 0 ? (
        <p className="notice-center-empty">No notifications</p>
      ) : (
        <ul className="notice-center-list" aria-label="Recent notifications">
          {entries.map((entry, index) => (
            <Entry
              key={entry.key}
              entry={entry}
              unread={unread.has(entry.key)}
              tabIndex={index === activeIndex ? 0 : -1}
              onRemove={() => {
                onRemove(entry.key);
              }}
              onRetry={onRetry}
              onOpenSettings={onOpenSettings}
              onOpenMicrophoneSettings={onOpenMicrophoneSettings}
              onCopy={onCopy}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
