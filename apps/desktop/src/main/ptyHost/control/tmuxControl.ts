/**
 * tmux's control-mode protocol (`tmux -C`), read and written as bytes: what
 * a control client's stdout says, and the command lines it is sent.
 *
 * A control client gets one line per event. A command's answer is the lines
 * between `%begin <time> <number> <flags>` and `%end` (or `%error`) with the
 * same number; `flags` is 1 for a command this client sent, 0 for the one it
 * was started with. Everything else is a notification, and none comes
 * inside a block. `%output %<pane> <bytes>` carries a pane's output with
 * every byte below a space, and the backslash, written as `\ooo` octal; it
 * is decoded back to bytes here, never to a string, since a UTF-8 character
 * can be split across two lines.
 *
 * Pure: no process, no timers (`controlClient.ts` runs a client).
 */

/** A pane, window or session id as tmux writes it, without its sigil. */
export type TmuxId = number;

/** One node of a window's layout: a pane, or a row or column of nodes. */
export type LayoutNode =
	| {
			readonly kind: "pane";
			readonly pane: TmuxId;
			readonly width: number;
			readonly height: number;
			readonly x: number;
			readonly y: number;
	  }
	| {
			/** `{…}`: side by side. `[…]`: one above the other. */
			readonly kind: "row" | "column";
			readonly width: number;
			readonly height: number;
			readonly x: number;
			readonly y: number;
			readonly children: readonly LayoutNode[];
	  };

export type ControlEvent =
	| {
			readonly type: "output";
			readonly pane: TmuxId;
			readonly data: Uint8Array;
	  }
	| {
			readonly type: "reply";
			readonly number: number;
			/** The command was this client's (not the one it started with). */
			readonly own: boolean;
			readonly ok: boolean;
			readonly lines: readonly string[];
	  }
	| {
			readonly type: "layout-change";
			readonly window: TmuxId;
			readonly layout: LayoutNode;
			/** What is shown: the zoomed pane alone, when one is zoomed. */
			readonly visible: LayoutNode;
			readonly flags: string;
	  }
	| {
			readonly type:
				| "window-add"
				| "window-close"
				| "unlinked-window-add"
				| "unlinked-window-close";
			readonly window: TmuxId;
	  }
	| {
			readonly type: "window-renamed" | "unlinked-window-renamed";
			readonly window: TmuxId;
			readonly name: string;
	  }
	| {
			readonly type: "window-pane-changed";
			readonly window: TmuxId;
			readonly pane: TmuxId;
	  }
	| {
			readonly type: "session-changed";
			readonly session: TmuxId;
			readonly name: string;
	  }
	| {
			readonly type: "session-renamed";
			readonly session: TmuxId;
			readonly name: string;
	  }
	| {
			readonly type: "session-window-changed";
			readonly session: TmuxId;
			readonly window: TmuxId;
	  }
	| { readonly type: "sessions-changed" }
	| { readonly type: "pane-mode-changed"; readonly pane: TmuxId }
	| { readonly type: "pause" | "continue"; readonly pane: TmuxId }
	| { readonly type: "exit"; readonly reason: string }
	| { readonly type: "message" | "config-error"; readonly text: string }
	| {
			readonly type: "subscription-changed";
			readonly name: string;
			readonly value: string;
	  }
	| { readonly type: "other"; readonly line: string };

const NL = 0x0a;
const BACKSLASH = 0x5c;
const DECODER = new TextDecoder();

/** Decode `%output`'s escapes: `\ooo` is one byte. */
export function unescapeOutput(
	bytes: Uint8Array,
	from = 0,
	to = bytes.length,
): Uint8Array {
	const out = new Uint8Array(to - from);
	let n = 0;
	for (let i = from; i < to; i++) {
		const byte = bytes[i];
		if (
			byte === BACKSLASH &&
			i + 3 < to &&
			isOctal(bytes[i + 1]) &&
			isOctal(bytes[i + 2]) &&
			isOctal(bytes[i + 3])
		) {
			out[n++] =
				((bytes[i + 1] - 0x30) << 6) |
				((bytes[i + 2] - 0x30) << 3) |
				(bytes[i + 3] - 0x30);
			i += 3;
		} else {
			out[n++] = byte;
		}
	}
	return out.subarray(0, n);
}

function isOctal(byte: number | undefined): boolean {
	return byte !== undefined && byte >= 0x30 && byte <= 0x37;
}

/** `%12` → 12, `@3` → 3, `$0` → 0. */
export function parseId(text: string | undefined): TmuxId | undefined {
	if (text === undefined || text.length < 2) return undefined;
	const n = Number(text.slice(1));
	return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Parse a layout as `window_layout` writes it: `csum,WxH,X,Y` and then a
 * pane id (`,7`), or `{…}` / `[…]` of children separated by commas.
 */
export function parseLayout(text: string): LayoutNode {
	const comma = text.indexOf(",");
	if (comma < 0) throw new Error(`not a layout: ${text}`);
	let i = comma + 1;
	const number = (): number => {
		const start = i;
		while (
			i < text.length &&
			text.charCodeAt(i) >= 0x30 &&
			text.charCodeAt(i) <= 0x39
		)
			i++;
		if (i === start) throw new Error(`bad layout at ${String(i)}: ${text}`);
		return Number(text.slice(start, i));
	};
	const expect = (c: string): void => {
		if (text[i] !== c)
			throw new Error(`expected '${c}' at ${String(i)}: ${text}`);
		i++;
	};
	const node = (): LayoutNode => {
		const width = number();
		expect("x");
		const height = number();
		expect(",");
		const x = number();
		expect(",");
		const y = number();
		const open = text[i];
		if (open === "{" || open === "[") {
			i++;
			const children: LayoutNode[] = [node()];
			while (text[i] === ",") {
				i++;
				children.push(node());
			}
			expect(open === "{" ? "}" : "]");
			return {
				kind: open === "{" ? "row" : "column",
				width,
				height,
				x,
				y,
				children,
			};
		}
		expect(",");
		return { kind: "pane", pane: number(), width, height, x, y };
	};
	const root = node();
	if (i !== text.length) throw new Error(`trailing text in layout: ${text}`);
	return root;
}

/** Every pane of a layout, in order. */
export function layoutPanes(
	node: LayoutNode,
): Extract<LayoutNode, { kind: "pane" }>[] {
	if (node.kind === "pane") return [node];
	return node.children.flatMap(layoutPanes);
}

/**
 * A tmux command-line argument: quoted unless it is plain. Single quotes keep
 * everything literal but a single quote, which is closed, escaped and opened.
 * A newline would end the command line, so it is refused (`send-keys` text is
 * sent with `-H` hex where it can hold one).
 */
export function quoteArg(arg: string): string {
	if (arg.includes("\n") || arg.includes("\r")) {
		throw new Error("a tmux command argument cannot hold a line break");
	}
	if (/^[A-Za-z0-9_@%$#:.,/=+-]+$/.test(arg) && !arg.startsWith("#"))
		return arg;
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** One command line: words quoted, `;`-free. */
export function commandLine(words: readonly string[]): string {
	return words.map(quoteArg).join(" ");
}

/**
 * Splits a control client's stdout into events. `feed` takes bytes as they
 * come; a line split across two chunks is held until its newline arrives.
 */
export class ControlParser {
	#pending: Uint8Array = new Uint8Array(0);
	#block: { number: number; own: boolean; lines: string[] } | undefined;

	feed(chunk: Uint8Array, emit: (event: ControlEvent) => void): void {
		let data = chunk;
		if (this.#pending.length > 0) {
			data = new Uint8Array(this.#pending.length + chunk.length);
			data.set(this.#pending);
			data.set(chunk, this.#pending.length);
		}
		let start = 0;
		for (;;) {
			const end = data.indexOf(NL, start);
			if (end < 0) break;
			// tmux ends lines with \n; a \r before it is not part of the line.
			const lineEnd = end > start && data[end - 1] === 0x0d ? end - 1 : end;
			this.#line(data, start, lineEnd, emit);
			start = end + 1;
		}
		this.#pending = start < data.length ? data.slice(start) : new Uint8Array(0);
	}

	#line(
		data: Uint8Array,
		start: number,
		end: number,
		emit: (event: ControlEvent) => void,
	): void {
		const block = this.#block;
		if (block !== undefined) {
			const text = DECODER.decode(data.subarray(start, end));
			const guard = /^%(end|error) \d+ (\d+) \d+$/.exec(text);
			if (guard !== null && Number(guard[2]) === block.number) {
				this.#block = undefined;
				emit({
					type: "reply",
					number: block.number,
					own: block.own,
					ok: guard[1] === "end",
					lines: block.lines,
				});
				return;
			}
			block.lines.push(text);
			return;
		}
		if (data[start] !== 0x25) {
			emit({ type: "other", line: DECODER.decode(data.subarray(start, end)) });
			return;
		}
		// %output and %extended-output carry bytes: their header is read from
		// the bytes, the rest is unescaped, never decoded.
		if (startsWith(data, start, "%output ")) {
			const space = data.indexOf(0x20, start + 8);
			if (space < 0 || space > end) return;
			const pane = parseId(DECODER.decode(data.subarray(start + 8, space)));
			if (pane !== undefined)
				emit({
					type: "output",
					pane,
					data: unescapeOutput(data, space + 1, end),
				});
			return;
		}
		if (startsWith(data, start, "%extended-output ")) {
			const space = data.indexOf(0x20, start + 17);
			const colon = findSeparator(data, start, end);
			if (space < 0 || colon < 0) return;
			const pane = parseId(DECODER.decode(data.subarray(start + 17, space)));
			if (pane !== undefined)
				emit({
					type: "output",
					pane,
					data: unescapeOutput(data, colon + 3, end),
				});
			return;
		}
		const text = DECODER.decode(data.subarray(start, end));
		const words = text.split(" ");
		const rest = (n: number) => words.slice(n).join(" ");
		switch (words[0]) {
			case "%begin":
				this.#block = {
					number: Number(words[2]),
					own: words[3] === "1",
					lines: [],
				};
				return;
			case "%layout-change": {
				const window = parseId(words[1]);
				if (window === undefined || words[2] === undefined) break;
				try {
					const layout = parseLayout(words[2]);
					const visible =
						words[3] !== undefined ? parseLayout(words[3]) : layout;
					emit({
						type: "layout-change",
						window,
						layout,
						visible,
						flags: words[4] ?? "",
					});
				} catch {
					break;
				}
				return;
			}
			case "%window-add":
			case "%window-close":
			case "%unlinked-window-add":
			case "%unlinked-window-close": {
				const window = parseId(words[1]);
				if (window === undefined) break;
				emit({ type: words[0].slice(1) as "window-add", window });
				return;
			}
			case "%window-renamed":
			case "%unlinked-window-renamed": {
				const window = parseId(words[1]);
				if (window === undefined) break;
				emit({
					type: words[0].slice(1) as "window-renamed",
					window,
					name: rest(2),
				});
				return;
			}
			case "%window-pane-changed": {
				const window = parseId(words[1]);
				const pane = parseId(words[2]);
				if (window === undefined || pane === undefined) break;
				emit({ type: "window-pane-changed", window, pane });
				return;
			}
			case "%session-changed":
			case "%session-renamed": {
				const session = parseId(words[1]);
				if (session === undefined) break;
				emit({
					type: words[0].slice(1) as "session-changed",
					session,
					name: rest(2),
				});
				return;
			}
			case "%session-window-changed": {
				const session = parseId(words[1]);
				const window = parseId(words[2]);
				if (session === undefined || window === undefined) break;
				emit({ type: "session-window-changed", session, window });
				return;
			}
			case "%sessions-changed":
				emit({ type: "sessions-changed" });
				return;
			case "%pane-mode-changed":
			case "%pause":
			case "%continue": {
				const pane = parseId(words[1]);
				if (pane === undefined) break;
				emit({ type: words[0].slice(1) as "pause", pane });
				return;
			}
			case "%exit":
				emit({ type: "exit", reason: rest(1) });
				return;
			case "%message":
			case "%config-error":
				emit({ type: words[0].slice(1) as "message", text: rest(1) });
				return;
			case "%subscription-changed": {
				// %subscription-changed <name> $s @w <index> %p ... : <value>
				const colon = text.indexOf(" : ");
				if (colon < 0) break;
				emit({
					type: "subscription-changed",
					name: words[1] ?? "",
					value: text.slice(colon + 3),
				});
				return;
			}
		}
		emit({ type: "other", line: text });
	}
}

function startsWith(data: Uint8Array, at: number, prefix: string): boolean {
	for (let i = 0; i < prefix.length; i++) {
		if (data[at + i] !== prefix.charCodeAt(i)) return false;
	}
	return true;
}

/** `%extended-output`'s ` : ` between its header and its bytes. */
function findSeparator(data: Uint8Array, start: number, end: number): number {
	for (let i = start; i + 2 < end; i++) {
		if (data[i] === 0x20 && data[i + 1] === 0x3a && data[i + 2] === 0x20)
			return i;
	}
	return -1;
}
