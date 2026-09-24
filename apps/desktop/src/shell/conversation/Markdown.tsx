/**
 * An answer's Markdown, drawn.
 *
 * `react-markdown` with GitHub's extensions (tables, strikethrough, task
 * lists, autolinks). Raw HTML in the source is not drawn at all (`skipHtml`):
 * the text came out of a model, and the page will not become whatever markup
 * it chose to write. Elements are React components rather than an HTML string,
 * which is what lets a code block carry its own copy button and a link open
 * through the page's `openExternalUrl` instead of navigating this view away.
 *
 * While the answer streams, its source is drawn as two documents: the settled
 * prefix, memoized so a delta does not parse it again, and the tail, which is
 * re-parsed on every delta and whose code is not coloured (see
 * `markdownBlocks.ts`). Once it has finished it is drawn as the one document
 * it is — a split can only ever be a streaming approximation, because a
 * reference link or a loose list can reach across it.
 */

import { memo, type ReactNode } from "react";
import ReactMarkdown, {
  type Components,
  type ExtraProps,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";
import { useConversationActions } from "./ConversationContext";
import { settledLength } from "./markdownBlocks";

const REMARK_PLUGINS = [remarkGfm];

/** The syntax tree's element, as react-markdown hands it to a component. */
type Element = NonNullable<ExtraProps["node"]>;
type ElementContent = Element["children"][number];

function textOf(nodes: readonly ElementContent[]): string {
  let text = "";
  for (const node of nodes) {
    if (node.type === "text") text += node.value;
    else if (node.type === "element") text += textOf(node.children);
  }
  return text;
}

/** The info word of a `code` element: `language-ts` → `ts`. */
function languageOf(code: Element): string | undefined {
  const classes = code.properties.className;
  if (!Array.isArray(classes)) return undefined;
  for (const name of classes) {
    if (typeof name === "string" && name.startsWith("language-")) {
      return name.slice("language-".length);
    }
  }
  return undefined;
}

function ExternalLink({
  href,
  children,
}: {
  readonly href: string | undefined;
  readonly children?: ReactNode;
}) {
  const { openExternalUrl, reportFailure } = useConversationActions();
  return (
    <a
      href={href}
      onClick={(event) => {
        // The view is the Agents page; following a link in place would
        // replace it with the link's page.
        event.preventDefault();
        if (href) void openExternalUrl(href).catch(reportFailure);
      }}
    >
      {children}
    </a>
  );
}

function componentsFor(settled: boolean): Components {
  return {
    // A fenced or indented block: `pre > code`. Inline code stays `code`.
    pre({ node }) {
      const code = node?.children.find(
        (child): child is Element =>
          child.type === "element" && child.tagName === "code",
      );
      const text = code ? textOf(code.children) : "";
      return (
        <CodeBlock
          code={text.endsWith("\n") ? text.slice(0, -1) : text}
          info={code ? languageOf(code) : undefined}
          settled={settled}
        />
      );
    },
    a({ href, children }) {
      return <ExternalLink href={href}>{children}</ExternalLink>;
    },
    table({ children }) {
      // Wide tables scroll inside their own box rather than widening the
      // transcript.
      return (
        <div className="conversation-table">
          <table>{children}</table>
        </div>
      );
    },
  };
}

const SETTLED_COMPONENTS = componentsFor(true);
const UNSETTLED_COMPONENTS = componentsFor(false);

const MarkdownDocument = memo(function MarkdownDocument({
  source,
  settled,
}: {
  readonly source: string;
  readonly settled: boolean;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      skipHtml
      components={settled ? SETTLED_COMPONENTS : UNSETTLED_COMPONENTS}
    >
      {source}
    </ReactMarkdown>
  );
});

export function Markdown({
  source,
  streaming,
}: {
  readonly source: string;
  readonly streaming: boolean;
}) {
  if (!streaming) {
    return (
      <div className="conversation-markdown">
        <MarkdownDocument source={source} settled />
      </div>
    );
  }
  const split = settledLength(source);
  return (
    <div className="conversation-markdown" data-streaming>
      {split > 0 ? (
        <MarkdownDocument source={source.slice(0, split)} settled />
      ) : null}
      <MarkdownDocument source={source.slice(split)} settled={false} />
    </div>
  );
}
