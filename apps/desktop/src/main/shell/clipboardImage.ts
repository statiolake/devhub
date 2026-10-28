/**
 * A picture put on the Mac's clipboard: a diagram from a GUI Agent's answer,
 * which the page has already rasterised to a PNG
 * (`shell/conversation/diagramCopy.ts`).
 *
 * Main writes it for the reason it writes text (`writeClipboard`): the page's
 * own clipboard is gated on its document having the focus, and the Agents
 * view does not always have it at the moment of a click. What arrives is
 * checked before it reaches the pasteboard — bytes, a PNG's signature, a
 * bounded size, and an image `nativeImage` can decode — because a page is
 * not trusted to have sent what it says it sent.
 */

import { electron } from "../electron.js";

/** The eight bytes every PNG starts with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Far beyond any diagram at 2x; past it the page has sent something else. */
export const MAX_CLIPBOARD_PNG_BYTES = 64 * 1024 * 1024;

/** `value` as PNG bytes, or a thrown reason it is not one. */
export function clipboardPng(value: unknown): Buffer {
	if (!(value instanceof Uint8Array)) {
		throw new Error("The image to copy is not a sequence of bytes.");
	}
	if (value.byteLength > MAX_CLIPBOARD_PNG_BYTES) {
		throw new Error("The image to copy is too large.");
	}
	if (
		value.byteLength < PNG_SIGNATURE.length ||
		PNG_SIGNATURE.some((byte, at) => value[at] !== byte)
	) {
		throw new Error("The image to copy is not a PNG.");
	}
	return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Write the PNG `value` to the clipboard as an image, or throw why not. */
export function writeClipboardImage(value: unknown): void {
	const image = electron.nativeImage.createFromBuffer(clipboardPng(value));
	if (image.isEmpty()) {
		throw new Error("The image to copy could not be read.");
	}
	electron.clipboard.writeImage(image);
}
