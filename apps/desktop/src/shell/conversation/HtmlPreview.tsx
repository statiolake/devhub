/**
 * A ```html block, or an .html file an answer embeds, drawn as the page it
 * is — inside a frame that can do nothing but be looked at.
 *
 * The page was written by an Agent, so it is shown the one way a browser
 * shows a stranger's page without trusting it: an `<iframe>` of its source
 * (`srcdoc`) with `sandbox` and no permission at all — no script, no form, no
 * popup, no same origin, so it cannot reach this page, its storage or its
 * bridge — under a Content Security Policy (`HTML_CSP`) that lets it load
 * nothing but what it carries in itself (`data:` images, fonts and styles).
 * The policy is the first thing in its document and is also asked of the
 * frame (`csp`), and a navigation of the frame away from its own document is
 * refused by main (`externalLinks.ts`), so a link or a `<meta refresh>` goes
 * nowhere either.
 *
 * With no script the frame cannot say how tall its page is, so it is a fixed
 * height that the person can drag taller (`resize`), and scrolls inside.
 */

import { memo, useMemo } from "react";
import { useConversationActions } from "./ConversationContext";
import { CopyButton } from "./CopyButton";
import type { PreviewProps } from "./Preview";
import { headerLanguage, PreviewFigure } from "./PreviewFigure";

/** What a previewed page may load: only what it carries. */
export const HTML_CSP = [
  "default-src 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
].join("; ");

/** The frame's permissions: none. */
export const HTML_SANDBOX = "";

/** A page past this many characters is drawn as its source, with why. */
export const MAX_HTML_SOURCE = 2 * 1024 * 1024;

/**
 * `html` as the document the frame shows: the policy first — before anything
 * the page says could load — then the page, unchanged. A fragment is given a
 * document around it, in the light scheme a page has by default.
 */
export function htmlDocument(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">`;
  const head = `${policy}<meta charset="utf-8"><base target="_blank">`;
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(html);
  if (doctype !== null) {
    return `${doctype[0]}${head}${html.slice(doctype[0].length)}`;
  }
  if (/^\s*<html[\s>]/iu.test(html)) return `<!doctype html>${head}${html}`;
  return `<!doctype html>${head}<style>:root{color-scheme:light;font-family:system-ui,sans-serif}</style>${html}`;
}

export const HTML_MENU = [{ id: "copy-source", label: "Copy Source" }] as const;

/** The frame itself, at whatever size its box gives it. */
export function HtmlFrame({
  code,
  title,
  className,
}: {
  readonly code: string;
  readonly title: string;
  readonly className?: string;
}) {
  const document = useMemo(() => htmlDocument(code), [code]);
  // `csp` (embedded enforcement) is not in React's types; it is passed as is.
  const csp = { csp: HTML_CSP } as Record<string, string>;
  return (
    <iframe
      className={className ?? "conversation-html-frame"}
      title={title}
      sandbox={HTML_SANDBOX}
      srcDoc={document}
      referrerPolicy="no-referrer"
      loading="lazy"
      {...csp}
    />
  );
}

export const HtmlPreview = memo(function HtmlPreview({
  code,
  info,
  toggle,
}: PreviewProps) {
  const { writeClipboard } = useConversationActions();
  const tooLarge = code.length > MAX_HTML_SOURCE;
  return (
    <PreviewFigure
      kind="html"
      language={headerLanguage(info, "html")}
      actions={toggle}
      copy={<CopyButton text={code} label="Copy HTML" />}
      menu={[{ ...HTML_MENU[0], run: () => writeClipboard(code) }]}
      className="conversation-html-preview"
    >
      {tooLarge ? (
        <p className="conversation-diagram-error" role="note">
          Page not shown: it is too large ({Math.round(code.length / 1024)} KB).
        </p>
      ) : (
        <div className="conversation-html-stage">
          <HtmlFrame code={code} title="HTML preview" />
        </div>
      )}
    </PreviewFigure>
  );
});
