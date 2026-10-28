/**
 * A diagram, as a PNG for the clipboard.
 *
 * The picture is an SVG drawn for pasting (`pictureForCopy`, in
 * `COPY_THEME`); it is loaded as an image — where nothing in it runs or
 * fetches — and painted on a canvas, transparent or filled with a ground, at
 * twice its size or the screen's pixel ratio if that is more, so a paste into
 * a document is sharp on a Retina display, with a margin around it. A side past
 * `MAX_CANVAS_SIDE` lowers the scale instead.
 *
 * The bytes go to main (`writeClipboardImage`), which writes the image: the
 * page's own clipboard is gated on the view having the focus.
 */

import { svgDataUrl, type SvgSize } from "./diagramSvg";

export const MAX_CANVAS_SIDE = 8192;
/** Room around the picture, in CSS pixels, so a paste does not crop it to its ink. */
export const PNG_MARGIN = 16;

/** The scale a picture of `size` is rasterised at. */
export function rasterScale(size: SvgSize, pixelRatio: number): number {
  const wanted = Math.max(2, pixelRatio || 1);
  const side = Math.max(size.width, size.height) + 2 * PNG_MARGIN;
  return Math.min(wanted, MAX_CANVAS_SIDE / side);
}

/** `svg` at `size`, on `background` (none: transparent), as PNG bytes. */
export async function svgToPng(
  svg: string,
  size: SvgSize,
  background: string | undefined,
  pixelRatio: number = window.devicePixelRatio,
): Promise<Uint8Array> {
  const image = new Image();
  image.decoding = "async";
  image.src = svgDataUrl(svg);
  await image.decode();
  const scale = rasterScale(size, pixelRatio);
  const canvas = document.createElement("canvas");
  const margin = PNG_MARGIN * scale;
  canvas.width = Math.max(1, Math.round(size.width * scale + 2 * margin));
  canvas.height = Math.max(1, Math.round(size.height * scale + 2 * margin));
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("There is no canvas to draw on.");
  if (background !== undefined) {
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(
    image,
    margin,
    margin,
    size.width * scale,
    size.height * scale,
  );
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (blob === null) throw new Error("The diagram could not be made a PNG.");
  return new Uint8Array(await blob.arrayBuffer());
}
