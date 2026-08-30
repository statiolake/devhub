/**
 * Open Quickly, for workspaces.
 *
 * A sheet from the top of the window: a search field, a result list, and
 * nothing else. Typing filters, the arrows move, Return opens, Escape cancels —
 * the same four keys as every other picker on the Mac, so nobody has to reach
 * for the mouse and nobody has to be told.
 *
 * The results come from the sources in `config.toml`, streamed as each source
 * answers, so a slow one never holds up a fast one. "Other…" is the native
 * folder chooser, for a folder no source knows about.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isImeComposing } from "../../accessibility/ime";
import { useModalPresence } from "./modalPresence";
import { useAppShell } from "../../useAppShell";

export interface WorkspacePickerProps {
  readonly onDismiss: () => void;
}

function FolderGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M1.8 4.2a1 1 0 0 1 1-1h3l1.4 1.6h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9.4a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function WorkspacePicker({ onDismiss }: WorkspacePickerProps) {
  const {
    pickerCandidates,
    pickerBusy,
    startWorkspacePicker,
    cancelWorkspacePicker,
    selectWorkspacePicker,
    chooseWorkspaceFolder,
    reportFailure,
  } = useAppShell();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const composing = useRef(false);
  const input = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  useModalPresence();

  const ranked = useMemo(
    () => [...pickerCandidates].sort((left, right) => right.score - left.score),
    [pickerCandidates],
  );

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => {
      const target = restoreTo.current;
      if (target?.isConnected) target.focus();
    };
  }, []);

  // The query is re-run rather than filtered locally: a source can only be
  // asked, and a narrower query may reach rows the last one never returned.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void cancelWorkspacePicker().then(() => startWorkspacePicker(query));
    }, 200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [cancelWorkspacePicker, query, startWorkspacePicker]);

  useEffect(() => {
    setActive(0);
  }, [ranked.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const finish = useCallback(
    (action?: () => Promise<unknown>) => {
      void cancelWorkspacePicker()
        .then(() => action?.())
        .catch(reportFailure)
        .finally(onDismiss);
    },
    [cancelWorkspacePicker, onDismiss, reportFailure],
  );

  const open = useCallback(
    (path: string) => {
      finish(() => selectWorkspacePicker(path));
    },
    [finish, selectWorkspacePicker],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isImeComposing(event.nativeEvent, composing.current)) {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      finish();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (ranked.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + delta + ranked.length) % ranked.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const candidate = ranked[active];
      if (candidate) open(candidate.path);
    }
  };

  return createPortal(
    <div
      className="mac-scrim mac"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) finish();
      }}
    >
      <section
        className="mac-sheet picker"
        role="dialog"
        aria-modal="true"
        aria-label="Open workspace"
        onKeyDown={onKeyDown}
      >
        <div className="picker-search">
          <svg
            className="picker-search-glyph"
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
          >
            <circle cx="7" cy="7" r="4.2" />
            <path d="M10.2 10.2 13.4 13.4" />
          </svg>
          <input
            ref={input}
            className="picker-input"
            type="text"
            aria-label="Search workspaces"
            placeholder="Open Workspace"
            value={query}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
          {pickerBusy ? (
            <span
              className="mac-spinner"
              aria-label="Searching"
              role="status"
            />
          ) : null}
        </div>

        {ranked.length > 0 ? (
          <ul
            className="mac-list picker-results"
            role="listbox"
            aria-label="Workspaces"
            ref={listRef}
          >
            {ranked.map((candidate, index) => (
              <li key={`${candidate.operationId}:${candidate.path}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className="mac-list-row"
                  onMouseEnter={() => {
                    setActive(index);
                  }}
                  onClick={() => {
                    open(candidate.path);
                  }}
                >
                  <span className="mac-list-glyph">
                    <FolderGlyph />
                  </span>
                  <span className="mac-list-text">
                    <span className="mac-list-title">{candidate.label}</span>
                    <span className="mac-list-subtitle mac-caption">
                      {candidate.path}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="picker-empty mac-caption" role="status">
            {pickerBusy
              ? "Searching the folders in your configuration…"
              : query.length > 0
                ? "No workspaces match."
                : "No workspaces found in the configured sources."}
          </p>
        )}

        <footer className="picker-footer">
          <button
            type="button"
            className="mac-button plain"
            onClick={() => {
              finish(async () => {
                const path = await chooseWorkspaceFolder();
                if (path) await selectWorkspacePicker(path);
              });
            }}
          >
            Other…
          </button>
          <button
            type="button"
            className="mac-button"
            onClick={() => {
              finish();
            }}
          >
            Cancel
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
