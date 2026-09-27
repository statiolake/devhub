/**
 * The pieces a tool call and a request are drawn from: JSON as it came off the
 * wire, a unified diff, an image, a tool's output.
 */

import type {
  FileDiff,
  ImageRef,
  JsonValue,
  ToolOutput,
  ToolOutputPart,
} from "../../model/conversation";
import { useAgentCwd } from "./ConversationContext";

export function JsonView({ value }: { readonly value: JsonValue }) {
  // A bare string is shown as itself: a command line or a path reads better
  // without the quotes and escapes JSON would give it.
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="conversation-json">
      <code>{text}</code>
    </pre>
  );
}

type LineKind = "add" | "remove" | "hunk" | "context";

function lineKind(line: string): LineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "remove";
  return "context";
}

export interface DiffRow {
  readonly kind: LineKind;
  readonly text: string;
  /** The line's number in the file before and after, where the hunk says. */
  readonly old: number | undefined;
  readonly new: number | undefined;
}

/**
 * A unified diff as rows, each numbered as its hunk header says: a context
 * line in both files, a removed one in the old, an added one in the new. A
 * hunk without numbers (`@@` alone, a diff made from a call's input) numbers
 * nothing.
 */
export function diffRows(unifiedDiff: string): readonly DiffRow[] {
  let old: number | undefined;
  let next: number | undefined;
  return unifiedDiff.split("\n").map((text): DiffRow => {
    const kind = lineKind(text);
    if (kind === "hunk") {
      const numbers = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
      old = numbers === null ? undefined : Number(numbers[1]);
      next = numbers === null ? undefined : Number(numbers[2]);
      return { kind, text, old: undefined, new: undefined };
    }
    const row: DiffRow = {
      kind,
      text,
      old: kind === "add" ? undefined : old,
      new: kind === "remove" ? undefined : next,
    };
    if (kind !== "add" && old !== undefined) old += 1;
    if (kind !== "remove" && next !== undefined) next += 1;
    return row;
  });
}

/** A path inside the Agent's directory, relative to it; any other, whole. */
export function shownPath(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === "") return path;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/**
 * Each file's change: its path (relative to the Agent's directory when inside
 * it) over its lines, one row each, numbered where the diff says, a long line
 * wrapping under itself rather than running off to the side.
 */
export function DiffView({ files }: { readonly files: readonly FileDiff[] }) {
  const cwd = useAgentCwd();
  return (
    <div className="conversation-diff">
      {files.map((file, index) => (
        <div className="conversation-diff-file" key={`${index}:${file.path}`}>
          <div className="conversation-diff-path" title={file.path}>
            {shownPath(file.path, cwd)}
          </div>
          <div className="conversation-diff-lines">
            {diffRows(file.unifiedDiff).map((row, at) => (
              <div
                key={at}
                className="conversation-diff-line"
                data-line={row.kind}
              >
                <span className="conversation-diff-number" aria-hidden="true">
                  {row.old ?? ""}
                </span>
                <span className="conversation-diff-number" aria-hidden="true">
                  {row.new ?? ""}
                </span>
                <span className="conversation-diff-text">{row.text}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Where the page can read an image from: its own bytes, or an https URL. A
 * file on the Agent's machine, or a URL of another scheme, it does not open.
 */
export function imageUrl(image: ImageRef): string | undefined {
  switch (image.source.kind) {
    case "data":
      return `data:${image.mediaType};base64,${image.source.base64}`;
    case "url":
      return /^(?:data|https):/u.test(image.source.url)
        ? image.source.url
        : undefined;
    case "file":
      return undefined;
  }
}

/**
 * An image in the conversation, at a size that keeps the transcript
 * readable; opening it shows it whole. One the page cannot read is named
 * where it would be, never left out.
 */
export function ImageView({ image }: { readonly image: ImageRef }) {
  const url = imageUrl(image);
  if (url === undefined) {
    return (
      <div className="conversation-image-missing" title={image.label}>
        Image not shown here: {image.label}
      </div>
    );
  }
  return (
    <details className="conversation-image">
      <summary>
        <img src={url} alt={image.label} />
      </summary>
      <img className="conversation-image-whole" src={url} alt={image.label} />
    </details>
  );
}

function PartView({ part }: { readonly part: ToolOutputPart }) {
  switch (part.kind) {
    case "text":
      return (
        <pre className="conversation-output">
          <code>{part.text}</code>
        </pre>
      );
    case "image":
      return (
        <div className="conversation-output-image">
          <ImageView image={part.image} />
        </div>
      );
    case "reference":
      return (
        <div className="conversation-output-reference">
          Loaded the tool <code>{part.name}</code>
        </div>
      );
    case "command":
      return (
        <>
          {part.output !== "" ? (
            <pre className="conversation-output">
              <code>{part.output}</code>
            </pre>
          ) : null}
          {part.stderr !== undefined ? (
            <>
              <div className="conversation-tool-section">Stderr</div>
              <pre className="conversation-output" data-stream="stderr">
                <code>{part.stderr}</code>
              </pre>
            </>
          ) : null}
          {part.interrupted ? (
            <div className="conversation-output-note" data-failed="">
              Interrupted
            </div>
          ) : null}
          {part.exitCode !== undefined ? (
            <div
              className="conversation-output-note"
              data-failed={part.exitCode !== 0 || undefined}
            >
              Exit code {part.exitCode}
            </div>
          ) : null}
        </>
      );
    case "persisted":
      return (
        <>
          <div className="conversation-output-note" data-persisted="">
            {part.note}
            {part.path !== undefined && !part.note.includes(part.path) ? (
              <>
                {" "}
                <code>{part.path}</code>
              </>
            ) : null}
          </div>
          {part.preview !== "" ? (
            <pre className="conversation-output">
              <code>{part.preview}</code>
            </pre>
          ) : null}
        </>
      );
  }
}

export function OutputView({ output }: { readonly output: ToolOutput }) {
  return (
    <>
      {output.map((part, index) => (
        <PartView key={index} part={part} />
      ))}
    </>
  );
}
