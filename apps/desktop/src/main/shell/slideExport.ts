/**
 * A Marp deck from a GUI Agent's answer, saved: as a PDF, or as PNGs.
 *
 * The page draws the deck (`shell/conversation/marp.ts`) and asks; main asks
 * the person where, with a save dialog over the window, and writes. A PNG
 * arrives rasterised and is only checked to be one (`clipboardPng`). A PDF is
 * printed here, by Chromium, from the deck's own markup — so its text stays
 * text — in a window nobody sees, made for that one print and destroyed after
 * it:
 *
 * - no script runs in it (`javascript: false`), and nothing of DevHub is in
 *   it: no preload, no node, a session of its own kept in memory;
 * - nothing is fetched: the document says so (`PRINT_CSP`) and the session
 *   refuses every request but the one file it was given, written to a
 *   directory of its own and removed after;
 * - it cannot go anywhere else or open a window.
 *
 * What is printed was written by an Agent and by Marp, and is trusted no more
 * than a diagram is: the window is the boundary, as the image is for one.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { pathToFileURL } from "node:url";
import type { SlidesPdfRequestWire } from "../../ipc/contract.js";
import { clipboardPng } from "./clipboardImage.js";

/** What the printed document is allowed: its own styles and data: images, nothing else. */
export const PRINT_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** A deck past this is not a deck the page meant to send. */
export const MAX_PRINT_HTML_BYTES = 64 * 1024 * 1024;
export const MAX_SLIDE_IMAGES = 500;
/** The longest side of a page, in CSS pixels, that a request may ask for. */
const MAX_PAGE_SIDE = 10_000;

let prints = 0;

/**
 * The window a deck is printed in: hidden, scriptless, a session of its own
 * (one per print, so two prints never share the one rule of what may load).
 */
export function printWindowOptions(
	partition = `devhub-slide-print-${++prints}`,
): Electron.BrowserWindowConstructorOptions {
	return {
		show: false,
		paintWhenInitiallyHidden: true,
		webPreferences: {
			javascript: false,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webSecurity: true,
			images: true,
			spellcheck: false,
			// In memory: no cookie, cache or storage of it outlives the print.
			partition,
		},
	};
}

/** The parts of Electron this needs, so a test can stand in for them. */
export interface SlideExportHost {
	readonly showSaveDialog: (
		options: Electron.SaveDialogOptions,
	) => Promise<Electron.SaveDialogReturnValue>;
	readonly createWindow: (
		options: Electron.BrowserWindowConstructorOptions,
	) => Electron.BrowserWindow;
	readonly writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
}

/** A name a dialog can suggest: no directory, nothing a file system minds. */
export function safeFileName(name: unknown, fallback: string): string {
	const text = typeof name === "string" ? name : "";
	const cleaned = text
		.replace(/[/\\:*?"<>|]+/gu, " ")
		.replace(/\p{Cc}+/gu, " ")
		.replace(/\.{2,}/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 80)
		.replace(/^\.+/u, "");
	return cleaned === "" ? fallback : cleaned;
}

function pageSide(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 1 ||
		value > MAX_PAGE_SIDE
	) {
		throw new Error(`${JSON.stringify(value)} is not a slide's size.`);
	}
	return value;
}

/** The request as it should be, or a thrown reason it is not. */
export function slidesPdfRequest(value: unknown): SlidesPdfRequestWire {
	const request = value as Partial<Record<string, unknown>> | null;
	if (typeof request?.["html"] !== "string") {
		throw new Error("The slides to print are not a document.");
	}
	if (Buffer.byteLength(request["html"]) > MAX_PRINT_HTML_BYTES) {
		throw new Error("The slides to print are too large.");
	}
	return {
		html: request["html"],
		width: pageSide(request["width"]),
		height: pageSide(request["height"]),
		name: safeFileName(request["name"], "slides"),
	};
}

/**
 * The document printed: the deck's own, with `PRINT_CSP` as the first thing
 * in it, so nothing after can load before the policy is in force.
 */
export function printDocument(html: string): string {
	const policy = `<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`;
	const doctype = /^\s*<!doctype[^>]*>/iu.exec(html);
	return doctype === null
		? `<!doctype html>${policy}${html}`
		: `${doctype[0]}${policy}${html.slice(doctype[0].length)}`;
}

/** CSS pixels to the inches `printToPDF` sizes a page in. */
const inches = (pixels: number) => pixels / 96;

/**
 * Keep `window` to the one file it was given: every request for anything else
 * is cancelled, every navigation and window refused.
 */
export function confine(window: Electron.BrowserWindow, allowed: string): void {
	window.webContents.session.webRequest.onBeforeRequest((details, answer) => {
		answer({
			cancel: !(details.url === allowed || details.url.startsWith("data:")),
		});
	});
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	window.webContents.on("will-frame-navigate", (event) => {
		if (event.url !== allowed) event.preventDefault();
	});
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/** Print `request` to PDF bytes in a window of its own. */
export async function printSlides(
	host: Pick<SlideExportHost, "createWindow">,
	request: SlidesPdfRequestWire,
): Promise<Uint8Array> {
	const directory = await mkdtemp(join(tmpdir(), "devhub-slides-"));
	const file = join(directory, "slides.html");
	const window = host.createWindow(printWindowOptions());
	try {
		await writeFile(file, printDocument(request.html), "utf8");
		const url = pathToFileURL(file).href;
		confine(window, url);
		await window.loadURL(url);
		const pdf = await window.webContents.printToPDF({
			printBackground: true,
			preferCSSPageSize: true,
			pageSize: {
				width: inches(request.width),
				height: inches(request.height),
			},
			margins: { top: 0, bottom: 0, left: 0, right: 0 },
		});
		return new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength);
	} finally {
		window.destroy();
		await rm(directory, { recursive: true, force: true });
	}
}

/** Ask where, and save the deck there as a PDF; `undefined` when cancelled. */
export async function saveSlidesPdf(
	host: SlideExportHost,
	value: unknown,
): Promise<string | undefined> {
	const request = slidesPdfRequest(value);
	const chosen = await host.showSaveDialog({
		title: "Save Slides as PDF",
		defaultPath: `${request.name}.pdf`,
		filters: [{ name: "PDF", extensions: ["pdf"] }],
		properties: ["createDirectory", "showOverwriteConfirmation"],
	});
	if (
		chosen.canceled ||
		chosen.filePath === undefined ||
		chosen.filePath === ""
	)
		return undefined;
	const path = chosen.filePath.toLowerCase().endsWith(".pdf")
		? chosen.filePath
		: `${chosen.filePath}.pdf`;
	await host.writeFile(path, await printSlides(host, request));
	return path;
}

/** The request as it should be: PNGs, a bounded number of them. */
export function slideImagesRequest(value: unknown): {
	readonly images: readonly Buffer[];
	readonly name: string;
} {
	const request = value as Partial<Record<string, unknown>> | null;
	const images = request?.["images"];
	if (!Array.isArray(images) || images.length === 0) {
		throw new Error("There are no slides to save.");
	}
	if (images.length > MAX_SLIDE_IMAGES) {
		throw new Error("There are too many slides to save.");
	}
	return {
		images: images.map((image) => clipboardPng(image)),
		name: safeFileName(request?.["name"], "slides"),
	};
}

/**
 * The files `count` slides are written to, for the path chosen: that path for
 * one, `<stem>-01.png`… beside it for several.
 */
export function slideImagePaths(chosen: string, count: number): string[] {
	const { dir, name, ext } = parse(chosen);
	const stem = ext.toLowerCase() === ".png" ? name : `${name}${ext}`;
	if (count === 1) return [join(dir, `${stem}.png`)];
	const width = Math.max(2, String(count).length);
	return Array.from({ length: count }, (_, at) =>
		join(dir, `${stem}-${String(at + 1).padStart(width, "0")}.png`),
	);
}

/** Ask where, and write the slides there; `[]` when cancelled. */
export async function saveSlideImages(
	host: Pick<SlideExportHost, "showSaveDialog" | "writeFile">,
	value: unknown,
): Promise<readonly string[]> {
	const request = slideImagesRequest(value);
	const several = request.images.length > 1;
	const chosen = await host.showSaveDialog({
		title: several ? "Save Slides as Images" : "Save Slide as Image",
		defaultPath: `${request.name}.png`,
		message: several
			? `The ${request.images.length} slides are saved as name-01.png, name-02.png… beside the name you choose.`
			: undefined,
		filters: [{ name: "PNG Image", extensions: ["png"] }],
		properties: ["createDirectory", "showOverwriteConfirmation"],
	});
	if (
		chosen.canceled ||
		chosen.filePath === undefined ||
		chosen.filePath === ""
	)
		return [];
	const paths = slideImagePaths(chosen.filePath, request.images.length);
	for (const [at, path] of paths.entries()) {
		await host.writeFile(path, request.images[at]!);
	}
	return paths;
}
