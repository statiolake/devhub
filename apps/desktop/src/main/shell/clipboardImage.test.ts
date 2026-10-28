import { beforeEach, describe, expect, it, vi } from "vitest";

const written: unknown[] = [];
let decodes = true;

vi.mock("../electron.js", () => ({
	electron: {
		nativeImage: {
			createFromBuffer: (buffer: Buffer) => ({
				buffer,
				isEmpty: () => !decodes,
			}),
		},
		clipboard: {
			writeImage: (image: unknown) => {
				written.push(image);
			},
		},
	},
}));

const { clipboardPng, writeClipboardImage, MAX_CLIPBOARD_PNG_BYTES } =
	await import("./clipboardImage.js");

const PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
]);

beforeEach(() => {
	written.length = 0;
	decodes = true;
});

describe("a picture put on the clipboard", () => {
	it("writes a PNG as an image", () => {
		writeClipboardImage(PNG);
		expect(written).toHaveLength(1);
		expect([...(written[0] as { buffer: Buffer }).buffer]).toEqual([...PNG]);
	});

	it("refuses what is not PNG bytes, and writes nothing", () => {
		expect(() => clipboardPng("iVBORw0KGgo=")).toThrow(/bytes/);
		expect(() => clipboardPng(Uint8Array.from([1, 2, 3]))).toThrow(/PNG/);
		expect(() =>
			clipboardPng(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0, 0, 0, 0, 0])),
		).toThrow(/PNG/);
		const big = new Uint8Array(MAX_CLIPBOARD_PNG_BYTES + 1);
		big.set(PNG);
		expect(() => clipboardPng(big)).toThrow(/too large/);
		expect(written).toEqual([]);
	});

	it("refuses a PNG that does not decode", () => {
		decodes = false;
		expect(() => writeClipboardImage(PNG)).toThrow(/could not be read/);
		expect(written).toEqual([]);
	});
});
