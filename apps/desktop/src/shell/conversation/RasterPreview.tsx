/**
 * A picture file an answer embeds — a PNG a script wrote, a photo — drawn as
 * the image it is, from its own bytes (a `data:` URL), at its own size and
 * never wider than the column. The copy puts it on the clipboard as a PNG
 * (as it is, or redrawn as one); a right-click offers the same.
 */

import { memo } from "react";
import { useConversationActions } from "./ConversationContext";
import { CopyButton } from "./CopyButton";
import type { PreviewProps } from "./Preview";
import { headerLanguage, PreviewFigure } from "./PreviewFigure";

export const IMAGE_MENU = [{ id: "copy-image", label: "Copy Image" }] as const;

/** The image at `url` as PNG bytes: its own, when it is a PNG already. */
export async function pngOf(url: string): Promise<Uint8Array> {
  const comma = url.indexOf(",");
  if (url.startsWith("data:image/png;base64,")) {
    return Uint8Array.from(atob(url.slice(comma + 1)), (c) => c.charCodeAt(0));
  }
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("There is no canvas to draw on.");
  context.drawImage(image, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (blob === null) throw new Error("The image could not be made a PNG.");
  return new Uint8Array(await blob.arrayBuffer());
}

export const RasterPreview = memo(function RasterPreview({
  code: url,
  info,
}: PreviewProps) {
  const { writeClipboardImage } = useConversationActions();
  const copy = async () => writeClipboardImage(await pngOf(url));
  return (
    <PreviewFigure
      kind="image"
      language={headerLanguage(info, "image")}
      actions={null}
      copy={<CopyButton copy={copy} label="Copy image" />}
      menu={[{ ...IMAGE_MENU[0], run: copy }]}
    >
      <div className="conversation-diagram-picture">
        <img src={url} alt={info ?? "Image"} draggable={false} />
      </div>
    </PreviewFigure>
  );
});
