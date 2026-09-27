/**
 * Cmd+F in a GUI Agent: a small find bar at the top right of the
 * conversation, like VS Code's find widget.
 *
 * It searches what is shown — the conversation, or the subagent that fills
 * the pane — and says which. The count is exact however large, and grows
 * while the search runs on in slices (`transcriptSearch.ts`); the matches on
 * view are marked, the current one more strongly, and the current one is
 * brought into view, opening whatever it is folded inside
 * (`findInTranscript.ts`). The count follows the conversation as it grows,
 * and the current match stays where it is.
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
import { revealMatch, scrollMatchIntoView } from "./findInTranscript";
import { ArrowDownIcon, ArrowUpIcon, CloseIcon } from "./icons";
import { TranscriptSearch, type SearchStatus } from "./transcriptSearch";

export interface FindBarHandle {
  /** Put the keyboard in the field, its words selected. */
  focus(): void;
  /** Go to the next match (1) or the previous (-1), around the ends. */
  step(delta: 1 | -1): void;
}

const NOTHING: SearchStatus = {
  total: 0,
  current: undefined,
  complete: true,
  moves: 0,
};

/** How many frames a match brought into view is centred again as what is around it is laid out. */
const SETTLE_FRAMES = 4;

/** An entry the page skips far from view is laid out, or skipped again. */
const SHOWN = "contentvisibilityautostatechange";

const number = new Intl.NumberFormat("en-US");

/**
 * How many matches, and which is current: `3 of 2,596,112`, with `…` after
 * it while the count still grows.
 */
export function countText(query: string, status: SearchStatus): string {
  if (query === "") return "";
  if (status.total === 0) return status.complete ? "No results" : "Searching…";
  const which =
    status.current === undefined ? "–" : number.format(status.current + 1);
  return `${which} of ${number.format(status.total)}${status.complete ? "" : "…"}`;
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
  const [search, setSearch] = useState<TranscriptSearch | undefined>();
  const [status, setStatus] = useState<SearchStatus>(NOTHING);

  useImperativeHandle(handle, () => ({
    focus: () => {
      field.current?.focus();
      field.current?.select();
    },
    step: (delta) => search?.step(delta),
  }));

  useLayoutEffect(() => {
    field.current?.focus();
  }, []);

  // How many moves of the current match were brought into view (`SearchStatus.moves`).
  const shownMoves = useRef(0);

  // One search per transcript searched: another scope is another search.
  useLayoutEffect(() => {
    const searched = root();
    if (searched === null) return;
    shownMoves.current = 0;
    const created: TranscriptSearch = new TranscriptSearch(searched, () =>
      setStatus(created.status()),
    );
    setSearch(created);
    return () => {
      created.dispose();
      setSearch(undefined);
      setStatus(NOTHING);
    };
  }, [root, scope.key]);

  useLayoutEffect(() => {
    search?.setQuery(query, caseSensitive);
  }, [search, query, caseSensitive]);

  // What React drew since is taken in before the page paints it.
  useLayoutEffect(() => {
    search?.refresh();
  }, [search, revision]);

  // The matches on view are painted — however many there are, only those —
  // again as the transcript scrolls, changes size, or more are found.
  const owner = useRef({});
  const repaint = useRef<() => void>(() => {});
  useEffect(() => {
    const painted = owner.current;
    if (search === undefined) return;
    const scroller = search.root.closest(".conversation-scroll");
    if (scroller === null)
      throw new Error("the transcript searched is not in a scrolling view");
    let frame = 0;
    // What was painted: the band around the view, and where the transcript was then.
    let band: { top: number; bottom: number; at: number } | undefined;
    const paint = () => {
      frame = 0;
      search.refresh();
      const view = scroller.getBoundingClientRect();
      const top = view.top - view.height;
      const bottom = view.bottom + view.height;
      paintMatches(
        painted,
        search.rangesWithin(top, bottom),
        search.currentRange(),
      );
      band = { top, bottom, at: search.root.getBoundingClientRect().top };
    };
    const request = () => {
      frame ||= requestAnimationFrame(paint);
    };
    const scrolled = () => {
      if (band !== undefined) {
        const moved = search.root.getBoundingClientRect().top - band.at;
        const view = scroller.getBoundingClientRect();
        if (view.top >= band.top + moved && view.bottom <= band.bottom + moved)
          return;
      }
      request();
    };
    repaint.current = request;
    scroller.addEventListener("scroll", scrolled, { passive: true });
    // An entry near the view is laid out only as it comes near: its matches
    // are painted then (`Layout`).
    search.root.addEventListener(SHOWN, request, { capture: true });
    const resized = new ResizeObserver(request);
    resized.observe(search.root);
    resized.observe(scroller);
    request();
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", scrolled);
      search.root.removeEventListener(SHOWN, request, { capture: true });
      resized.disconnect();
      repaint.current = () => {};
      clearMatches(painted);
    };
  }, [search]);

  useEffect(() => {
    repaint.current();
  }, [status]);

  // A match made current on purpose — a step, a new query's first — is
  // brought into view; one kept as the conversation grows is not.
  useEffect(() => {
    if (search === undefined || status.moves === shownMoves.current) return;
    shownMoves.current = status.moves;
    const current = search.currentRange();
    if (current === undefined) return;
    revealMatch(current, search.root);
    // After the folds it opened are drawn open. Not cancelled when the
    // conversation grows in between: that must not lose the move. Centred
    // again for a few frames: the entries around a far match are laid out
    // only as the view arrives (`content-visibility: auto`), and their real
    // heights move it from where it was estimated to be. A newer move takes
    // over.
    const move = status.moves;
    const centre = (frames: number) =>
      requestAnimationFrame(() => {
        if (shownMoves.current !== move) return;
        scrollMatchIntoView(current);
        if (frames > 1) centre(frames - 1);
      });
    centre(SETTLE_FRAMES);
  }, [search, status]);

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

  const step = (delta: 1 | -1) => search?.step(delta);
  const count = countText(query, status);
  const none = status.total === 0;
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
