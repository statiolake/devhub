/**
 * A Marp deck — a ```marp block, a ```markdown block or a Markdown file whose
 * front matter says `marp: true` — drawn as its slides, one at a time.
 *
 * The slide is a picture (`marp.ts`): an `<img>` of a standalone SVG, so
 * nothing of the deck is ever markup in this page. Under it, a quiet line:
 * the previous and next slide, and where in the deck it is (_3 / 12_);
 * ←/→ do the same while the deck has the focus. The header is the code
 * block's: the language, the toggle to the source, a save (a menu: the deck
 * as a PDF, every slide as a PNG, this slide as a PNG — `slideExport.ts` in
 * main does the asking and the writing) and a copy of this slide as a PNG. A
 * right-click offers the same, and the source.
 *
 * A slide keeps its own theme's colours whatever DevHub's is: a deck is a
 * document with a look of its own, and is copied and printed as it is shown.
 */

import {
  memo,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { CodeBlock } from "./CodeBlock";
import { useConversationActions } from "./ConversationContext";
import { CopyButton } from "./CopyButton";
import { svgToPng } from "./diagramCopy";
import { svgDataUrl } from "./diagramSvg";
import {
  drawnMarp,
  rememberMarp,
  renderMarp,
  type MarpDeck,
  type MarpResult,
} from "./marp";
import type { PreviewProps } from "./Preview";
import {
  headerLanguage,
  PreviewFigure,
  type PreviewMenuItem,
} from "./PreviewFigure";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon } from "./icons";

/** The items of the deck's save button, in order. */
export const SAVE_MENU = [
  { id: "save-pdf", label: "Save as PDF…" },
  { id: "save-images", label: "Save Slides as Images…" },
  { id: "save-slide", label: "Save This Slide as Image…" },
] as const;

/** The items a right-click on a slide offers, in order. */
export const SLIDE_MENU = [
  { id: "copy-slide", label: "Copy Slide Image" },
  { id: "copy-source", label: "Copy Source" },
  ...SAVE_MENU,
] as const;

type SlideMenuId = (typeof SLIDE_MENU)[number]["id"];

/** The name a saved deck is given: its front matter's `title:`, else "slides". */
export function deckName(source: string): string {
  const title = /^title[ \t]*:[ \t]*["']?(.+?)["']?[ \t]*$/mu.exec(
    /^---\r?\n([\s\S]*?)\r?\n---/u.exec(source)?.[1] ?? "",
  )?.[1];
  return title?.trim() || "slides";
}

type Drawing = MarpResult | { readonly ok: "pending" };

function useDeck(code: string): Drawing {
  const [drawing, setDrawing] = useState<
    { readonly code: string; readonly result: MarpResult } | undefined
  >(() => {
    const result = drawnMarp(code);
    return result === undefined ? undefined : { code, result };
  });
  useEffect(() => {
    let current = true;
    void renderMarp(code).then((result) => {
      rememberMarp(code, result);
      if (current) setDrawing({ code, result });
    });
    return () => {
      current = false;
    };
  }, [code]);
  if (drawing === undefined || drawing.code !== code) return { ok: "pending" };
  return drawing.result;
}

export const MarpPreview = memo(function MarpPreview({
  code,
  info,
  toggle,
}: PreviewProps) {
  const drawing = useDeck(code);
  if (drawing.ok === "pending") {
    return <CodeBlock code={code} info={info} settled />;
  }
  if (!drawing.ok) {
    return (
      <div className="conversation-diagram-failed">
        <CodeBlock code={code} info={info} settled />
        <p className="conversation-diagram-error" role="note">
          Slides not drawn: {drawing.error}
        </p>
      </div>
    );
  }
  return (
    <SlideViewer deck={drawing.deck} code={code} info={info} toggle={toggle} />
  );
});

function SlideViewer({
  deck,
  code,
  info,
  toggle,
}: {
  readonly deck: MarpDeck;
  readonly code: string;
  readonly info: string | undefined;
  readonly toggle: ReactNode;
}) {
  const {
    writeClipboard,
    writeClipboardImage,
    saveSlidesPdf,
    saveSlideImages,
    showContextMenu,
    reportFailure,
  } = useConversationActions();
  const count = deck.slides.length;
  const [wanted, setAt] = useState(0);
  // A deck that lost slides as it was edited shows its last.
  const at = Math.min(wanted, count - 1);
  const url = useMemo(() => svgDataUrl(deck.slides[at]!), [deck, at]);
  const name = deckName(code);

  const png = (slide: string) =>
    svgToPng(slide, deck.size, undefined, window.devicePixelRatio, 0);
  const run: Record<SlideMenuId, () => Promise<void>> = {
    "copy-slide": async () => writeClipboardImage(await png(deck.slides[at]!)),
    "copy-source": () => writeClipboard(code),
    "save-pdf": async () => {
      await saveSlidesPdf({
        html: deck.printHtml,
        width: deck.size.width,
        height: deck.size.height,
        name,
      });
    },
    "save-images": async () => {
      const images: Uint8Array[] = [];
      for (const slide of deck.slides) images.push(await png(slide));
      await saveSlideImages({ images, name });
    },
    "save-slide": async () => {
      await saveSlideImages({
        images: [await png(deck.slides[at]!)],
        name: `${name}-${at + 1}`,
      });
    },
  };
  const menu: PreviewMenuItem[] = SLIDE_MENU.map(({ id, label }) => ({
    id,
    label,
    run: run[id],
    ...(id === "save-pdf" ? { separatorBefore: true as const } : {}),
  }));

  const go = (step: number) =>
    setAt(Math.max(0, Math.min(count - 1, at + step)));
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      go(event.key === "ArrowLeft" ? -1 : 1);
    }
  };

  const save = (
    <button
      type="button"
      className="conversation-copy"
      aria-label="Save slides"
      title="Save slides"
      aria-haspopup="menu"
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        void showContextMenu({
          items: SAVE_MENU.map(({ id, label }) => ({ id, label })),
          at: { x: box.left, y: box.bottom },
        })
          .then((chosen) =>
            chosen !== undefined && Object.hasOwn(run, chosen)
              ? run[chosen as SlideMenuId]()
              : undefined,
          )
          .catch(reportFailure);
      }}
    >
      <DownloadIcon />
    </button>
  );

  return (
    <PreviewFigure
      kind="marp"
      language={headerLanguage(info, "marp")}
      actions={
        <>
          {toggle}
          {save}
        </>
      }
      copy={<CopyButton copy={run["copy-slide"]} label="Copy slide image" />}
      menu={menu}
      label="Slides"
      className="conversation-slides"
    >
      <div
        className="conversation-slides-stage"
        tabIndex={0}
        role="group"
        aria-roledescription="slide"
        aria-label={`Slide ${at + 1} of ${count}`}
        onKeyDown={onKeyDown}
      >
        <img
          key={at}
          src={url}
          width={deck.size.width}
          height={deck.size.height}
          alt={`Slide ${at + 1} of ${count}`}
          draggable={false}
        />
      </div>
      <div className="conversation-slides-bar">
        <button
          type="button"
          className="conversation-copy"
          aria-label="Previous slide"
          title="Previous slide"
          disabled={at === 0}
          onClick={() => go(-1)}
        >
          <ChevronLeftIcon />
        </button>
        <span className="conversation-slides-counter" aria-live="polite">
          {at + 1} / {count}
        </span>
        <button
          type="button"
          className="conversation-copy"
          aria-label="Next slide"
          title="Next slide"
          disabled={at === count - 1}
          onClick={() => go(1)}
        >
          <ChevronRightIcon />
        </button>
      </div>
    </PreviewFigure>
  );
}
