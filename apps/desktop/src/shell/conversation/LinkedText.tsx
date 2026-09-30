/**
 * Text from the conversation with its links drawn: each file path that names
 * a file (`pathLinks.tsx`) and each GitHub Issue or pull request reference
 * (`issueLinks.tsx`), found in one pass over it (`textLinks.ts`).
 *
 * Drawn wherever the Agent points at something: its prose and inline code
 * once its block has settled, a tool call's title and its output, and a
 * diff's file header. Not a fenced code block in an answer: that is code, and
 * a word in it that happens to be a file or a `#12` is not the Agent pointing
 * at it.
 */

import { useMemo, type ReactNode } from "react";
import { IssueLink } from "./issueLinks";
import { PathLink } from "./pathLinks";
import { linkSpans } from "./textLinks";

export function LinkedText({ text }: { readonly text: string }) {
  const spans = useMemo(() => linkSpans(text), [text]);
  if (spans.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at) parts.push(text.slice(at, span.start));
    const shown = text.slice(span.start, span.end);
    parts.push(
      span.kind === "path" ? (
        <PathLink key={span.start} candidate={span}>
          {shown}
        </PathLink>
      ) : (
        <IssueLink key={span.start} reference={span}>
          {shown}
        </IssueLink>
      ),
    );
    at = span.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
