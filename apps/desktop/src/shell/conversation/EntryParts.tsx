/**
 * The pieces a tool call and a request are drawn from: JSON as it came off the
 * wire, a unified diff, a tool's output.
 */

import type { FileDiff, JsonValue, ToolOutput } from "../../model/conversation";

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

function lineKind(line: string): "add" | "remove" | "hunk" | "context" {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "remove";
  return "context";
}

export function DiffView({ files }: { readonly files: readonly FileDiff[] }) {
  return (
    <div className="conversation-diff">
      {files.map((file, index) => (
        <div className="conversation-diff-file" key={`${index}:${file.path}`}>
          <div className="conversation-diff-path">{file.path}</div>
          <pre>
            <code>
              {file.unifiedDiff.split("\n").map((line, at, lines) => (
                <span
                  key={at}
                  className="conversation-diff-line"
                  data-line={lineKind(line)}
                >
                  {line}
                  {at < lines.length - 1 ? "\n" : null}
                </span>
              ))}
            </code>
          </pre>
        </div>
      ))}
    </div>
  );
}

export function OutputView({ output }: { readonly output: ToolOutput }) {
  switch (output.kind) {
    case "text":
      return (
        <>
          <pre className="conversation-output">
            <code>{output.text}</code>
          </pre>
          {output.truncated ? (
            <div className="conversation-output-note">
              The Agent shortened this output.
            </div>
          ) : null}
        </>
      );
    case "command":
      return (
        <>
          <pre className="conversation-output">
            <code>{output.output}</code>
          </pre>
          {output.exitCode !== undefined ? (
            <div
              className="conversation-output-note"
              data-failed={output.exitCode !== 0 || undefined}
            >
              Exit code {output.exitCode}
            </div>
          ) : null}
        </>
      );
    case "diff":
      return <DiffView files={output.files} />;
  }
}
