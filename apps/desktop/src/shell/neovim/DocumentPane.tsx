/**
 * One `gui.document`, drawn: the conversation's own Markdown renderer
 * (`MarkdownDocument`), so a preview reads as the conversation and the
 * Orchestrator do — the same typesetting (`conversation-typeset`), code
 * colouring, math, Mermaid, tables, task lists and link menus.
 *
 * What the renderer asks of its page is answered for a file on the
 * Neovim's machine (`useDocumentActions`): a path is looked for there,
 * relative to the document's folder, and a picture read from there, by Lua
 * (`neovimDocument.ts`) — over SSH too, nothing fetched. A link to a file
 * opens in Neovim; a URL in the browser; a `#heading` scrolls the drawing.
 *
 * The page keeps how far down the drawing is scrolled, in pixels; Neovim
 * keeps everything else. The keys ask for a scroll (`DocumentScroll`), the
 * wheel scrolls it here, and either way it eases as the editor's smooth
 * scroll does (`documentMotion.ts`) and the source lines in sight are told
 * back, frame by frame (`_document_view`) — as the person's scroll, or as
 * one that followed (`scroll_to`, its window), which the source is not told
 * of, so neither side chases the other. When Neovim moves the window's top
 * itself (a search, `:42`), the drawing follows. Each block carries the
 * source line it starts at (`sourceLines`), measured where it is drawn,
 * which is how a line is a height (`documents.ts`).
 *
 * The mouse is the drawing's (`GUI_OWNED`): a drag selects its text, ⌘C,
 * the Edit menu's Copy and the right-click menu's copy it with DevHub's
 * notice; Esc or a click elsewhere lets it go. While text is selected the
 * keyboard is here (focusing Neovim's field would drop the selection); any
 * other key lets it go and is Neovim's. A click on a link follows it, not
 * the click that ends a drag. An Alt-click is the source's: the place it
 * is in the source (`sourcePlace`) goes to Lua (`on_source_click`).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import type { EmbedFileWire, FileRange } from "../../ipc/conversation";
import {
  AgentCwdProvider,
  ConversationActionsProvider,
  type ConversationActions,
} from "../conversation/ConversationContext";
import {
  MarkdownDocument,
  RemoteImagesContext,
} from "../conversation/Markdown";
import { PathLinks, PathLinksProvider } from "../conversation/pathLinks";
import "../conversation/conversation.css";
import { isDark, rgbCss } from "./components";
import {
  headingSlug,
  lineAtPixel,
  lineAtPixelExact,
  lineMarks,
  pixelOfLine,
  scrolledTop,
  sourcePlace,
  type DocumentActivation,
  type DocumentContent,
  type DocumentPlace,
  type DocumentScroll,
  type LineMark,
  type SourcePlace,
} from "./documents";
import {
  bounded,
  easeTo,
  frame,
  movedTo,
  moving,
  newMotion,
  wheelBy,
  type DocumentMotion,
  type MotionCause,
} from "./documentMotion";
import { reducedMotion } from "./paneMotion";
import type { LayerHost } from "./LayerViews";

/** The renderer's requests, answered by Lua on the Neovim's machine. */
function useDocumentActions(
  id: number,
  host: LayerHost,
  jump: (fragment: string) => void,
): ConversationActions {
  const hostRef = useRef(host);
  hostRef.current = host;
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  return useMemo(() => {
    const none = () => Promise.reject(new Error("a document sends nothing"));
    const say = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      hostRef.current.lua("_document_say", [message]);
    };
    const write = (text: string) =>
      hostRef.current.bridge.writeClipboard?.(text) ?? Promise.resolve();
    const lua = (fn: string, args: readonly unknown[]) =>
      hostRef.current.request(fn, [id, ...args]);
    return {
      writeClipboard: write,
      writeClipboardImage: () =>
        Promise.reject(new Error("an image cannot be copied from here")),
      writeClipboardRich: (content) => write(content.text),
      saveSlidesPdf: () => Promise.resolve(undefined),
      saveSlideImages: () => Promise.resolve([]),
      showContextMenu: (request) =>
        hostRef.current.bridge.showContextMenu?.(request) ??
        Promise.resolve(undefined),
      openExternalUrl: (url) => {
        if (url.startsWith("#")) {
          jumpRef.current(url.slice(1));
          return Promise.resolve();
        }
        return hostRef.current.bridge.openExternalUrl(url);
      },
      copyText: (text) =>
        hostRef.current.bridge.copyText?.(text) ?? write(text),
      send: none,
      startEditingPending: none,
      editPending: none,
      stopEditingPending: none,
      removePending: none,
      sendPendingNow: none,
      instruct: none,
      rewind: none,
      cancelLimitResume: none,
      interrupt: none,
      stopTask: none,
      runInBackground: none,
      answer: none,
      setSetting: none,
      cliDefaults: () => Promise.resolve(undefined),
      setCliDefault: none,
      openResume: () => undefined,
      openMcp: () => undefined,
      restart: none,
      saveDraft: () => Promise.resolve(),
      resolvePaths: async (cwd, paths) => {
        const found = await lua("_document_resolve", [cwd ?? null, paths]);
        return paths.map((_, i) => {
          const one = Array.isArray(found) ? found[i] : undefined;
          return typeof one === "string" ? one : null;
        });
      },
      readEmbedFile: async (path) =>
        fileOf(await lua("_document_read", [path])),
      embedSignature: async (path) => {
        const signature = await lua("_document_signature", [path]);
        return typeof signature === "string" ? signature : null;
      },
      openFile: (path, range) => {
        const [line, col] = lineOf(range);
        hostRef.current.lua("_document_open", [id, path, line, col]);
        hostRef.current.refocus();
        return Promise.resolve();
      },
      reportFailure: say,
    } satisfies ConversationActions;
  }, [id]);
}

/** What `_document_read` answered, as the renderer's readers take it. */
export function fileOf(value: unknown): EmbedFileWire | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v["base64"] !== "string") return null;
  const text = atob(v["base64"]);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return {
    mediaType:
      typeof v["media_type"] === "string"
        ? v["media_type"]
        : "application/octet-stream",
    bytes,
    signature: typeof v["signature"] === "string" ? v["signature"] : "",
  };
}

function lineOf(range: FileRange | undefined): [number | null, number | null] {
  if (range === undefined) return [null, null];
  return range.kind === "line"
    ? [range.line, range.column]
    : [range.from, null];
}

/** The link the keyboard is on: the anchor to `href` in the block of `line`. */
export function focusedAnchor(
  root: HTMLElement,
  line: number,
  href: string,
): HTMLElement | undefined {
  let best: { el: HTMLElement; line: number } | undefined;
  for (const el of root.querySelectorAll<HTMLElement>("a[data-href]")) {
    if (el.dataset["href"] !== href) continue;
    const block = el.closest<HTMLElement>("[data-source-line]");
    const at = Number(block?.dataset["sourceLine"] ?? 0);
    if (at > line) continue;
    if (best === undefined || at > best.line) best = { el, line: at };
  }
  return best?.el;
}

/** The selection, when it is text of `root` (not collapsed). */
function selectionOf(root: HTMLElement): Selection | undefined {
  const selection = window.getSelection();
  if (
    !selection ||
    selection.isCollapsed ||
    selection.rangeCount === 0 ||
    !root.contains(selection.getRangeAt(0).commonAncestorContainer)
  )
    return undefined;
  return selection;
}

function isCopyKey(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "c"
  );
}

/** The caret at a point of the page: its node and offset, or nothing. */
function caretAt(
  x: number,
  y: number,
): { node: Node; offset: number } | undefined {
  const d = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = d.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = d.caretRangeFromPoint?.(x, y);
  if (range) return { node: range.startContainer, offset: range.startOffset };
  return undefined;
}

/**
 * The source place of a point in the drawing (an Alt-click): the block
 * under it and its drawn text either side of the point (`sourcePlace`).
 */
export function sourcePlaceAt(
  root: HTMLElement,
  target: Element,
  caret: { node: Node; offset: number } | undefined,
  lines: readonly string[],
): SourcePlace | undefined {
  const block = target.closest<HTMLElement>("[data-source-line]");
  if (!block || !root.contains(block)) return undefined;
  const line = Number(block.dataset["sourceLine"]);
  if (!Number.isFinite(line)) return undefined;
  const code = block.querySelector("pre code") ?? block.closest("pre");
  const within = code ?? block;
  if (!caret || !within.contains(caret.node)) return { line, col: undefined };
  const range = document.createRange();
  range.selectNodeContents(within);
  range.setEnd(caret.node, caret.offset);
  const before = range.toString();
  range.selectNodeContents(within);
  range.setStart(caret.node, caret.offset);
  const after = range.toString();
  return sourcePlace(lines, line, before, after, code !== null);
}

/** A press moved this far is a drag (a selection), not a click. */
const DRAG_PX = 4;

export default function DocumentPane({
  content,
  place,
  scroll,
  activation,
  host,
  width,
  height,
}: {
  readonly content: DocumentContent;
  readonly place: DocumentPlace;
  readonly scroll: DocumentScroll | undefined;
  readonly activation: DocumentActivation | undefined;
  readonly host: LayerHost;
  readonly width: number;
  readonly height: number;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const marks = useRef<LineMark[]>([]);
  const lines = useMemo(() => content.text.split("\n"), [content.text]);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const lineCount = lines.length;
  const countRef = useRef(lineCount);
  countRef.current = lineCount;
  /** The line (with its fraction) the top is at: kept as the drawing reflows. */
  const anchor = useRef<number | undefined>(undefined);
  /** The source lines last told to Lua, and whether as a follow. */
  const told = useRef<
    { top: number; bottom: number; follow: boolean } | undefined
  >(undefined);
  /** A scroll to a line asked before the drawing was measured. */
  const pendingTo = useRef<number | undefined>(undefined);
  const hostRef = useRef(host);
  hostRef.current = host;
  /** The scroll in motion (`documentMotion.ts`), and its frame. */
  // Where it starts is none of the person's doing: told as followed.
  const motion = useRef<DocumentMotion>({ ...newMotion(), cause: "follow" });
  const raf = useRef(0);
  /** The `scrollTop` this page last set: any other is the scroll bar's. */
  const setTop = useRef(0);
  /** A press: where, and whether it was the Alt-click's. */
  const press = useRef<{ x: number; y: number; alt: boolean } | undefined>(
    undefined,
  );

  const total = () => scroller.current?.scrollHeight ?? 0;
  const maxTop = () => {
    const el = scroller.current;
    return el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
  };
  const pixelOf = useCallback(
    (line: number) =>
      pixelOfLine(marks.current, line, total(), countRef.current),
    [],
  );

  /** Tell Lua what is in sight, if that changed. */
  const report = useCallback(() => {
    const el = scroller.current;
    // Nothing measured yet: nothing to say (a guess would move Neovim).
    if (!el || marks.current.length === 0) return;
    const m = motion.current;
    // Neovim moved the window itself: what it has is told once, settled.
    if (m.cause === "neovim" && moving(m)) return;
    const all = total();
    anchor.current = lineAtPixelExact(
      marks.current,
      el.scrollTop,
      all,
      countRef.current,
    );
    // A pixel in: `scrollTop` is a device pixel, a line's top may be a
    // fraction of one below it.
    const top = lineAtPixel(
      marks.current,
      el.scrollTop + 1,
      all,
      countRef.current,
    );
    const bottom = lineAtPixel(
      marks.current,
      el.scrollTop + el.clientHeight - 1,
      all,
      countRef.current,
    );
    const follow = m.cause === "follow";
    const before = told.current;
    if (
      before &&
      before.top === top &&
      before.bottom === bottom &&
      before.follow === follow
    )
      return;
    told.current = { top, bottom, follow };
    hostRef.current.lua("_document_view", [content.id, top, bottom, follow]);
  }, [content.id]);

  /** The drawing at the motion's place. */
  const show = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = motion.current.top;
    setTop.current = el.scrollTop;
    report();
  }, [report]);

  const step = useCallback(() => {
    raf.current = 0;
    const more = frame(motion.current, performance.now());
    show();
    if (more) raf.current = requestAnimationFrame(step);
  }, [show]);

  /** Show the motion now, and on each frame while it moves. */
  const run = useCallback(() => {
    show();
    if (moving(motion.current) && raf.current === 0)
      raf.current = requestAnimationFrame(step);
  }, [show, step]);

  useEffect(
    () => () => {
      if (raf.current !== 0) cancelAnimationFrame(raf.current);
    },
    [],
  );

  /** Where each block is, from the drawing as it stands. */
  const measure = useCallback(() => {
    const el = scroller.current;
    const doc = body.current;
    if (!el || !doc) return;
    const origin = el.getBoundingClientRect().top - el.scrollTop;
    const raw: LineMark[] = [];
    for (const block of doc.querySelectorAll<HTMLElement>(
      "[data-source-line]",
    )) {
      raw.push({
        line: Number(block.dataset["sourceLine"]),
        top: block.getBoundingClientRect().top - origin,
      });
    }
    // Not laid out yet (its pane hidden, its chunk just mounted): every
    // block at one height says nothing of where lines are.
    const measured = lineMarks(raw);
    const laidOut =
      el.clientHeight > 0 &&
      (measured.length < 2 || measured.at(-1)!.top > measured[0]!.top);
    marks.current = laidOut ? measured : [];
  }, []);

  /** Ease to `top` (`documentMotion.ts`), as `cause` asked. */
  const scrollTo = useCallback(
    (top: number, cause: MotionCause) => {
      const el = scroller.current;
      if (!el) return;
      easeTo(
        motion.current,
        top,
        performance.now(),
        el.clientHeight,
        maxTop(),
        cause,
        !reducedMotion(),
      );
      run();
    },
    [run],
  );

  // The drawing changed (an edit, a picture or a diagram arriving, a new
  // width): measured again, the line at the top kept there.
  useLayoutEffect(() => {
    const el = scroller.current;
    const doc = body.current;
    if (!el || !doc) return;
    const again = () => {
      measure();
      if (pendingTo.current !== undefined && marks.current.length > 0) {
        const line = pendingTo.current;
        pendingTo.current = undefined;
        // The first place is taken at once: there is nothing shown to move.
        const m = motion.current;
        movedTo(m, Math.min(maxTop(), pixelOf(line)));
        m.cause = "follow";
        show();
        return;
      }
      if (marks.current.length === 0) return;
      const m = motion.current;
      bounded(m, maxTop());
      // In motion, the motion places it; at rest the line on top stays.
      if (!moving(m) && anchor.current !== undefined) {
        const cause = m.cause;
        movedTo(m, Math.min(maxTop(), pixelOf(anchor.current)));
        m.cause = cause;
      }
      show();
    };
    again();
    const observer = new ResizeObserver(again);
    observer.observe(doc);
    return () => {
      observer.disconnect();
    };
  }, [content.text, width, measure, pixelOf, show]);

  // Neovim moved the window's top itself (a search, `:42`): followed. A top
  // that is the page's own (`told`) is not.
  useLayoutEffect(() => {
    if (place.told || told.current?.top === place.topline) return;
    if (marks.current.length === 0) {
      pendingTo.current = place.topline;
      return;
    }
    scrollTo(pixelOf(place.topline), "neovim");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new top
  }, [place.topline]);

  // The keys asked for a scroll.
  // One to a line asked before this mounted (the document's first `scroll`)
  // still applies; a relative one was for a drawing that is gone.
  const seenScroll = useRef(scroll?.by === "to" ? undefined : scroll?.seq);
  useLayoutEffect(() => {
    if (!scroll || scroll.seq === seenScroll.current) return;
    seenScroll.current = scroll.seq;
    const el = scroller.current;
    if (!el) return;
    if (scroll.by === "to" && marks.current.length === 0) {
      pendingTo.current = scroll.line ?? 1;
      return;
    }
    const m = motion.current;
    // A line followed that is the one at the top already (the source
    // following this drawing, said back): where it is, not its line's top.
    if (
      scroll.by === "to" &&
      lineAtPixel(marks.current, m.to, total(), countRef.current) ===
        (scroll.line ?? 1)
    )
      return;
    const lineHeight =
      parseFloat(getComputedStyle(el).fontSize || "15") * 1.6 || 24;
    scrollTo(
      scrolledTop(scroll, m.to, el.clientHeight, maxTop(), lineHeight, pixelOf),
      scroll.by === "to" ? "follow" : "page",
    );
  }, [scroll, pixelOf, scrollTo]);

  // The wheel: pixel for pixel, a tick a line at least, eased as the
  // editor's (`documentMotion.ts`). Not passive: the page's own scroll is
  // not wanted on top of it. Sideways and a pinch are the page's.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))
        return;
      event.preventDefault();
      const line =
        parseFloat(getComputedStyle(el).fontSize || "15") * 1.6 || 24;
      const dy =
        event.deltaMode === 1
          ? event.deltaY * line
          : event.deltaMode === 2
            ? event.deltaY * el.clientHeight
            : event.deltaY;
      wheelBy(
        motion.current,
        dy,
        performance.now(),
        line,
        maxTop(),
        !reducedMotion(),
      );
      run();
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", wheel);
    };
  }, [run]);

  // The link the keyboard is on: ringed, and brought into sight.
  const focusLine = place.focus?.line;
  const focusHref = place.focus?.href;
  useLayoutEffect(() => {
    const doc = body.current;
    const el = scroller.current;
    if (!doc || !el) return;
    for (const other of doc.querySelectorAll("[data-document-focus]"))
      other.removeAttribute("data-document-focus");
    if (focusLine === undefined || focusHref === undefined) return;
    const link = focusedAnchor(doc, focusLine, focusHref);
    if (!link) return;
    link.setAttribute("data-document-focus", "");
    const box = el.getBoundingClientRect();
    const at = link.getBoundingClientRect();
    if (at.top < box.top || at.bottom > box.bottom) {
      scrollTo(el.scrollTop + (at.top - box.top) - el.clientHeight / 3, "page");
    }
  }, [focusLine, focusHref, content.text, scrollTo]);

  // The keys followed a link: as a click on it would.
  const seenActivation = useRef(activation?.seq);
  useEffect(() => {
    if (!activation || activation.seq === seenActivation.current) return;
    seenActivation.current = activation.seq;
    const doc = body.current;
    if (!doc) return;
    focusedAnchor(doc, activation.line, activation.href)?.click();
  }, [activation]);

  /** A `#fragment`: the heading it names brought to the top. */
  const jump = useCallback(
    (fragment: string) => {
      const doc = body.current;
      const el = scroller.current;
      if (!doc || !el) return;
      let wanted = fragment;
      try {
        wanted = decodeURIComponent(fragment);
      } catch {
        // as written
      }
      wanted = wanted.toLowerCase();
      const seen = new Map<string, number>();
      for (const heading of doc.querySelectorAll<HTMLElement>(
        "h1, h2, h3, h4, h5, h6",
      )) {
        if (headingSlug(heading.textContent, seen) !== wanted) continue;
        const box = el.getBoundingClientRect();
        scrollTo(
          el.scrollTop + heading.getBoundingClientRect().top - box.top - 8,
          "page",
        );
        return;
      }
    },
    [scrollTo],
  );

  const actions = useDocumentActions(content.id, host, jump);
  const links = useMemo(
    () => new PathLinks(actions.resolvePaths, actions.reportFailure),
    [actions],
  );

  /** Copy the selected text, with DevHub's notice. */
  const copySelection = useCallback((): boolean => {
    const el = scroller.current;
    const selection = el ? selectionOf(el) : undefined;
    if (!selection) return false;
    void actions.copyText(selection.toString()).catch(actions.reportFailure);
    return true;
  }, [actions]);

  /** Let the selection go, and give the keyboard back to Neovim. */
  const release = useCallback(() => {
    const el = scroller.current;
    if (el && selectionOf(el)) window.getSelection()?.removeAllRanges();
    hostRef.current.refocus();
  }, []);

  // A click elsewhere lets the selection go.
  useEffect(() => {
    const away = (event: MouseEvent) => {
      const el = scroller.current;
      if (!el || el.contains(event.target as Node)) return;
      if (selectionOf(el)) window.getSelection()?.removeAllRanges();
    };
    window.addEventListener("mousedown", away, true);
    return () => {
      window.removeEventListener("mousedown", away, true);
    };
  }, []);

  const fg = host.defaults.foreground;
  const bg = host.defaults.background;
  const style = {
    "--conversation-font-size": `${String(((host.fontSize ?? 13) * 15) / 13)}px`,
    "--primary": rgbCss(fg),
    "--secondary": `color-mix(in srgb, ${rgbCss(fg)} 72%, ${rgbCss(bg)})`,
    "--tertiary": `color-mix(in srgb, ${rgbCss(fg)} 52%, ${rgbCss(bg)})`,
    colorScheme: isDark(bg) ? "dark" : "light",
    height,
  } as CSSProperties;

  return (
    <div
      className="nvim-document-scroll conversation-typeset"
      ref={scroller}
      style={style}
      // The keyboard's while text is selected (⌘C, Esc); Neovim's otherwise.
      tabIndex={-1}
      onScroll={() => {
        const el = scroller.current;
        if (!el) return;
        // Not this page's doing: its scroll bar, the page's own find.
        if (Math.abs(el.scrollTop - setTop.current) > 1) {
          if (raf.current !== 0) cancelAnimationFrame(raf.current);
          raf.current = 0;
          movedTo(motion.current, el.scrollTop);
          setTop.current = el.scrollTop;
        }
        report();
      }}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        press.current = {
          x: event.clientX,
          y: event.clientY,
          alt: event.altKey,
        };
        // An Alt-click is the source's: no selection starts.
        if (event.altKey) {
          event.preventDefault();
          return;
        }
        // Its window becomes Neovim's current one; the keys stay Neovim's.
        host.lua("_document_focus", [content.id]);
      }}
      onMouseUp={(event) => {
        if (event.button !== 0) return;
        const el = scroller.current;
        // A selection keeps the keyboard here, for ⌘C; a plain click gives
        // it back to Neovim.
        if (el && selectionOf(el)) el.focus({ preventScroll: true });
        else host.refocus();
      }}
      onClickCapture={(event) => {
        const down = press.current;
        press.current = undefined;
        const el = scroller.current;
        const doc = body.current;
        if (!el || !doc) return;
        if (event.altKey || down?.alt === true) {
          // Alt-click: the source's place, for the source to go to.
          event.preventDefault();
          event.stopPropagation();
          const at = sourcePlaceAt(
            doc,
            event.target as Element,
            caretAt(event.clientX, event.clientY),
            linesRef.current,
          );
          if (at)
            host.lua("_document_source_click", [
              content.id,
              at.line,
              at.col ?? null,
            ]);
          return;
        }
        // The click that ends a drag (a selection) follows no link.
        const dragged =
          down !== undefined &&
          Math.hypot(event.clientX - down.x, event.clientY - down.y) >= DRAG_PX;
        if (dragged || (event.detail > 1 && selectionOf(el))) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDown={(event) => {
        const el = scroller.current;
        if (!el || !selectionOf(el)) {
          host.refocus();
          return;
        }
        if (isCopyKey(event.nativeEvent)) {
          event.preventDefault();
          copySelection();
          return;
        }
        if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
        // Esc lets it go; any other key does too, and is Neovim's.
        release();
        if (event.key === "Escape") {
          event.preventDefault();
          return;
        }
        // A character arrives as text in the field focused now; a named key
        // or a chord is handed to it.
        const named = event.key.length !== 1 || event.ctrlKey || event.metaKey;
        const input = document.activeElement;
        if (named && input instanceof HTMLElement && input !== el) {
          event.preventDefault();
          input.dispatchEvent(new KeyboardEvent("keydown", event.nativeEvent));
        }
      }}
      onCopy={(event) => {
        // The Edit menu's Copy: the selection, with the notice.
        if (copySelection()) event.preventDefault();
      }}
      onContextMenu={(event) => {
        const el = scroller.current;
        if (!el || !selectionOf(el)) return;
        event.preventDefault();
        void host.bridge
          .showContextMenu?.({
            items: [{ id: "copy", label: "Copy" }],
            at: { x: Math.round(event.clientX), y: Math.round(event.clientY) },
          })
          .then((chosen) => {
            if (chosen === "copy") copySelection();
          })
          .catch(actions.reportFailure);
      }}
    >
      <ConversationActionsProvider value={actions}>
        <PathLinksProvider value={links}>
          <AgentCwdProvider value={content.base}>
            <RemoteImagesContext.Provider value={content.remoteImages}>
              <div
                className="conversation-markdown nvim-document-body"
                ref={body}
              >
                <MarkdownDocument source={content.text} settled sourceLines />
              </div>
            </RemoteImagesContext.Provider>
          </AgentCwdProvider>
        </PathLinksProvider>
      </ConversationActionsProvider>
    </div>
  );
}
