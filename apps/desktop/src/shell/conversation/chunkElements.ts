/**
 * The transcript's top-level entries as elements, wherever they are drawn: in
 * the transcript itself, or in its chunks (`entryChunks.tsx`), which stand in
 * a container of their own before the transcript's last lines. What walks
 * the drawn transcript — following the scroll, marking what arrived, finding
 * words — looks through the container and the chunks as if their entries
 * stood in their place.
 */

/** The class of the container the chunks are in. */
export const CHUNKS_CLASS = "conversation-chunks";

/** The class that marks a chunk. */
export const CHUNK_CLASS = "conversation-chunk";

/** Whether `node` is the chunks' container or a chunk: looked through, not at. */
export function isChunk(node: Node): boolean {
  return (
    node instanceof HTMLElement &&
    (node.classList.contains(CHUNK_CLASS) ||
      node.classList.contains(CHUNKS_CLASS))
  );
}

/** The top-level elements under `content`, in order, the chunks' in their place. */
export function* topLevelElements(content: Element): Generator<HTMLElement> {
  for (const child of content.children) {
    if (isChunk(child)) yield* topLevelElements(child);
    else yield child as HTMLElement;
  }
}

/** The top-level entry `id` under `content`, if it is drawn. */
export function topLevelEntry(
  content: Element,
  id: string,
): HTMLElement | undefined {
  const name = CSS.escape(id);
  return (
    content.querySelector<HTMLElement>(
      `:scope > [data-entry-id="${name}"], :scope > .${CHUNKS_CLASS} > .${CHUNK_CLASS} > [data-entry-id="${name}"]`,
    ) ?? undefined
  );
}

/** Whether `node` is a top-level part of `root`: its child, or a chunk's. */
export function isTopLevel(node: Node, root: Node): boolean {
  const parent = node.parentNode;
  if (parent === root) return true;
  return parent !== null && isChunk(parent) && isTopLevel(parent, root);
}
