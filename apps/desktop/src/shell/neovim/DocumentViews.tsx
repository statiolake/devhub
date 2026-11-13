/**
 * `gui.document` painted over its windows (`documents.ts`). This file is
 * the light part, on the page from its start; the document itself — the
 * conversation's Markdown renderer, KaTeX, Shiki, Mermaid on demand — is
 * its own chunk (`DocumentPane.tsx`), loaded the first time a document is
 * shown, so a pane that never shows one never loads it.
 */

import { lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import { rgbCss } from "./components";
import type { Layers } from "./layers";
import type { LayerHost } from "./LayerViews";

const DocumentPane = lazy(() => import("./DocumentPane"));

export function GuiDocuments({
  layers,
  host,
}: {
  readonly layers: Layers;
  readonly host: LayerHost;
}) {
  return (
    <>
      {layers.placedDocuments.map((place) => {
        const content = layers.documents.get(place.id);
        const box =
          host.boxes.find((b) => b.win === place.win) ??
          host.laidOut(place.win);
        if (!content || !box) return null;
        const { cell } = host;
        const ground = rgbCss(host.defaults.background);
        return createPortal(
          <div
            className={`nvim-document${place.current ? " nvim-document-current" : ""}`}
            data-document={place.id}
            data-win={place.win}
            style={{
              left: box.col * cell.width,
              top: box.row * cell.height,
              width: box.width * cell.width,
              height: box.height * cell.height,
              background: ground,
              ["--nvim-ground" as string]: ground,
            }}
          >
            <Suspense fallback={null}>
              <DocumentPane
                content={content}
                place={place}
                scroll={layers.documentScrolls.get(place.id)}
                activation={layers.documentActivations.get(place.id)}
                host={host}
                height={box.height * cell.height}
                width={box.width * cell.width}
              />
            </Suspense>
          </div>,
          host.over(box.grid, "covers"),
          `document:${String(place.id)}:${String(place.win)}`,
        );
      })}
    </>
  );
}
