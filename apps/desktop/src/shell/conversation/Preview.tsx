/**
 * A block of an answer drawn as what it says: the one mechanism every
 * previewable kind (`previewKinds.ts`) is drawn through.
 *
 * `FencePreview` holds what all of them share — which of the drawing and its
 * source is shown, and the icon-only toggle between them — and hands the
 * drawing to the kind's own component (`PREVIEWS`). Each of those draws
 * itself inside a `PreviewFigure` (`PreviewFigure.tsx`). A kind
 * that cannot draw what it was given — still loading, or a source that does
 * not parse — draws its source instead, as code, with a line saying why when
 * it failed.
 */

import { memo, useState, type ComponentType, type ReactNode } from "react";
import { CodeBlock } from "./CodeBlock";
import { Diagram } from "./Diagram";
import { MarkdownPreview } from "./MarkdownPreview";
import { MarpPreview } from "./MarpPreview";
import { CodeIcon, DiagramIcon, DocumentIcon, SlidesIcon } from "./icons";
import type { PreviewKind, PreviewKindId } from "./previewKinds";

export interface PreviewProps {
  readonly kind: PreviewKind;
  readonly code: string;
  /** The fence's info string, for the header; a file's name is passed as one. */
  readonly info: string | undefined;
  /** The toggle to the source, for the header. */
  readonly toggle: ReactNode;
  /** How many Markdown previews this one is inside. */
  readonly depth: number;
  /** Markdown drawn by the conversation's own renderer, one level deeper. */
  readonly renderMarkdown: (source: string) => ReactNode;
}

const PREVIEWS: Record<PreviewKindId, ComponentType<PreviewProps>> = {
  svg: Diagram,
  mermaid: Diagram,
  markdown: MarkdownPreview,
  marp: MarpPreview,
};

const ICONS: Record<PreviewKindId, () => ReactNode> = {
  svg: DiagramIcon,
  mermaid: DiagramIcon,
  markdown: DocumentIcon,
  marp: SlidesIcon,
};

export const FencePreview = memo(function FencePreview({
  kind,
  code,
  info,
  depth,
  renderMarkdown,
}: {
  readonly kind: PreviewKind;
  readonly code: string;
  readonly info: string | undefined;
  readonly depth: number;
  readonly renderMarkdown: (source: string) => ReactNode;
}) {
  const [showSource, setShowSource] = useState(kind.defaultView === "source");
  const Icon = ICONS[kind.id];
  const label = showSource ? kind.showLabel : "Show source";
  const toggle = (
    <button
      type="button"
      className="conversation-copy conversation-preview-toggle"
      aria-label={label}
      title={label}
      aria-pressed={showSource}
      onClick={() => setShowSource((shown) => !shown)}
    >
      {showSource ? <Icon /> : <CodeIcon />}
    </button>
  );
  const Drawn = PREVIEWS[kind.id];
  // The drawing stays drawn while its source is shown, so going back to it
  // is the same picture (the same slide) rather than a fresh drawing.
  return (
    <>
      {showSource ? (
        <CodeBlock code={code} info={info} settled actions={toggle} />
      ) : null}
      <div className="conversation-preview-slot" hidden={showSource}>
        <Drawn
          kind={kind}
          code={code}
          info={info}
          toggle={toggle}
          depth={depth}
          renderMarkdown={renderMarkdown}
        />
      </div>
    </>
  );
});
