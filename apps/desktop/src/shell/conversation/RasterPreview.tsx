/**
 * A picture file an answer embeds — a PNG a script wrote, a photo — drawn as
 * the image it is, from its own bytes (a `data:` URL), at its own size or
 * smaller, in a box of a fixed shape that is there while the file is still
 * being read (`code` empty) and that the picture's arrival only deepens
 * (`Picture.tsx`): nothing under it moves when the bytes arrive or decode. The copy puts it on the clipboard as a PNG
 * (as it is, or redrawn as one); a right-click offers the same.
 */

import { memo, useState } from "react";
import { Lightbox, LightboxPicture, opensLightbox } from "./Lightbox";
import { useConversationActions } from "./ConversationContext";
import { CopyButton } from "./CopyButton";
import type { PreviewProps } from "./Preview";
import { headerLanguage, PreviewFigure } from "./PreviewFigure";
import { Picture } from "./Picture";

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
  const reading = url === "";
  const copy = async () => {
    if (!reading) await writeClipboardImage(await pngOf(url));
  };
  const [enlarged, setEnlarged] = useState(false);
  const alt = info ?? "Image";
  return (
    <PreviewFigure
      kind="image"
      language={headerLanguage(info, "image")}
      actions={null}
      copy={<CopyButton copy={copy} label="Copy image" />}
      menu={[{ ...IMAGE_MENU[0], run: copy }]}
      enlarge={() => {
        if (!reading) setEnlarged(true);
      }}
    >
      <div
        className="conversation-diagram-picture"
        data-enlarge
        onClick={(event) => {
          if (!reading && opensLightbox(event)) setEnlarged(true);
        }}
      >
        <Picture src={reading ? undefined : url} alt={alt} boxed />
      </div>
      {enlarged ? (
        <Lightbox label={alt} onClose={() => setEnlarged(false)}>
          <LightboxPicture src={url} alt={alt} />
        </Lightbox>
      ) : null}
    </PreviewFigure>
  );
});
