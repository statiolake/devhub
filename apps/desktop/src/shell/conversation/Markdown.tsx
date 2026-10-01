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
 * A path in the prose or in inline code that names a file on the Agent's
 * machine is a link to it, and so is an Issue or pull request reference
 * (`LinkedText.tsx`); one in a fenced block is code and is left alone. Only a
 * settled document is looked through: a path still being written would be
 * asked about one keystroke at a time.
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
import { useAgentCwd, useConversationActions } from "./ConversationContext";
import { settledLength } from "./markdownBlocks";
import { LinkedText } from "./LinkedText";
import { linkSpans, pathOfHref, rangeSuffix } from "./textLinks";

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

/**
 * A link the Agent gave, opened outside DevHub, never in place of the page —
 * or, when its target is a file rather than a page (`pathOfHref`), opened in
 * the editor the way a path in the prose is. A file link that main finds no
 * file for says so instead of handing the browser something that is not a URL.
 */
export function ExternalLink({
  href,
  children,
}: {
  readonly href: string | undefined;
  readonly children?: ReactNode;
}) {
  const { openExternalUrl, resolvePaths, openFile, reportFailure } =
    useConversationActions();
  const cwd = useAgentCwd();
  const file = href === undefined ? undefined : pathOfHref(href);
  if (file !== undefined) {
    return (
      <a
        href="#"
        className="conversation-path-link"
        title={`Open ${file.path}${rangeSuffix(file.range)} in the editor`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void (async () => {
            const [found] = await resolvePaths(cwd, [file.path]);
            if (typeof found !== "string") {
              throw new Error(
                `There is no file ${file.path} on the Agent's machine.`,
              );
            }
            await openFile(found, file.range);
          })().catch(reportFailure);
        }}
      >
        {children}
      </a>
    );
  }
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

/** The element a stretch of prose with a link in it is wrapped in, for `span` to draw. */
const LINKS = "dataConversationLinks";

/**
 * Wrap every text of the document that has a link candidate in it — outside
 * a fenced block and outside a link — in a `span` the component below draws
 * with `LinkedText`. Only the wrapping is done here; which words are links is
 * decided when it is drawn.
 */
function rehypeLinks() {
  const visit = (parent: { children: ElementContent[] }) => {
    parent.children = parent.children.map((child): ElementContent => {
      if (child.type === "element") {
        if (child.tagName !== "pre" && child.tagName !== "a") visit(child);
        return child;
      }
      if (child.type !== "text" || linkSpans(child.value).length === 0)
        return child;
      return {
        type: "element",
        tagName: "span",
        properties: { [LINKS]: "" },
        children: [child],
      };
    });
  };
  return (tree: { children: ElementContent[] }) => visit(tree);
}

const REHYPE_PLUGINS = [rehypeLinks];

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
    span({ node, children }) {
      // Raw HTML is skipped, so every span is one `rehypeLinks` made.
      if (node === undefined || !(LINKS in node.properties))
        return <span>{children}</span>;
      return <LinkedText text={textOf(node.children)} />;
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
      rehypePlugins={settled ? REHYPE_PLUGINS : undefined}
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
