/**
 * Screenshots handed to an escalation, from wherever they were taken.
 *
 * `--attach PATH[=CAPTION]` (`escalation new`) and
 * `attachment add PATH[=CAPTION]` name files on the machine the `devhub`
 * command runs on — an SSH host as often as this Mac. The command reads them
 * there and sends their bytes with the request (`cli/attach.go`, the `files`
 * round trip of `docs/devhub-cli.md`), so nothing here reads another
 * machine's disk.
 *
 * Two places keep them:
 *
 * - **The shared store**, `<userData>/devhub/attachments/<id>/`: what a
 *   worker agent hands over (`attachment add`), addressed by an id
 *   (`att-1a2b3c4d`) it puts in its report, for the orchestrator to pass as
 *   `--attach att-1a2b3c4d`. Kept `KEEP_MS` after it was added.
 * - **The escalation's own folder**, `<userData>/devhub/escalations/<id>/`,
 *   beside the pictures its body names (`escalationFiles.ts`): every
 *   attachment is copied there when the escalation is raised or asked again,
 *   and the entry's Markdown gains a `## 添付` section pointing at the
 *   copies — so the board draws them with the thread's own renderer (and
 *   its lightbox), and `escalation show` lists them.
 *
 * Pictures only (PNG, JPEG, GIF, WebP, SVG), checked by their bytes, at most
 * `MAX_FILE` each and `MAX_TOTAL` for one command.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { MAX_FILE, MAX_TOTAL } from "./escalationFiles.js";
import { ATTACHMENTS_HEADING } from "../../model/escalationAttachments.js";

export { MAX_FILE, MAX_TOTAL };

/** How long the shared store keeps what was added to it. */
export const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

/** How long a caption may be. */
export const CAPTION_LIMIT = 300;

export const ATTACHMENT_ID = /^att-[0-9a-f]{8}$/u;

export class AttachmentError extends Error {
	override readonly name = "AttachmentError";
}

/** One picture, its bytes in hand. */
export interface AttachmentFile {
	readonly name: string;
	readonly bytes: Uint8Array;
	readonly caption?: string;
}

const KINDS: readonly {
	readonly extensions: readonly string[];
	readonly matches: (bytes: Uint8Array) => boolean;
}[] = [
	{
		extensions: [".png"],
		matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
	},
	{
		extensions: [".jpg", ".jpeg"],
		matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
	},
	{
		extensions: [".gif"],
		matches: (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]),
	},
	{
		extensions: [".webp"],
		matches: (b) =>
			startsWith(b, [0x52, 0x49, 0x46, 0x46]) &&
			String.fromCharCode(...b.subarray(8, 12)) === "WEBP",
	},
	{
		extensions: [".svg"],
		matches: (b) =>
			/<svg[\s>]/u.test(new TextDecoder().decode(b.subarray(0, 4096))),
	},
];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
	return prefix.every((byte, index) => bytes[index] === byte);
}

function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** A caption: one line, trimmed, within the limit. */
export function checkCaption(caption: string | undefined): string | undefined {
	const trimmed = caption?.trim();
	if (trimmed === undefined || trimmed === "") return undefined;
	if ([...trimmed].length > CAPTION_LIMIT)
		throw new AttachmentError(
			`a caption is at most ${String(CAPTION_LIMIT)} characters.`,
		);
	// eslint-disable-next-line no-control-regex -- control characters are the point
	if (/[\u0000-\u001f\u007f]/u.test(trimmed))
		throw new AttachmentError("a caption is one line of text.");
	return trimmed;
}

/**
 * Refuse what is not a picture the board can draw, or too large: each file,
 * then all of them together.
 */
export function checkAttachments(files: readonly AttachmentFile[]): void {
	let total = 0;
	for (const file of files) {
		const kind = KINDS.find((one) =>
			one.extensions.includes(extensionOf(file.name)),
		);
		if (kind === undefined)
			throw new AttachmentError(
				`${file.name} is not a picture: an attachment is a PNG, JPEG, GIF, WebP or SVG (put a log or a diff in the body, as a code block).`,
			);
		if (!kind.matches(file.bytes))
			throw new AttachmentError(
				`${file.name} is named ${extensionOf(file.name)}, and its bytes are not one.`,
			);
		if (file.bytes.length > MAX_FILE)
			throw new AttachmentError(
				`${file.name} is ${megabytes(file.bytes.length)}; an attachment is at most ${megabytes(MAX_FILE)}.`,
			);
		total += file.bytes.length;
	}
	if (total > MAX_TOTAL)
		throw new AttachmentError(
			`the attachments come to ${megabytes(total)}; one command carries at most ${megabytes(MAX_TOTAL)}.`,
		);
}

function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A file name made safe for the folder it is written in. */
function safeName(name: string): string {
	const safe = basename(name)
		.replace(/[^\p{L}\p{N}._-]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	return safe === "" || safe.startsWith(".") ? `image${safe}` : safe;
}

/** What the shared store says of one it keeps. */
export interface StoredAttachment {
	readonly id: string;
	readonly name: string;
	readonly size: number;
	readonly caption?: string;
	readonly at: number;
}

interface Meta {
	readonly name: string;
	readonly caption?: string;
	readonly at: number;
}

/**
 * The shared store (see the module's doc): a folder per id, the file under
 * its own name and `meta.json` beside it.
 */
export class AttachmentStore {
	constructor(
		private readonly root: string,
		private readonly random: () => string = () =>
			randomBytes(4).toString("hex"),
	) {}

	/** Keep `files`, each under a new id; drops what is past `KEEP_MS` first. */
	add(
		files: readonly AttachmentFile[],
		now: number,
	): readonly StoredAttachment[] {
		checkAttachments(files);
		this.prune(now);
		return files.map((file) => {
			let id = `att-${this.random()}`;
			while (this.exists(id)) id = `att-${this.random()}`;
			const folder = join(this.root, id);
			mkdirSync(folder, { recursive: true, mode: 0o700 });
			const name = safeName(file.name);
			const caption = checkCaption(file.caption);
			writeFileSync(join(folder, name), file.bytes, { mode: 0o600 });
			const meta: Meta = {
				name,
				...(caption === undefined ? {} : { caption }),
				at: now,
			};
			writeFileSync(join(folder, "meta.json"), JSON.stringify(meta), {
				mode: 0o600,
			});
			return { id, size: file.bytes.length, ...meta };
		});
	}

	/** The one with `id`, its bytes in hand; refuses an id it does not keep. */
	read(id: string): AttachmentFile & { readonly id: string } {
		if (!ATTACHMENT_ID.test(id))
			throw new AttachmentError(
				`${JSON.stringify(id)} is not an attachment id (like att-1a2b3c4d).`,
			);
		let meta: Meta;
		try {
			meta = JSON.parse(
				readFileSync(join(this.root, id, "meta.json"), "utf8"),
			) as Meta;
		} catch {
			throw new AttachmentError(
				`there is no attachment ${id}: it was never added ('devhub --tell attachment add FILE'), or it is older than ${String(KEEP_MS / 86_400_000)} days.`,
			);
		}
		return {
			id,
			name: meta.name,
			bytes: readFileSync(join(this.root, id, safeName(meta.name))),
			...(meta.caption === undefined ? {} : { caption: meta.caption }),
		};
	}

	private exists(id: string): boolean {
		try {
			statSync(join(this.root, id));
			return true;
		} catch {
			return false;
		}
	}

	/** Each one added longer than `KEEP_MS` ago, gone. */
	prune(now: number): void {
		let ids: string[];
		try {
			ids = readdirSync(this.root);
		} catch {
			return;
		}
		for (const id of ids) {
			if (!ATTACHMENT_ID.test(id)) continue;
			let at: number;
			try {
				at = (
					JSON.parse(
						readFileSync(join(this.root, id, "meta.json"), "utf8"),
					) as Meta
				).at;
			} catch {
				at = statSync(join(this.root, id)).mtimeMs;
			}
			if (now - at > KEEP_MS)
				rmSync(join(this.root, id), { recursive: true, force: true });
		}
	}
}

/**
 * The heading of the section the attachments are drawn under: read back by
 * the task view (`model/escalationAttachments.ts`), so the shape written here
 * is the one it parses.
 */
export { ATTACHMENTS_HEADING };

/**
 * Copy `files` into the escalation's folder and say them as Markdown: the
 * `## 添付` section the entry ends with, each picture under its caption (or
 * its name). Empty for none.
 */
export function writeEscalationAttachments(
	folder: string,
	files: readonly AttachmentFile[],
): string {
	if (files.length === 0) return "";
	checkAttachments(files);
	mkdirSync(folder, { recursive: true });
	const taken = new Set(safeReaddir(folder));
	const parts = files.map((file, index) => {
		let to = `a${String(index + 1)}-${safeName(file.name)}`;
		for (let n = 2; taken.has(to); n += 1)
			to = `a${String(index + 1)}-${String(n)}-${safeName(file.name)}`;
		taken.add(to);
		const path = join(folder, to);
		writeFileSync(path, file.bytes);
		const caption = checkCaption(file.caption);
		const label = (caption ?? basename(file.name)).replace(/[[\]]/gu, "");
		return `${caption === undefined ? `*${basename(file.name)}*` : `**${caption}** — *${basename(file.name)}*`}\n\n![${label}](<${path}>)`;
	});
	return `## ${ATTACHMENTS_HEADING}\n\n${parts.join("\n\n")}`;
}

function safeReaddir(folder: string): string[] {
	try {
		return readdirSync(folder);
	} catch {
		return [];
	}
}

/** `markdown` with the attachments' section after it. */
export function withAttachmentsSection(
	markdown: string,
	section: string,
): string {
	return section === ""
		? markdown
		: `${markdown.replace(/\s+$/u, "")}\n\n${section}`;
}
