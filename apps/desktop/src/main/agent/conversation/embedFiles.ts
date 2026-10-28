/**
 * The files a GUI conversation embeds, read from the Agent's machine.
 *
 * An answer may show a file instead of repeating it: `![chart](out/sales.png)`
 * is the picture, `![](deck.md)` the deck (`shell/conversation/FileEmbed.tsx`).
 * The page finds the file the way it finds a link's (`resolvePathCandidates`)
 * and asks here for its bytes, and then, while the embed is on screen, for a
 * signature that changes when the file does — so an Agent that writes the
 * file again redraws it in place.
 *
 * What may be read is narrow, because the page that asks draws words an Agent
 * wrote: a regular file, named by an absolute path, of one of the types an
 * embed draws (`EMBED_TYPES`: pictures and the text formats of the preview
 * kinds), and no larger than `MAX_EMBED_BYTES`. The bytes are drawn the way
 * the same format in a fence is — as an image, or in a frame that loads
 * nothing — so a file shown cannot reach anything either.
 *
 * Both questions are one `/bin/sh` on the Agent's machine (this Mac, or the
 * host over its ssh master), like the path links' check.
 */

import { posix } from "node:path";
import { OperationDeadline } from "../../terminal/command.js";
import { CancellationToken } from "../../terminal/ports.js";
import type { PathMachine } from "./pathLinks.js";

/** The most an embed reads: a big chart or deck, not a data set. */
export const MAX_EMBED_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

/** What an embed may be, by the end of its name, and the type it is read as. */
export const EMBED_TYPES: readonly (readonly [string, string])[] = [
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
	[".avif", "image/avif"],
	[".svg", "image/svg+xml"],
	[".md", "text/markdown"],
	[".markdown", "text/markdown"],
	[".mmd", "text/vnd.mermaid"],
	[".mermaid", "text/vnd.mermaid"],
	[".diff", "text/x-diff"],
	[".patch", "text/x-diff"],
	[".html", "text/html"],
	[".htm", "text/html"],
	[".vl.json", "application/vnd.vegalite+json"],
	[".vega-lite.json", "application/vnd.vegalite+json"],
];

/** The type `path` is embedded as, or `undefined` when it may not be. */
export function embedType(path: string): string | undefined {
	const name = posix.basename(path).toLowerCase();
	return EMBED_TYPES.find(
		([ending]) => name.endsWith(ending) && name.length > ending.length,
	)?.[1];
}

/** `path` as one an embed may read, or a thrown reason it is not. */
export function embedPath(path: unknown): string {
	if (
		typeof path !== "string" ||
		!path.startsWith("/") ||
		path.includes("\0")
	) {
		throw new Error(`${JSON.stringify(path)} is not a file to embed`);
	}
	if (embedType(path) === undefined) {
		throw new Error(
			`${posix.basename(path)} is not a kind of file DevHub embeds`,
		);
	}
	return posix.normalize(path);
}

export interface EmbedFile {
	readonly mediaType: string;
	readonly bytes: Uint8Array;
	/** What `embedSignature` answers for these bytes. */
	readonly signature: string;
}

/**
 * Prints the file's signature line — its size, its modification time and,
 * for a file under 2 MB, its checksum — then, with `read`, its bytes. Exit 3:
 * not a regular file; exit 4: larger than allowed (the line is still printed).
 */
const SCRIPT = [
	"f=$1; max=$2; read=$3",
	'[ -f "$f" ] || exit 3',
	's=$(wc -c < "$f" | tr -d " ")',
	't=$(date -r "$f" +%s 2>/dev/null || echo 0)',
	'c=""; if [ "$s" -le 2097152 ]; then c=$(cksum < "$f" | tr -d " "); fi',
	'printf "%s %s %s\\n" "$s" "$t" "$c"',
	'[ "$s" -le "$max" ] || exit 4',
	'[ "$read" = 1 ] && exec cat -- "$f"',
	"exit 0",
].join("\n");

async function ask(
	machine: PathMachine,
	path: string,
	read: boolean,
): Promise<{ readonly signature: string; readonly bytes: Buffer } | null> {
	const result = await machine.exec({
		argv: [
			"/bin/sh",
			"-c",
			SCRIPT,
			"devhub-embed",
			path,
			String(MAX_EMBED_BYTES),
			read ? "1" : "0",
		],
		deadline: OperationDeadline.in(TIMEOUT_MS),
		cancel: new CancellationToken(),
		limits: {
			stdoutBytes: (read ? MAX_EMBED_BYTES : 0) + 256,
			stderrBytes: 8 * 1024,
			overflow: { kind: "truncate" },
		},
	});
	if (result.code === 3) return null;
	const newline = result.stdout.indexOf(0x0a);
	const signature =
		newline < 0 ? "" : result.stdout.subarray(0, newline).toString("utf8");
	if (result.code === 4) {
		const size = Number(signature.split(" ")[0]);
		throw new Error(
			`${posix.basename(path)} is too large to embed (${Math.round(size / 1024 / 1024)} MB; at most ${MAX_EMBED_BYTES / 1024 / 1024} MB).`,
		);
	}
	if (result.code !== 0 || newline < 0) {
		throw new Error(
			`DevHub could not read${machine.where} ${path} (exit ${String(result.code ?? result.signal)}): ${result.stderr.toString("utf8").trim()}`,
		);
	}
	return { signature, bytes: result.stdout.subarray(newline + 1) };
}

/** The file at `path`, or `null` when there is no such file. */
export async function readEmbedFile(
	machine: PathMachine,
	path: unknown,
): Promise<EmbedFile | null> {
	const file = embedPath(path);
	const answer = await ask(machine, file, true);
	if (answer === null) return null;
	return {
		mediaType: embedType(file)!,
		bytes: new Uint8Array(answer.bytes),
		signature: answer.signature,
	};
}

/** What changes when the file at `path` does, or `null` when it is gone. */
export async function embedSignature(
	machine: PathMachine,
	path: unknown,
): Promise<string | null> {
	const answer = await ask(machine, embedPath(path), false);
	return answer?.signature ?? null;
}
