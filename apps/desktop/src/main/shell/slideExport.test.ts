import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("../electron.js", () => ({ electron: {} }));

const {
	PRINT_CSP,
	confine,
	printDocument,
	printWindowOptions,
	saveSlideImages,
	saveSlidesPdf,
	slideImagePaths,
	safeFileName,
} = await import("./slideExport.js");

const PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
]);
const PDF = Buffer.from("%PDF-1.7 slides");
const DECK = {
	html: "<!doctype html><html><body><div class=marpit></div></body></html>",
	width: 1280,
	height: 720,
	name: "Atlas pitch",
};

type Listener = (...args: unknown[]) => void;

/** A window that records what it was told, and prints `PDF`. */
function fakeWindow() {
	const listeners = new Map<string, Listener>();
	let beforeRequest: Listener | undefined;
	const state = {
		loaded: undefined as string | undefined,
		document: undefined as string | undefined,
		destroyed: false,
		printOptions: undefined as Electron.PrintToPDFOptions | undefined,
		openHandler: undefined as (() => unknown) | undefined,
		listeners,
		request(url: string): boolean {
			let cancel = false;
			beforeRequest!({ url }, (answer: { cancel: boolean }) => {
				cancel = answer.cancel;
			});
			return cancel;
		},
	};
	const window = {
		loadURL: vi.fn(async (url: string) => {
			state.loaded = url;
			state.document = readFileSync(fileURLToPath(url), "utf8");
		}),
		destroy: () => {
			state.destroyed = true;
		},
		webContents: {
			session: {
				webRequest: {
					onBeforeRequest: (listener: Listener) => {
						beforeRequest = listener;
					},
				},
			},
			on: (event: string, listener: Listener) => listeners.set(event, listener),
			setWindowOpenHandler: (handler: () => unknown) => {
				state.openHandler = handler;
			},
			printToPDF: vi.fn(async (options: Electron.PrintToPDFOptions) => {
				state.printOptions = options;
				return PDF;
			}),
		},
	};
	return { window: window as unknown as Electron.BrowserWindow, state };
}

function host(filePath: string | undefined) {
	const { window, state } = fakeWindow();
	const files = new Map<string, Uint8Array>();
	const created: Electron.BrowserWindowConstructorOptions[] = [];
	const dialogs: Electron.SaveDialogOptions[] = [];
	return {
		state,
		files,
		created,
		dialogs,
		host: {
			showSaveDialog: vi.fn(async (options: Electron.SaveDialogOptions) => {
				dialogs.push(options);
				return { canceled: filePath === undefined, filePath };
			}),
			createWindow: (options: Electron.BrowserWindowConstructorOptions) => {
				created.push(options);
				return window;
			},
			writeFile: async (path: string, bytes: Uint8Array) => {
				files.set(path, bytes);
			},
		},
	};
}

describe("the window a deck is printed in", () => {
	it("is hidden, runs no script and has a session of its own", () => {
		const options = printWindowOptions();
		expect(options.show).toBe(false);
		expect(options.webPreferences).toMatchObject({
			javascript: false,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webSecurity: true,
		});
		expect(options.webPreferences?.preload).toBeUndefined();
		// In memory, and a new one each print.
		expect(options.webPreferences?.partition).not.toMatch(/^persist:/);
		expect(printWindowOptions().webPreferences?.partition).not.toBe(
			options.webPreferences?.partition,
		);
	});

	it("puts a policy that loads nothing first in the document", () => {
		expect(PRINT_CSP).toMatch(/default-src 'none'/);
		expect(PRINT_CSP).toMatch(/script-src 'none'/);
		expect(PRINT_CSP).toMatch(/img-src data:;/);
		expect(PRINT_CSP).not.toMatch(/https?:|\*/);
		const printed = printDocument(DECK.html);
		expect(printed.indexOf("Content-Security-Policy")).toBeLessThan(
			printed.indexOf("<html>"),
		);
		expect(printed.startsWith("<!doctype html><meta")).toBe(true);
		expect(printDocument("<p>a</p>")).toMatch(
			/^<!doctype html><meta http-equiv="Content-Security-Policy"/,
		);
	});

	it("loads only the file it was given, and goes nowhere", () => {
		const { window, state } = fakeWindow();
		confine(window, "file:///tmp/devhub-slides-1/slides.html");
		expect(state.request("file:///tmp/devhub-slides-1/slides.html")).toBe(
			false,
		);
		expect(state.request("data:image/png;base64,AAAA")).toBe(false);
		expect(state.request("https://fonts.example/a.css")).toBe(true);
		expect(state.request("file:///etc/passwd")).toBe(true);
		const navigation = { preventDefault: vi.fn(), url: "https://example.com" };
		state.listeners.get("will-navigate")!(navigation);
		state.listeners.get("will-frame-navigate")!(navigation);
		expect(navigation.preventDefault).toHaveBeenCalledTimes(2);
		expect(state.openHandler?.()).toEqual({ action: "deny" });
	});
});

describe("saving a deck as a PDF", () => {
	it("asks where, prints the slides at their size, writes and cleans up", async () => {
		const { host: h, state, files, dialogs } = host("/Users/me/Atlas pitch");
		const path = await saveSlidesPdf(h, DECK);
		expect(path).toBe("/Users/me/Atlas pitch.pdf");
		expect(dialogs[0]).toMatchObject({ defaultPath: "Atlas pitch.pdf" });
		expect(files.get(path!)).toEqual(new Uint8Array(PDF));
		expect(state.printOptions).toMatchObject({
			printBackground: true,
			pageSize: { width: 1280 / 96, height: 720 / 96 },
			margins: { top: 0, bottom: 0, left: 0, right: 0 },
		});
		expect(state.document).toContain("Content-Security-Policy");
		expect(state.destroyed).toBe(true);
		// The file it printed from is gone.
		expect(existsSync(fileURLToPath(state.loaded!))).toBe(false);
	});

	it("prints nothing when the dialog is cancelled", async () => {
		const { host: h, created, files } = host(undefined);
		expect(await saveSlidesPdf(h, DECK)).toBeUndefined();
		expect(created).toEqual([]);
		expect(files.size).toBe(0);
	});

	it("refuses a request that is not a deck", async () => {
		const { host: h } = host("/tmp/a.pdf");
		await expect(saveSlidesPdf(h, { ...DECK, html: 3 })).rejects.toThrow(
			/not a document/,
		);
		await expect(saveSlidesPdf(h, { ...DECK, width: 0 })).rejects.toThrow(
			/size/,
		);
		await expect(
			saveSlidesPdf(h, { ...DECK, height: Number.NaN }),
		).rejects.toThrow(/size/);
	});
});

describe("saving slides as images", () => {
	it("writes one slide to the name chosen", async () => {
		const { host: h, files } = host("/tmp/out/slide.png");
		expect(await saveSlideImages(h, { images: [PNG], name: "a" })).toEqual([
			"/tmp/out/slide.png",
		]);
		expect([...files.get("/tmp/out/slide.png")!]).toEqual([...PNG]);
	});

	it("numbers several beside the name chosen", async () => {
		const { host: h, files, dialogs } = host("/tmp/out/deck");
		const paths = await saveSlideImages(h, {
			images: [PNG, PNG, PNG],
			name: "Atlas/pitch",
		});
		expect(paths).toEqual([
			"/tmp/out/deck-01.png",
			"/tmp/out/deck-02.png",
			"/tmp/out/deck-03.png",
		]);
		expect(files.size).toBe(3);
		expect(dialogs[0]?.defaultPath).toBe("Atlas pitch.png");
	});

	it("refuses what is not a PNG, before asking anything", async () => {
		const { host: h, dialogs } = host("/tmp/a.png");
		await expect(
			saveSlideImages(h, { images: [Uint8Array.from([1, 2, 3])], name: "a" }),
		).rejects.toThrow(/PNG/);
		await expect(saveSlideImages(h, { images: [], name: "a" })).rejects.toThrow(
			/no slides/,
		);
		expect(dialogs).toEqual([]);
	});

	it("names files safely", () => {
		expect(safeFileName("../../etc/passwd", "x")).toBe("etc passwd");
		expect(safeFileName("", "slides")).toBe("slides");
		expect(safeFileName(42, "slides")).toBe("slides");
		expect(slideImagePaths("/a/b.png", 12)[11]).toBe("/a/b-12.png");
	});
});
