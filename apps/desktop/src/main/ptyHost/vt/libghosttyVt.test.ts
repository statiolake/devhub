import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { LibGhosttyVt, type VtFrame, type VtPane } from "./libghosttyVt.js";

const WASM = fileURLToPath(
	new URL("../../../../vendor/libghostty-vt/ghostty-vt.wasm", import.meta.url),
);

let lib: LibGhosttyVt;
beforeAll(async () => {
	lib = await LibGhosttyVt.load(readFileSync(WASM));
});

const enc = (text: string) => new TextEncoder().encode(text);
const rowText = (frame: VtFrame, y: number) =>
	frame.dirty
		.find((row) => row.y === y)
		?.cells.join("")
		.trimEnd();

function pane(cols = 20, rows = 4): VtPane {
	return lib.open(cols, rows, 100);
}

describe("libghostty-vt binding", () => {
	it("loads the vendored build and says which it is", () => {
		expect(lib.version).toBe("1.0.0");
	});

	it("reads every row on the first read, then only what changed", () => {
		const p = pane();
		p.write(enc("hello\r\nworld"));
		const first = p.read();
		expect(first.full).toBe(true);
		expect(rowText(first, 0)).toBe("hello");
		expect(rowText(first, 1)).toBe("world");
		expect(first.cursor).toMatchObject({ x: 5, y: 1, visible: true });
		p.write(enc("!"));
		const second = p.read();
		expect(second.full).toBe(false);
		expect(second.dirty.map((row) => row.y)).toEqual([1]);
		expect(rowText(second, 1)).toBe("world!");
		expect(p.read().dirty).toEqual([]);
		p.dispose();
	});

	it("lays graphemes out as tmux does: a skin-toned emoji, a ZWJ family and a flag are two cells", () => {
		const p = pane();
		p.write(enc("👍🏽|👨‍👩‍👧|🇯🇵|é|"));
		const row = p.read(true).dirty[0];
		expect(row.cells.slice(0, 11)).toEqual([
			"👍🏽",
			"",
			"|",
			"👨‍👩‍👧",
			"",
			"|",
			"🇯🇵",
			"",
			"|",
			"e\u0301",
			"|",
		]);
		// A reset (`ESC c`) turns mode 2027 off; the binding turns it on again.
		p.write(enc("\x1bc👍🏽|"));
		expect(p.read(true).dirty[0].cells.slice(0, 3)).toEqual(["👍🏽", "", "|"]);
		p.dispose();
	});

	it("interns styles: default cells are 0, the same look is one id", () => {
		const p = pane();
		p.setColors({
			foreground: 0xd0d0d0,
			background: 0x101010,
			palette: Array.from({ length: 256 }, (_, i) => i),
		});
		p.write(enc("a\x1b[1;31mb\x1b[38;2;1;2;3;4mc\x1b[0m\x1b[1;31md"));
		const frame = p.read();
		const styles = new Map(frame.styles);
		const ids = Array.from(frame.dirty[0].styles.subarray(0, 4));
		expect(ids[0]).toBe(0);
		expect(ids[1]).toBe(ids[3]);
		expect(styles.get(ids[1])).toEqual({ fg: 1, bold: true });
		expect(styles.get(ids[2])).toEqual({
			fg: 0x010203,
			bold: true,
			underline: 1,
		});
		p.dispose();
	});

	it("follows the modes a program sets", () => {
		const p = pane();
		expect(p.alternateScreen).toBe(false);
		p.write(enc("\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?2004h"));
		expect(p.alternateScreen).toBe(true);
		expect(p.mode(1002)).toBe(true);
		expect(p.mode(1006)).toBe(true);
		expect(p.mode(2004)).toBe(true);
		expect(p.mode(1003)).toBe(false);
		p.dispose();
	});

	it("resizes, and a resize is read as a full frame", () => {
		const p = pane();
		p.write(enc("abc"));
		p.read();
		p.resize(10, 3);
		const frame = p.read();
		expect(frame).toMatchObject({ cols: 10, rows: 3 });
		expect(frame.dirty).toHaveLength(3);
		expect(frame.dirty[0].cells).toHaveLength(10);
		p.dispose();
	});

	it("keeps the scrollback it is asked for", () => {
		const p = lib.open(80, 5, 1000);
		for (let i = 0; i < 1500; i++) p.write(enc(`line ${String(i)}\r\n`));
		// Pruned a page at a time, so somewhat under the limit.
		expect(p.scrollbackRows).toBeGreaterThanOrEqual(750);
		expect(p.scrollbackRows).toBeLessThanOrEqual(1100);
		p.dispose();
	});
});

describe("the committed module", () => {
	it("is the build BUILD.json records", async () => {
		const { createHash } = await import("node:crypto");
		const record = JSON.parse(
			readFileSync(
				new URL("../../../../vendor/libghostty-vt/BUILD.json", import.meta.url),
				"utf8",
			),
		) as { tag: string; sha256: string; bytes: number };
		const bytes = readFileSync(WASM);
		expect(record.tag).toBe("vt-1.0.0");
		expect(bytes.length).toBe(record.bytes);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(
			record.sha256,
		);
	});
});
