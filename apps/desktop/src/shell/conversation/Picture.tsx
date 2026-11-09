/**
 * A picture whose room is taken before it is decoded.
 *
 * An `<img>` has no size until its picture is decoded, and one inserted bare
 * grew into place a frame or more later, pushing everything after it down.
 * So every picture in a conversation is drawn one of two ways
 * (`docs/motion.md`, "Reserved space for late content"):
 *
 * - **Its size known** (`pictureSizeOfUrl`: read off the header of the bytes
 *   it is drawn from) — at that size, never wider than the column, its box
 *   there from the first frame.
 * - **Its size not known yet** — a file still being read, a picture from the
 *   web, a header that does not parse — in a box of a fixed shape, 4:3 at
 *   the column's width (`boxed`), the picture scaled down into it and never
 *   enlarged. The box keeps its place once the picture is known with one
 *   rule: a picture taller than 4:3 deepens it, at its foot and only once,
 *   to at most a square; one wider than that is drawn inside it. It never
 *   grows anywhere else and never shrinks — and a decode changes nothing.
 */

import { useMemo, useState, type MouseEvent } from "react";
import { pictureSizeOfUrl, type PictureSize } from "./imageSize";

/** The box's shape while the picture's is unknown: width over height. */
export const BOX_RATIO = 4 / 3;

/** The box's shape once the picture's is known: deepened, never widened. */
export function boxRatio(size: PictureSize | undefined): number {
  if (size === undefined) return BOX_RATIO;
  return Math.min(BOX_RATIO, Math.max(1, size.width / size.height));
}

export function Picture({
  src,
  alt,
  boxed,
  className,
  title,
  onClick,
}: {
  /** Undefined while the bytes are still on their way: the box alone. */
  readonly src: string | undefined;
  readonly alt: string;
  /**
   * Drawn in the fixed box even when its size can be read: a picture that
   * was a box while its file was read stays one, so arriving is not a jump.
   */
  readonly boxed: boolean;
  readonly className?: string;
  readonly title?: string;
  readonly onClick?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const known = useMemo(
    () => (src === undefined ? undefined : pictureSizeOfUrl(src)),
    [src],
  );
  // A picture from the web says its size only once it has loaded.
  const [loaded, setLoaded] = useState<PictureSize | undefined>(undefined);
  const extra = className === undefined ? "" : ` ${className}`;
  if (!boxed && known !== undefined && src !== undefined) {
    return (
      <img
        className={`conversation-picture${extra}`}
        src={src}
        alt={alt}
        title={title}
        width={known.width}
        height={known.height}
        draggable={false}
        onClick={onClick}
      />
    );
  }
  return (
    <span
      className={`conversation-picture-box${extra}`}
      style={{ aspectRatio: String(boxRatio(known ?? loaded)) }}
      title={title}
      onClick={onClick}
      aria-busy={src === undefined ? true : undefined}
    >
      {src === undefined ? null : (
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget;
            if (known === undefined && image.naturalWidth > 0) {
              setLoaded({
                width: image.naturalWidth,
                height: image.naturalHeight,
              });
            }
          }}
        />
      )}
    </span>
  );
}
