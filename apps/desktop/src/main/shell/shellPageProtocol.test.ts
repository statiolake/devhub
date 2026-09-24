/**
 * Every page is served already knowing the window's chrome geometry.
 *
 * The title bar's height and the lights' span are main's (`windowLayout.ts`),
 * and the page's stylesheets read them without declaring them — so a page
 * served without them is a page with a bar of no height. That is why the
 * geometry is written whether or not there is a palette, and why a page this
 * cannot write into is refused rather than served as it is.
 */

import { describe, expect, it, vi } from "vitest";
import type { ShellPalette } from "../../ipc/palette.js";

vi.mock("../electron.js", () => ({ electron: {} }));

const { served, chromeStyleSheet } = await import("./shellPageProtocol.js");
const { chromeVariables } = await import("./windowLayout.js");

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <link rel="stylesheet" href="./assets/index.css" />
  </head>
  <body></body>
</html>`;

describe("the page as it is served", () => {
	it("carries the window's chrome geometry with no palette", () => {
		const html = served(PAGE, undefined);
		expect(html).toContain('<style id="devhub-chrome">');
		for (const [name, value] of chromeVariables()) {
			expect(chromeStyleSheet()).toContain(`${name}: ${value};`);
		}
		expect(html).toContain(chromeStyleSheet());
		// No theme, so no painted chrome either.
		expect(html).not.toContain("devhub-palette");
		expect(html).not.toContain("data-window-material");
	});

	it("carries it beside the palette with one", () => {
		const html = served(PAGE, {
			base: "dark",
			canvas: "#101010",
		} as ShellPalette);
		expect(html).toContain(chromeStyleSheet());
		expect(html).toContain('<style id="devhub-palette">');
		expect(html).toContain('<html data-window-material="none" lang="en">');
	});

	it("writes it after the page's own stylesheet, inside the head", () => {
		const html = served(PAGE, undefined);
		const chrome = html.indexOf("devhub-chrome");
		expect(chrome).toBeGreaterThan(html.indexOf("index.css"));
		expect(chrome).toBeLessThan(html.indexOf("</head>"));
	});

	it("refuses a page it cannot write into, palette or not", () => {
		expect(() => served("<body></body>", undefined)).toThrow(
			/no <html> or <\/head>/,
		);
	});
});
