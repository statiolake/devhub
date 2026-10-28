import { describe, expect, it, vi } from "vitest";

const opened: string[] = [];
vi.mock("../electron.js", () => ({
	electron: {
		shell: {
			openExternal: (url: string) => {
				opened.push(url);
				return Promise.resolve();
			},
		},
	},
}));

const { sendLinksToTheBrowser, staysInItsFrame } = await import(
	"./externalLinks.js"
);

type Listener = (event: {
	url: string;
	isMainFrame: boolean;
	preventDefault: () => void;
}) => void;

describe("a frame inside one of DevHub's pages", () => {
	it("stays on the document it was given", () => {
		const listeners = new Map<string, Listener>();
		const contents = {
			setWindowOpenHandler: () => undefined,
			on: (event: string, listener: Listener) => listeners.set(event, listener),
		} as unknown as Electron.WebContents;
		sendLinksToTheBrowser(contents);
		const navigate = (url: string, isMainFrame: boolean) => {
			const preventDefault = vi.fn();
			listeners.get("will-frame-navigate")!({
				url,
				isMainFrame,
				preventDefault,
			});
			return preventDefault.mock.calls.length > 0;
		};
		expect(navigate("about:srcdoc", false)).toBe(false);
		expect(navigate("https://example.com/?leak", false)).toBe(true);
		expect(navigate("data:text/html,<p>x", false)).toBe(true);
		expect(navigate("devhub-app://agents.html", false)).toBe(true);
		// The page itself is will-navigate's to judge.
		expect(navigate("https://example.com", true)).toBe(false);
		// Refused, not sent to the browser: nobody asked for it.
		expect(opened).toEqual([]);
		expect(staysInItsFrame("about:blank")).toBe(true);
	});
});
