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
 * wheel scrolls it here, and either way the source lines in sight are told
 * back (`_document_view`); when Neovim moves the window's top itself (a
 * search, `:42`), the drawing follows. Each block carries the source line
 * it starts at (`sourceLines`), which is how a line is a height
 * (`documents.ts`).
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
  type DocumentActivation,
  type DocumentContent,
  type DocumentPlace,
  type DocumentScroll,
  type LineMark,
} from "./documents";
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
  const lineCount = useMemo(
    () => content.text.split("\n").length,
    [content.text],
  );
  const countRef = useRef(lineCount);
  countRef.current = lineCount;
  /** The line (with its fraction) the top is at: kept as the drawing reflows. */
  const anchor = useRef<number | undefined>(undefined);
  /** The source lines last told to Lua. */
  const told = useRef<{ top: number; bottom: number } | undefined>(undefined);
  /** A scroll to a line asked before the drawing was measured. */
  const pendingTo = useRef<number | undefined>(undefined);
  const hostRef = useRef(host);
  hostRef.current = host;

  const total = () => scroller.current?.scrollHeight ?? 0;
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
    const all = total();
    anchor.current = lineAtPixelExact(
      marks.current,
      el.scrollTop,
      all,
      countRef.current,
    );
    const top = lineAtPixel(marks.current, el.scrollTop, all, countRef.current);
    const bottom = lineAtPixel(
      marks.current,
      el.scrollTop + el.clientHeight - 1,
      all,
      countRef.current,
    );
    const before = told.current;
    if (before && before.top === top && before.bottom === bottom) return;
    told.current = { top, bottom };
    hostRef.current.lua("_document_view", [content.id, top, bottom]);
  }, [content.id]);

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

  const scrollTo = useCallback(
    (top: number) => {
      const el = scroller.current;
      if (!el) return;
      el.scrollTop = Math.max(0, top);
      report();
    },
    [report],
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
        scrollTo(pixelOf(line));
        return;
      }
      if (marks.current.length === 0) return;
      if (anchor.current !== undefined) el.scrollTop = pixelOf(anchor.current);
      report();
    };
    again();
    const observer = new ResizeObserver(again);
    observer.observe(doc);
    return () => {
      observer.disconnect();
    };
  }, [content.text, width, measure, pixelOf, report, scrollTo]);

  // Neovim moved the window's top itself (a search, `:42`): followed.
  useLayoutEffect(() => {
    if (told.current?.top === place.topline) return;
    if (marks.current.length === 0) {
      pendingTo.current = place.topline;
      return;
    }
    scrollTo(pixelOf(place.topline));
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
    const lineHeight =
      parseFloat(getComputedStyle(el).fontSize || "15") * 1.6 || 24;
    scrollTo(
      scrolledTop(
        scroll,
        el.scrollTop,
        el.clientHeight,
        el.scrollHeight - el.clientHeight,
        lineHeight,
        pixelOf,
      ),
    );
  }, [scroll, pixelOf, scrollTo]);

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
      scrollTo(el.scrollTop + (at.top - box.top) - el.clientHeight / 3);
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
      onScroll={report}
      onPointerDown={(event) => {
        // Its window becomes Neovim's current one; the keys stay Neovim's.
        if (event.button !== 0) return;
        host.lua("_document_focus", [content.id]);
      }}
      onPointerUp={() => {
        host.refocus();
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
