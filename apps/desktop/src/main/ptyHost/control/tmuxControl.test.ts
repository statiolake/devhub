import { describe, expect, it } from "vitest";
import {
	ControlParser,
	commandLine,
	layoutPanes,
	parseLayout,
	quoteArg,
	unescapeOutput,
	type ControlEvent,
} from "./tmuxControl.js";

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function parse(...chunks: string[]): ControlEvent[] {
	const parser = new ControlParser();
	const events: ControlEvent[] = [];
	for (const chunk of chunks)
		parser.feed(enc(chunk), (event) => events.push(event));
	return events;
}

describe("tmux control mode", () => {
	it("decodes %output's octal escapes back to bytes", () => {
		expect(dec(unescapeOutput(enc("a\\033[31mb\\134\\015\\012")))).toBe(
			"a\x1b[31mb\\\r\n",
		);
		// A backslash that is not an escape stays; one at the very end too.
		expect(dec(unescapeOutput(enc("x\\9y\\")))).toBe("x\\9y\\");
	});

	it("keeps a UTF-8 character split across two %output lines as bytes", () => {
		const char = enc("日");
		const line = (bytes: Uint8Array) =>
			new Uint8Array([...enc("%output %3 "), ...bytes, 0x0a]);
		const parser = new ControlParser();
		const out: number[] = [];
		const emit = (event: ControlEvent) => {
			if (event.type === "output") out.push(...event.data);
		};
		parser.feed(line(char.subarray(0, 2)), emit);
		parser.feed(line(char.subarray(2)), emit);
		expect(dec(new Uint8Array(out))).toBe("日");
	});

	it("reads a pane id and its bytes, and holds a line until its newline", () => {
		const events = parse("%output %12 he", "llo\\015\\012\n%output %1 x\n");
		expect(events).toEqual([
			{ type: "output", pane: 12, data: enc("hello\r\n") },
			{ type: "output", pane: 1, data: enc("x") },
		]);
	});

	it("reads %extended-output's bytes after its ' : '", () => {
		expect(parse("%extended-output %2 1500 : a\\033b\n")).toEqual([
			{ type: "output", pane: 2, data: enc("a\x1bb") },
		]);
	});

	it("says which window or pane a subscription's value is about", () => {
		expect(
			parse(
				"%subscription-changed t $0 @4 1 - : 1|0| 1 zsh:api \n",
				"%subscription-changed p $0 @4 1 %7 : x : y\n",
				"%subscription-changed s $0 - - - :  * \n",
			),
		).toEqual([
			{
				type: "subscription-changed",
				name: "t",
				window: 4,
				pane: undefined,
				value: "1|0| 1 zsh:api ",
			},
			{
				type: "subscription-changed",
				name: "p",
				window: 4,
				pane: 7,
				value: "x : y",
			},
			{
				type: "subscription-changed",
				name: "s",
				window: undefined,
				pane: undefined,
				value: " * ",
			},
		]);
	});

	it("collects a command's answer, says whose it was and whether it failed", () => {
		const events = parse(
			"%begin 1 289 0\n%end 1 289 0\n",
			"%begin 1 295 1\nclient-2911|%1\n%output-looking line\n%end 1 295 1\n",
			"%begin 1 298 1\nparse error: unknown command: x\n%error 1 298 1\n",
		);
		expect(events).toEqual([
			{ type: "reply", number: 289, own: false, ok: true, lines: [] },
			{
				type: "reply",
				number: 295,
				own: true,
				ok: true,
				lines: ["client-2911|%1", "%output-looking line"],
			},
			{
				type: "reply",
				number: 298,
				own: true,
				ok: false,
				lines: ["parse error: unknown command: x"],
			},
		]);
	});

	it("reads notifications", () => {
		const events = parse(
			"%layout-change @0 a87d,100x30,0,0,0 a87d,100x30,0,0,0 *Z\n",
			"%window-renamed @0 my zsh\n%window-pane-changed @0 %4\n%session-changed $1 ws-abc\n",
			"%session-window-changed $1 @2\n%pause %4\n%continue %4\n%pane-mode-changed %4\n%exit detached\n%nonsense here\n",
		);
		expect(events).toEqual([
			{
				type: "layout-change",
				window: 0,
				layout: { kind: "pane", pane: 0, width: 100, height: 30, x: 0, y: 0 },
				visible: { kind: "pane", pane: 0, width: 100, height: 30, x: 0, y: 0 },
				flags: "*Z",
			},
			{ type: "window-renamed", window: 0, name: "my zsh" },
			{ type: "window-pane-changed", window: 0, pane: 4 },
			{ type: "session-changed", session: 1, name: "ws-abc" },
			{ type: "session-window-changed", session: 1, window: 2 },
			{ type: "pause", pane: 4 },
			{ type: "continue", pane: 4 },
			{ type: "pane-mode-changed", pane: 4 },
			{ type: "exit", reason: "detached" },
			{ type: "other", line: "%nonsense here" },
		]);
	});

	it("parses nested layouts", () => {
		const layout = parseLayout(
			"6b8b,100x30,0,0{50x30,0,0,0,49x30,51,0[49x15,51,0,1,49x14,51,16,2]}",
		);
		expect(layout.kind).toBe("row");
		expect(
			layoutPanes(layout).map((p) => [p.pane, p.x, p.y, p.width, p.height]),
		).toEqual([
			[0, 0, 0, 50, 30],
			[1, 51, 0, 49, 15],
			[2, 51, 16, 49, 14],
		]);
		expect(() => parseLayout("6b8b,100x30,0,0{50x30")).toThrow();
	});

	it("quotes command arguments", () => {
		expect(quoteArg("%3")).toBe("%3");
		expect(quoteArg("C-a")).toBe("C-a");
		expect(quoteArg("it's here")).toBe(`'it'\\''s here'`);
		expect(quoteArg("#{pane_id}")).toBe("'#{pane_id}'");
		expect(quoteArg(";")).toBe("';'");
		// tmux expands `$NAME` in an unquoted word; a bare `$` is a syntax error.
		expect(quoteArg("$")).toBe("'$'");
		expect(quoteArg("M-$")).toBe("'M-$'");
		expect(quoteArg("$HOME")).toBe("'$HOME'");
		expect(() => quoteArg("a\nb")).toThrow();
		expect(commandLine(["send-keys", "-t", "%1", "x y"])).toBe(
			"send-keys -t %1 'x y'",
		);
	});
});
