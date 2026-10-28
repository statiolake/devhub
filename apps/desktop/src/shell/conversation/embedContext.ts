/**
 * Where an embedded file's drawing is from (`FileEmbed.tsx`), for the frame
 * it is drawn in: the header names the file, a click on the name opens it in
 * the editor, and a path inside it (a Markdown file's own `![](…)`) is
 * relative to its folder.
 */

import { createContext, useContext } from "react";

export interface EmbedSource {
  /** The path as the answer wrote it, which is what the header says. */
  readonly shown: string;
  /** The file on the Agent's machine. */
  readonly absolute: string;
  readonly open: () => void;
}

/** The file whose drawing this is; `undefined` for a fence, and inside a drawing. */
export const EmbedSourceContext = createContext<EmbedSource | undefined>(
  undefined,
);

export function useEmbedSource(): EmbedSource | undefined {
  return useContext(EmbedSourceContext);
}

/**
 * The folder a relative embed is found in: the embedding file's, inside a
 * Markdown file; the Agent's, in an answer (`undefined`).
 */
export const EmbedBaseContext = createContext<string | undefined>(undefined);
