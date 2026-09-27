/**
 * Cmd+F in a GUI Agent: a small find bar at the top right of the
 * conversation, like VS Code's find widget.
 *
 * It searches what is shown — the conversation, or the subagent that fills
 * the pane — and says which. Every match is marked, the current one more
 * strongly, and the current one is brought into view, opening whatever it
 * is folded inside (`findInTranscript.ts`). The count follows the
 * conversation as it grows, and the current match stays where it is.
 *
 * Keys, from the field: Return and Shift+Return go to the next and the
 * previous match, and Esc closes the bar and gives the keyboard back to where
 * it was. F3 and Shift+F3 do the same as Return and Shift+Return from
 * anywhere in the conversation while the bar is open, and Cmd+F puts the
 * keyboard back in its field (`ConversationSurface` routes those).
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { isImeComposing } from "../accessibility/ime";
import { clearMatches, paintMatches } from "./findHighlights";
import { findMatches, keptCurrent, revealMatch } from "./findInTranscript";
import { ArrowDownIcon, ArrowUpIcon, CloseIcon } from "./icons";

export interface FindBarHandle {
  /** Put the keyboard in the field, its words selected. */
  focus(): void;
  /** Go to the next match (1) or the previous (-1), around the ends. */
  step(delta: 1 | -1): void;
}

interface Found {
  readonly matches: readonly Range[];
  readonly current: number | undefined;
  /** What was searched: a match found in another scope is not kept. */
  readonly scope: string;
}

const NOTHING: Found = { matches: [], current: undefined, scope: "" };

/** How many matches, and which is current: `3 of 12`. */
export function countText(query: string, found: Found): string {
  if (query === "") return "";
  if (found.current === undefined) return "No results";
  return `${found.current + 1} of ${found.matches.length}`;
}

/** The next match (1) or the previous (-1), around the ends. */
function stepped(found: Found, delta: 1 | -1): Found {
  if (found.current === undefined) return found;
  const count = found.matches.length;
  return { ...found, current: (found.current + delta + count) % count };
}

export const FindBar = forwardRef<
  FindBarHandle,
  {
    /** The transcript searched now; drawn by the time the bar's effects run. */
    readonly root: () => HTMLElement | null;
    /** A key for what `root` is, and what the bar says it searches. */
    readonly scope: { readonly key: string; readonly name: string };
    /** Changes whenever the transcript may have been drawn again. */
    readonly revision: unknown;
    readonly onClose: () => void;
  }
>(function FindBar({ root, scope, revision, onClose }, handle) {
  const field = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [found, setFound] = useState<Found>(NOTHING);
  // Set by what moves the current match on purpose — a step, a new query —
  // and not by the conversation growing, which must not move the view.
  const bringIntoView = useRef(false);

  const step = (delta: 1 | -1) => {
    bringIntoView.current = true;
    setFound((was) => stepped(was, delta));
  };

  useImperativeHandle(handle, () => ({
    focus: () => {
      field.current?.focus();
      field.current?.select();
    },
    step,
  }));

  useLayoutEffect(() => {
    field.current?.focus();
  }, []);

  useLayoutEffect(() => {
    bringIntoView.current = true;
  }, [query, caseSensitive]);

  // Found again whenever what is searched, or how, or the transcript changes.
  useLayoutEffect(() => {
    const searched = root();
    const matches =
      searched === null ? [] : findMatches(searched, query, caseSensitive);
    setFound((was) => {
      const same = was.scope === scope.key;
      return {
        matches,
        scope: scope.key,
        current: keptCurrent(
          matches,
          same && was.current !== undefined
            ? was.matches[was.current]
            : undefined,
          same ? was.current : undefined,
        ),
      };
    });
  }, [root, scope.key, query, caseSensitive, revision]);

  const owner = useRef({});
  useEffect(() => {
    const current =
      found.current === undefined ? undefined : found.matches[found.current];
    paintMatches(owner.current, found.matches, current);
    if (current === undefined || !bringIntoView.current) return;
    bringIntoView.current = false;
    const searched = root();
    if (searched === null) return;
    revealMatch(current, searched);
    // After the folds it opened are drawn open. Not cancelled when the
    // conversation grows in between: that must not lose the move.
    requestAnimationFrame(() => {
      current.startContainer.parentElement?.scrollIntoView({
        block: "center",
      });
    });
  }, [found, root]);

  useEffect(() => {
    const painted = owner.current;
    return () => clearMatches(painted);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event.nativeEvent)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      // Closes the bar; a running turn is not interrupted by the same key.
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const count = countText(query, found);
  const none = found.current === undefined;
  return (
    <div
      className="conversation-find"
      role="search"
      aria-label="Find in the conversation"
    >
      <div className="conversation-find-row">
        <input
          ref={field}
          type="text"
          className="conversation-find-field"
          aria-label="Find"
          placeholder="Find"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <span
          className="conversation-find-count"
          data-none={(query !== "" && none) || undefined}
          aria-live="polite"
        >
          {count}
        </span>
        <button
          type="button"
          className="conversation-find-button conversation-find-case"
          aria-label="Match case"
          title="Match case"
          aria-pressed={caseSensitive}
          onClick={() => setCaseSensitive((was) => !was)}
        >
          Aa
        </button>
        <button
          type="button"
          className="conversation-find-button"
          aria-label="Previous match"
          title="Previous match (Shift+Return, Shift+F3)"
          disabled={none}
          onClick={() => step(-1)}
        >
          <ArrowUpIcon />
        </button>
        <button
          type="button"
          className="conversation-find-button"
          aria-label="Next match"
          title="Next match (Return, F3)"
          disabled={none}
          onClick={() => step(1)}
        >
          <ArrowDownIcon />
        </button>
        <button
          type="button"
          className="conversation-find-button"
          aria-label="Close"
          title="Close (Esc)"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="conversation-find-scope">{scope.name}</div>
    </div>
  );
});
