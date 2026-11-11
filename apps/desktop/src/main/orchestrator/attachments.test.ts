import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AttachmentStore,
	checkAttachments,
	KEEP_MS,
	MAX_FILE,
	withAttachmentsSection,
	writeEscalationAttachments,
} from "./attachments.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
const SVG = new TextEncoder().encode(
	'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>',
);

function folder(): string {
	return mkdtempSync(join(tmpdir(), "devhub-att-"));
}

describe("attachments", () => {
	it("takes pictures by their bytes, and refuses the rest with the reason", () => {
		expect(() =>
			checkAttachments([
				{ name: "a.png", bytes: PNG },
				{ name: "b.svg", bytes: SVG },
			]),
		).not.toThrow();
		expect(() => checkAttachments([{ name: "a.txt", bytes: PNG }])).toThrow(
			/not a picture/u,
		);
		expect(() => checkAttachments([{ name: "a.jpg", bytes: PNG }])).toThrow(
			/bytes are not one/u,
		);
		const big = new Uint8Array(MAX_FILE + 1);
		big.set(PNG);
		expect(() => checkAttachments([{ name: "big.png", bytes: big }])).toThrow(
			/at most 10.0 MB/u,
		);
	});

	it("keeps what a worker hands over under an id, reads it back and forgets it after the keep", () => {
		const root = folder();
		let n = 0;
		const store = new AttachmentStore(
			root,
			() => ["1a2b3c4d", "1a2b3c4d", "00ff00ff"][n++]!,
		);
		const [one] = store.add(
			[{ name: "../shot.png", bytes: PNG, caption: " 修正後 " }],
			1000,
		);
		expect(one).toMatchObject({
			id: "att-1a2b3c4d",
			name: "shot.png",
			caption: "修正後",
			size: PNG.length,
		});
		// A taken id is not given twice.
		expect(store.add([{ name: "b.png", bytes: PNG }], 2000)[0]!.id).toBe(
			"att-00ff00ff",
		);
		expect(store.read("att-1a2b3c4d")).toMatchObject({
			name: "shot.png",
			caption: "修正後",
		});
		expect(Buffer.from(store.read("att-1a2b3c4d").bytes)).toEqual(
			Buffer.from(PNG),
		);
		expect(() => store.read("../etc")).toThrow(/not an attachment id/u);
		expect(() => store.read("att-deadbeef")).toThrow(
			/no attachment att-deadbeef/u,
		);
		store.prune(1000 + KEEP_MS + 1);
		expect(readdirSync(root)).toEqual(["att-00ff00ff"]);
	});

	it("copies them into the escalation's folder and says them under ## 添付", () => {
		const into = join(folder(), "12");
		writeFileSync(join(folder(), "x"), "");
		const section = writeEscalationAttachments(into, [
			{ name: "shot.png", bytes: PNG, caption: "修正後の [画面]" },
			{ name: "shot.png", bytes: PNG },
		]);
		expect(readdirSync(into).sort()).toEqual(["a1-shot.png", "a2-shot.png"]);
		expect(readFileSync(join(into, "a1-shot.png"))).toEqual(Buffer.from(PNG));
		expect(section).toBe(
			`## 添付\n\n**修正後の [画面]** — *shot.png*\n\n![修正後の 画面](<${join(into, "a1-shot.png")}>)\n\n*shot.png*\n\n![shot.png](<${join(into, "a2-shot.png")}>)`,
		);
		expect(withAttachmentsSection("body\n\n", section)).toBe(
			`body\n\n${section}`,
		);
		expect(withAttachmentsSection("body", "")).toBe("body");
		expect(writeEscalationAttachments(into, [])).toBe("");
	});
});
