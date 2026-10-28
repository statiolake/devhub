/**
 * A ```markdown (or ```md) block, or a Markdown file an answer embeds, drawn
 * as the document it is: by the conversation's own renderer, one level deeper
 * (`renderMarkdown`, `MAX_PREVIEW_DEPTH`), in a frame of its own so it reads
 * as a document quoted in the answer rather than as more of the answer.
 *
 * The copy puts the Markdown on the clipboard as its text, with the drawn
 * document beside it as HTML: an editor pastes the source, a document or a
 * mail pastes it formatted. A right-click offers the source alone.
 */

import { memo, useRef } from "react";
import { useConversationActions } from "./ConversationContext";
import { CopyButton } from "./CopyButton";
import { EmbedSourceContext } from "./embedContext";
import type { PreviewProps } from "./Preview";
import { headerLanguage, PreviewFigure } from "./PreviewFigure";

export const MARKDOWN_MENU = [
  { id: "copy-source", label: "Copy Source" },
] as const;

/**
 * The drawn document as HTML for another application: what it reads, without
 * the controls the conversation draws around blocks (headers, buttons).
 */
export function richHtmlOf(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const control of copy.querySelectorAll(
    ".conversation-code-header, button, .conversation-hidden-text",
  )) {
    control.remove();
  }
  return copy.innerHTML;
}

export const MarkdownPreview = memo(function MarkdownPreview({
  code,
  info,
  toggle,
  renderMarkdown,
}: PreviewProps) {
  const { writeClipboard, writeClipboardRich } = useConversationActions();
  const body = useRef<HTMLDivElement>(null);
  const copy = async () => {
    const html = body.current === null ? undefined : richHtmlOf(body.current);
    await (html === undefined
      ? writeClipboard(code)
      : writeClipboardRich({ text: code, html }));
  };
  return (
    <PreviewFigure
      kind="markdown"
      language={headerLanguage(info, "markdown")}
      actions={toggle}
      copy={<CopyButton copy={copy} label="Copy Markdown" />}
      menu={[
        {
          ...MARKDOWN_MENU[0],
          run: () => writeClipboard(code),
        },
      ]}
      className="conversation-markdown-preview"
    >
      <div className="conversation-markdown-preview-body" ref={body}>
        {/* The blocks inside are the document's, not the file's. */}
        <EmbedSourceContext.Provider value={undefined}>
          {renderMarkdown(code)}
        </EmbedSourceContext.Provider>
      </div>
    </PreviewFigure>
  );
});
