/**
 * A ```mermaid, ```svg or ```vega-lite block of an answer, drawn as the
 * picture it is.
 *
 * Only a closed block is drawn (`settled`, see `markdownBlocks.ts`): one
 * still being written is its code, the way every open fence is, and becomes
 * a picture once its fence closes. A picture is an `<img>` of its SVG
 * (`diagramSvg.ts`), drawn in DevHub's colours (`diagramTheme.ts`) and drawn
 * again when the theme changes. While Mermaid is still loading or drawing,
 * and whenever the source will not draw, the block is its code — with a line
 * under it saying why, when it failed — so a bad diagram never costs the
 * transcript anything but a picture.
 *
 * One of the previewable kinds (`previewKinds.ts`), drawn through
 * `Preview.tsx`, which owns the toggle to its source. The header is the code
 * block's, quiet and icon-only: the language, that toggle, and a copy — of the picture as
 * a PNG with a transparent ground, or of the source when the source is
 * shown. A right-click on the picture offers the rest, as a native menu
 * (`showContextMenu`): the picture on a transparent or a white ground, and
 * its source.
 *
 * A copy is pasted into a document or a slide, which is almost always light,
 * so it is not the picture on screen: it is drawn again in a fixed light
 * palette (`COPY_THEME`), whatever DevHub's theme is. A diagram copied from a
 * dark theme would otherwise be light-grey lines that vanish on white.
 */

import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { CodeBlock } from "./CodeBlock";
import { useConversationActions } from "./ConversationContext";
import { CopyButton } from "./CopyButton";
import {
  prepareSvg,
  svgDataUrl,
  type DiagramKind,
  type PreparedSvg,
  type SvgResult,
} from "./diagramSvg";
import { svgToPng } from "./diagramCopy";
import { COPY_THEME, useDiagramTheme, type DiagramTheme } from "./diagramTheme";
import { drawnMermaid, renderMermaid } from "./mermaid";
import { drawnVegaLite, renderVegaLite } from "./vegaLite";
import type { PreviewProps } from "./Preview";
import { headerLanguage, PreviewFigure } from "./PreviewFigure";
import { Lightbox, LightboxPicture, opensLightbox } from "./Lightbox";

/** The items a right-click on a drawn diagram offers, in order. */
export const DIAGRAM_MENU = [
  { id: "copy-image-transparent", label: "Copy Image (Transparent)" },
  { id: "copy-image-white", label: "Copy Image (White Background)" },
  { id: "copy-source", label: "Copy Source" },
] as const;

/** What a copied picture is painted on: nothing, or a sheet of paper. */
const WHITE = "#ffffff";

/** The picture drawn for pasting elsewhere: in `COPY_THEME`, not the screen's. */
export async function pictureForCopy(
  kind: DiagramKind,
  code: string,
): Promise<PreparedSvg> {
  const result =
    kind === "svg"
      ? prepareSvg(code, { color: COPY_THEME.ink })
      : await RENDERERS[kind].render(code, COPY_THEME);
  if (!result.ok) throw new Error(result.error);
  return result;
}

type MenuId = (typeof DIAGRAM_MENU)[number]["id"];

/** The kinds drawn by a library, later: each one's drawing and what it has already drawn. */
const RENDERERS = {
  mermaid: { render: renderMermaid, drawn: drawnMermaid },
  "vega-lite": { render: renderVegaLite, drawn: drawnVegaLite },
} as const;

/** What a picture of each kind is called, for its `alt` and its failure line. */
const NAMES: Record<
  DiagramKind,
  { readonly alt: string; readonly what: string }
> = {
  mermaid: { alt: "Mermaid diagram", what: "Diagram" },
  svg: { alt: "SVG image", what: "SVG" },
  "vega-lite": { alt: "Vega-Lite chart", what: "Chart" },
};

type Drawing = SvgResult | { readonly ok: "pending" };

const PENDING: Drawing = { ok: "pending" };

/** The picture for `code`, under `theme`: at once for an SVG, later for the rest. */
function useDrawing(
  kind: DiagramKind,
  code: string,
  theme: DiagramTheme,
): Drawing {
  const svg = useMemo(
    () => (kind === "svg" ? prepareSvg(code, { color: theme.ink }) : undefined),
    [kind, code, theme.ink],
  );
  const [later, setLater] = useState<
    { readonly code: string; readonly result: SvgResult } | undefined
  >(() => {
    if (kind === "svg") return undefined;
    const result = RENDERERS[kind].drawn(code, theme);
    return result === undefined ? undefined : { code, result };
  });
  useEffect(() => {
    if (kind === "svg") return;
    let current = true;
    void RENDERERS[kind].render(code, theme).then((result) => {
      if (current) setLater({ code, result });
    });
    return () => {
      current = false;
    };
  }, [kind, code, theme]);
  if (svg !== undefined) return svg;
  // A drawing in the last theme stands until this one's arrives, so a theme
  // change does not flash the code; a drawing of other words is not this one.
  if (later === undefined || later.code !== code) return PENDING;
  return later.result;
}

export const Diagram = memo(function Diagram({
  kind: previewKind,
  code,
  info,
  toggle,
}: PreviewProps) {
  const kind: DiagramKind =
    previewKind.id === "mermaid" || previewKind.id === "vega-lite"
      ? previewKind.id
      : "svg";
  const theme = useDiagramTheme();
  const drawing = useDrawing(kind, code, theme);

  if (drawing.ok === "pending") {
    return <CodeBlock code={code} info={info} settled />;
  }
  if (!drawing.ok) {
    return (
      <div className="conversation-diagram-failed">
        <CodeBlock code={code} info={info} settled />
        <p className="conversation-diagram-error" role="note">
          {NAMES[kind].what} not drawn: {drawing.error}
        </p>
      </div>
    );
  }
  return (
    <DrawnDiagram
      kind={kind}
      code={code}
      info={info}
      picture={drawing}
      toggle={toggle}
    />
  );
});

function DrawnDiagram({
  kind,
  code,
  info,
  picture,
  toggle,
}: {
  readonly kind: DiagramKind;
  readonly code: string;
  readonly info: string | undefined;
  readonly picture: PreparedSvg;
  readonly toggle: ReactNode;
}) {
  const { writeClipboard, writeClipboardImage } = useConversationActions();
  const url = useMemo(() => svgDataUrl(picture.svg), [picture.svg]);
  const [enlarged, setEnlarged] = useState(false);

  const copyImage = async (ground: string | undefined) => {
    const printed = await pictureForCopy(kind, code);
    await writeClipboardImage(
      await svgToPng(printed.svg, printed.size, ground),
    );
  };
  const run: Record<MenuId, () => Promise<void>> = {
    "copy-image-transparent": () => copyImage(undefined),
    "copy-image-white": () => copyImage(WHITE),
    "copy-source": () => writeClipboard(code),
  };

  return (
    <PreviewFigure
      kind={kind}
      language={headerLanguage(info, kind)}
      actions={toggle}
      copy={<CopyButton copy={() => copyImage(undefined)} label="Copy image" />}
      menu={DIAGRAM_MENU.map(({ id, label }) => ({ id, label, run: run[id] }))}
      enlarge={() => setEnlarged(true)}
    >
      <div
        className="conversation-diagram-picture"
        data-enlarge
        onClick={(event) => {
          if (opensLightbox(event)) setEnlarged(true);
        }}
      >
        <img
          src={url}
          width={picture.size.width}
          height={picture.size.height}
          alt={NAMES[kind].alt}
          draggable={false}
        />
      </div>
      {enlarged ? (
        <Lightbox label={NAMES[kind].alt} onClose={() => setEnlarged(false)}>
          <LightboxPicture
            src={url}
            alt={NAMES[kind].alt}
            width={picture.size.width}
            height={picture.size.height}
          />
        </Lightbox>
      ) : null}
    </PreviewFigure>
  );
}
