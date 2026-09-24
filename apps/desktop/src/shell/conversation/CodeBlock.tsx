import { memo, useEffect, useState, type CSSProperties } from "react";
import { CopyButton } from "./CopyButton";
import {
  colouringOf,
  grammarFor,
  highlight,
  type Colouring,
} from "./highlight";

/**
 * One fenced code block of an answer.
 *
 * `settled` says the fence has closed (see `markdownBlocks.ts`). Until it has,
 * the block is plain monospace; once it has, it is coloured — asynchronously,
 * because the grammar may still have to load, and drawn plain until then, so
 * the text is on screen and findable from the first frame either way.
 *
 * A failure to colour (a chunk that would not load) is not caught here: the
 * rejection reaches the page's root handler, and the block stays plain.
 */
export const CodeBlock = memo(function CodeBlock({
  code,
  info,
  settled,
}: {
  readonly code: string;
  readonly info: string | undefined;
  readonly settled: boolean;
}) {
  const grammar = settled ? grammarFor(info) : undefined;
  // The colouring itself is kept by `highlight`; this state only says that
  // one has arrived since the last draw, so the block draws again to show it.
  const [, setColoured] = useState<Colouring | undefined>(undefined);
  const lines = grammar === undefined ? undefined : colouringOf(code, grammar);

  useEffect(() => {
    if (grammar === undefined || lines !== undefined) return;
    let current = true;
    void highlight(code, grammar).then((colouring) => {
      if (current) setColoured(colouring);
    });
    return () => {
      current = false;
    };
  }, [code, grammar, lines]);

  const language = info?.trim().split(/\s+/, 1)[0];

  return (
    <div className="conversation-code" data-language={language || undefined}>
      <div className="conversation-code-header">
        <span className="conversation-code-language">{language}</span>
        <CopyButton text={code} label="Copy code" />
      </div>
      <pre data-highlighted={lines !== undefined || undefined}>
        <code>
          {lines === undefined
            ? code
            : lines.map((line, index) => (
                <span className="conversation-code-line" key={index}>
                  {line.map((token, at) =>
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
                  {index < lines.length - 1 ? "\n" : null}
                </span>
              ))}
        </code>
      </pre>
    </div>
  );
});
