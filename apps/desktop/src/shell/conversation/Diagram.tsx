/**
 * A ```mermaid or ```svg block of an answer, drawn as the picture it is.
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
 * The header is the code block's, quiet and icon-only: the language, a
 * toggle between the picture and its source, and a copy — of the picture as
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

import {
  memo,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
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
import { CodeIcon, DiagramIcon } from "./icons";
import { drawnMermaid, renderMermaid } from "./mermaid";

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
    kind === "mermaid"
      ? await renderMermaid(code, COPY_THEME)
      : prepareSvg(code, { color: COPY_THEME.ink });
  if (!result.ok) throw new Error(result.error);
  return result;
}

type MenuId = (typeof DIAGRAM_MENU)[number]["id"];

type Drawing = SvgResult | { readonly ok: "pending" };

const PENDING: Drawing = { ok: "pending" };

/** The picture for `code`, under `theme`: at once for an SVG, later for Mermaid. */
function useDrawing(
  kind: DiagramKind,
  code: string,
  theme: DiagramTheme,
): Drawing {
  const svg = useMemo(
    () => (kind === "svg" ? prepareSvg(code, { color: theme.ink }) : undefined),
    [kind, code, theme.ink],
  );
  const [mermaid, setMermaid] = useState<
    { readonly code: string; readonly result: SvgResult } | undefined
  >(() => {
    if (kind !== "mermaid") return undefined;
    const result = drawnMermaid(code, theme);
    return result === undefined ? undefined : { code, result };
  });
  useEffect(() => {
    if (kind !== "mermaid") return;
    let current = true;
    void renderMermaid(code, theme).then((result) => {
      if (current) setMermaid({ code, result });
    });
    return () => {
      current = false;
    };
  }, [kind, code, theme]);
  if (svg !== undefined) return svg;
  // A drawing in the last theme stands until this one's arrives, so a theme
  // change does not flash the code; a drawing of other words is not this one.
  if (mermaid === undefined || mermaid.code !== code) return PENDING;
  return mermaid.result;
}

export const Diagram = memo(function Diagram({
  kind,
  code,
  info,
}: {
  readonly kind: DiagramKind;
  readonly code: string;
  readonly info: string | undefined;
}) {
  const theme = useDiagramTheme();
  const drawing = useDrawing(kind, code, theme);
  const [showSource, setShowSource] = useState(false);

  if (drawing.ok === "pending") {
    return <CodeBlock code={code} info={info} settled />;
  }
  if (!drawing.ok) {
    return (
      <div className="conversation-diagram-failed">
        <CodeBlock code={code} info={info} settled />
        <p className="conversation-diagram-error" role="note">
          {kind === "mermaid" ? "Diagram" : "SVG"} not drawn: {drawing.error}
        </p>
      </div>
    );
  }
  const toggle = (
    <button
      type="button"
      className="conversation-copy conversation-diagram-toggle"
      aria-label={showSource ? "Show diagram" : "Show source"}
      title={showSource ? "Show diagram" : "Show source"}
      aria-pressed={showSource}
      onClick={() => setShowSource((shown) => !shown)}
    >
      {showSource ? <DiagramIcon /> : <CodeIcon />}
    </button>
  );
  if (showSource) {
    return <CodeBlock code={code} info={info} settled actions={toggle} />;
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
  const {
    writeClipboard,
    writeClipboardImage,
    showContextMenu,
    reportFailure,
  } = useConversationActions();
  const url = useMemo(() => svgDataUrl(picture.svg), [picture.svg]);
  const language = info?.trim().split(/\s+/, 1)[0] || kind;

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

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void showContextMenu({
      items: DIAGRAM_MENU.map(({ id, label }) => ({ id, label })),
      at: { x: event.clientX, y: event.clientY },
    })
      .then((chosen) =>
        chosen !== undefined && Object.hasOwn(run, chosen)
          ? run[chosen as MenuId]()
          : undefined,
      )
      .catch(reportFailure);
  };

  return (
    <figure
      className="conversation-diagram"
      data-kind={kind}
      onContextMenu={onContextMenu}
    >
      <div className="conversation-code-header">
        <span className="conversation-code-language">{language}</span>
        <span className="conversation-code-actions">
          {toggle}
          <CopyButton copy={() => copyImage(undefined)} label="Copy image" />
        </span>
      </div>
      <div className="conversation-diagram-picture">
        <img
          src={url}
          width={picture.size.width}
          height={picture.size.height}
          alt={kind === "mermaid" ? "Mermaid diagram" : "SVG image"}
          draggable={false}
        />
      </div>
    </figure>
  );
}
