/**
 * A ```diff / ```patch block, or a .diff / .patch file, drawn as the change it
 * is (`patch.ts`): each file under a header naming it (and what happened to
 * it: added, deleted, renamed from), its lines numbered as the hunks say, the
 * removed on red and the added on green, in the colours of the file's
 * language where DevHub colours it (`highlight.ts`). The tool calls' diffs
 * are drawn from the same rows (`diffRows` in `EntryParts.tsx`).
 *
 * The header holds the toggle to the source, a toggle between the lines
 * inline and side by side (old on the left, new on the right), and a copy of
 * the patch. A right-click offers the patch too.
 */

import {
  memo,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useConversationActions } from "./ConversationContext";
import { CopyButton } from "./CopyButton";
import { extensionOf } from "./previewKinds";
import {
  colouringOf,
  grammarFor,
  highlight,
  type Colouring,
  type GrammarId,
  type Token,
} from "./highlight";
import {
  parsePatch,
  patchSides,
  splitRows,
  type PatchFile,
  type PatchRow,
} from "./patch";
import type { PreviewProps } from "./Preview";
import { headerLanguage, PreviewFigure } from "./PreviewFigure";
import { ColumnIcon, RowsIcon } from "./icons";

export const DIFF_MENU = [{ id: "copy-source", label: "Copy Patch" }] as const;

/** The colouring of `code`, once it has arrived; `undefined` until then. */
function useColouring(
  code: string,
  grammar: GrammarId | undefined,
): Colouring | undefined {
  const [, setArrived] = useState<Colouring | undefined>(undefined);
  const colouring =
    grammar === undefined ? undefined : colouringOf(code, grammar);
  useEffect(() => {
    if (grammar === undefined || colouring !== undefined) return;
    let current = true;
    void highlight(code, grammar).then((made) => {
      if (current) setArrived(made);
    });
    return () => {
      current = false;
    };
  }, [code, grammar, colouring]);
  return colouring;
}

function Tokens({
  text,
  tokens,
}: {
  readonly text: string;
  readonly tokens: readonly Token[] | undefined;
}) {
  if (tokens === undefined) return <>{text}</>;
  return (
    <>
      {tokens.map((token, at) =>
        token.light === undefined && token.dark === undefined ? (
          token.text
        ) : (
          <span
            key={at}
            style={
              {
                "--code-light": token.light ?? "currentColor",
                "--code-dark": token.dark ?? "currentColor",
              } as CSSProperties
            }
          >
            {token.text}
          </span>
        ),
      )}
    </>
  );
}

const STATUS: Record<PatchFile["status"], string | undefined> = {
  modified: undefined,
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
};

function FileChange({
  file,
  split,
}: {
  readonly file: PatchFile;
  readonly split: boolean;
}) {
  const { rows, oldText, newText } = useMemo(
    () => patchSides(file.hunks),
    [file.hunks],
  );
  const grammar = grammarFor(extensionOf(file.path).slice(1));
  const oldColours = useColouring(oldText, grammar);
  const newColours = useColouring(newText, grammar);
  const tokensOf = (row: PatchRow, side: "old" | "new") =>
    side === "old"
      ? row.oldAt === undefined
        ? undefined
        : oldColours?.[row.oldAt]
      : row.newAt === undefined
        ? undefined
        : newColours?.[row.newAt];

  const text = (row: PatchRow, side: "old" | "new"): ReactNode => {
    if (row.kind === "hunk") return row.text;
    const mark = row.text.slice(0, 1);
    return (
      <>
        {mark}
        <Tokens text={row.text.slice(1)} tokens={tokensOf(row, side)} />
      </>
    );
  };

  const status = STATUS[file.status];
  return (
    <div className="conversation-diff-file">
      <div className="conversation-diff-path" title={file.path}>
        {file.from === undefined ? null : (
          <span className="conversation-diff-from">{file.from} → </span>
        )}
        {file.path || "(no file named)"}
        {status === undefined ? null : (
          <span className="conversation-diff-status" data-status={file.status}>
            {status}
          </span>
        )}
      </div>
      {rows.length === 0 || file.hunks === "" ? (
        file.binary ? (
          <div className="conversation-diff-binary">Binary file changed.</div>
        ) : null
      ) : split ? (
        <div className="conversation-diff-lines" data-split>
          {splitRows(rows).map((row, at) =>
            row.hunk !== undefined ? (
              <div key={at} className="conversation-diff-line" data-line="hunk">
                <span className="conversation-diff-text">{row.hunk}</span>
              </div>
            ) : (
              <div key={at} className="conversation-diff-pair">
                {[row.left, row.right].map((half, side) => (
                  <div
                    key={side}
                    className="conversation-diff-line"
                    data-line={half?.kind ?? "empty"}
                  >
                    <span
                      className="conversation-diff-number"
                      aria-hidden="true"
                    >
                      {(side === 0 ? half?.old : half?.new) ?? ""}
                    </span>
                    <span className="conversation-diff-text">
                      {half === undefined
                        ? null
                        : text(half, side === 0 ? "old" : "new")}
                    </span>
                  </div>
                ))}
              </div>
            ),
          )}
        </div>
      ) : (
        <div className="conversation-diff-lines">
          {rows.map((row, at) => (
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
              <span className="conversation-diff-text">
                {text(row, row.kind === "remove" ? "old" : "new")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const DiffPreview = memo(function DiffPreview({
  code,
  info,
  toggle,
}: PreviewProps) {
  const { writeClipboard } = useConversationActions();
  const files = useMemo(() => parsePatch(code), [code]);
  const [split, setSplit] = useState(false);
  const layout = split ? "Show inline" : "Show side by side";
  return (
    <PreviewFigure
      kind="diff"
      language={headerLanguage(info, "diff")}
      actions={
        <>
          {toggle}
          <button
            type="button"
            className="conversation-copy conversation-preview-toggle"
            aria-label={layout}
            title={layout}
            aria-pressed={split}
            onClick={() => setSplit((shown) => !shown)}
          >
            {split ? <RowsIcon /> : <ColumnIcon />}
          </button>
        </>
      }
      copy={<CopyButton text={code} label="Copy patch" />}
      menu={[{ ...DIFF_MENU[0], run: () => writeClipboard(code) }]}
      className="conversation-diff-preview"
    >
      <div className="conversation-diff">
        {files.map((file, at) => (
          <FileChange key={`${at}:${file.path}`} file={file} split={split} />
        ))}
      </div>
    </PreviewFigure>
  );
});
