/**
 * DevHub's binding of libghostty-vt 1.0, Ghostty's terminal core compiled to
 * wasm32 (`apps/desktop/vendor/libghostty-vt/`, built by
 * `scripts/build_libghostty_vt.py`): one engine per tmux pane in the
 * control-mode terminal (`docs/terminal-mode.md`).
 *
 * The engine is fed a pane's `%output` and read for the painter: each dirty
 * row's cells — the text, a style DevHub interns into an id, the width — and
 * the cursor. Only the calls DevHub uses are bound. The C ABI is reached
 * through pointers into the module's memory; one scratch block is allocated
 * at load and reused by every call, and the memory's views are taken again
 * whenever it has grown (growing detaches the old ones).
 *
 * **What is checked at load.** The library's version and the layouts of the
 * structs read here come from the module itself (`ghostty_build_info`,
 * `ghostty_type_json`); a version this binding was not written for, or a
 * layout that moved, is a refusal (`VtLoadError`), not wrong colours. The
 * numbers below are `include/ghostty/vt/*.h` at the `vt-1.0.0` tag.
 */

import type {
	VtCursor,
	VtFrame,
	VtRow,
	VtStyle,
} from "../../../ipc/terminalControl.js";

export type { VtCursor, VtFrame, VtRow, VtStyle };

/** The library versions this binding was written against. */
export const SUPPORTED_VERSIONS: readonly string[] = ["1.0.0"];

const enum TerminalOption {
	ColorForeground = 12,
	ColorBackground = 13,
	ColorCursor = 14,
	ColorPalette = 15,
	ScrollbackMaxBytes = 28,
	ScrollbackMaxLines = 29,
	Mode = 35,
}

const enum TerminalData {
	CursorX = 3,
	CursorY = 4,
	ActiveScreen = 6,
	ScrollbackRows = 15,
	Mode = 37,
}

const enum RenderData {
	Dirty = 3,
	RowIterator = 4,
	ColorCursor = 7,
	ColorCursorHasValue = 8,
	CursorVisualStyle = 10,
	CursorVisible = 11,
	CursorBlinking = 12,
	CursorViewportHasValue = 14,
	CursorViewportX = 15,
	CursorViewportY = 16,
}

const enum RowData {
	Cells = 3,
}

const enum RowCellsData {
	Raw = 1,
	Style = 2,
	GraphemesBuf = 4,
	Bg = 5,
	Fg = 6,
	HasStyling = 8,
}

const enum CellData {
	Wide = 3,
}

const enum BuildInfo {
	VersionString = 5,
}

/** `GhosttyRenderStateDirty`. */
const enum Dirty {
	False = 0,
	Full = 2,
}

/** `GhosttyCellWide`. */
const enum Wide {
	SpacerTail = 2,
	SpacerHead = 3,
}

const SUCCESS = 0;

export class VtLoadError extends Error {}

interface FieldLayout {
	readonly offset: number;
	readonly size: number;
}
interface StructLayout {
	readonly size: number;
	readonly fields: Readonly<Record<string, FieldLayout | undefined>>;
}

type Fn = (...args: (number | bigint)[]) => number;
type Exports = Readonly<Record<string, Fn>> & {
	readonly memory: WebAssembly.Memory;
};

/** The struct fields read, where this binding reads them. */
const LAYOUTS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
	GhosttyStyle: { flags: 12 },
	GhosttyTerminalModeConfig: { mode: 0, value: 2 },
	GhosttyCodepointBuffer: { ptr: 0, cap: 4, len: 8 },
};
const STYLE_SIZE = 16;
/** `GhosttyStyleFlags`: bits 0–7 are the attributes, then the underline style. */
const UNDERLINE_SHIFT = 8;

/** Scratch block layout (offsets into one allocation). */
const S = {
	out: 0,
	raw: 16,
	u32: 24,
	u32b: 28,
	fg: 32,
	bg: 36,
	flag: 40,
	modeConfig: 44,
	y: 48,
	codepoints: 64,
	style: 192,
	graphemes: 256,
	size: 1024,
} as const;
const GRAPHEME_CAP = (S.size - S.graphemes) / 4;

/** One loaded module: every pane of a process shares it (and its memory). */
export class LibGhosttyVt {
	readonly version: string;
	readonly #ex: Exports;
	readonly #scratch: number;
	#u8: Uint8Array;
	#dv: DataView;

	private constructor(ex: Exports, version: string) {
		this.#ex = ex;
		this.version = version;
		this.#u8 = new Uint8Array(ex.memory.buffer);
		this.#dv = new DataView(ex.memory.buffer);
		this.#scratch = ex.ghostty_wasm_alloc(S.size);
		// The grapheme buffer's pointer and capacity never change.
		this.views().dv.setUint32(
			this.#scratch + S.codepoints,
			this.#scratch + S.graphemes,
			true,
		);
		this.views().dv.setUint32(
			this.#scratch + S.codepoints + 4,
			GRAPHEME_CAP,
			true,
		);
	}

	static async load(bytes: BufferSource): Promise<LibGhosttyVt> {
		const { instance } = await WebAssembly.instantiate(bytes, {});
		const ex = instance.exports as unknown as Exports;
		for (const name of REQUIRED_EXPORTS) {
			if (typeof ex[name] !== "function") {
				throw new VtLoadError(`libghostty-vt has no ${name}`);
			}
		}
		const version = readVersion(ex);
		if (!SUPPORTED_VERSIONS.includes(version)) {
			throw new VtLoadError(
				`libghostty-vt ${version} is not a version this binding knows (${SUPPORTED_VERSIONS.join(", ")})`,
			);
		}
		checkLayouts(ex);
		return new LibGhosttyVt(ex, version);
	}

	/** A new pane's engine, `cols × rows`, keeping `scrollback` lines. */
	open(cols: number, rows: number, scrollback: number): VtPane {
		return new VtPane(this, cols, rows, scrollback);
	}

	/** Bytes of wasm memory: it grows with the panes' scrollback and never shrinks. */
	get memoryBytes(): number {
		return this.#ex.memory.buffer.byteLength;
	}

	/** @internal */
	get ex(): Exports {
		return this.#ex;
	}

	/** @internal The scratch block's address. */
	get s(): number {
		return this.#scratch;
	}

	/**
	 * @internal The memory's views, taken again if it grew. A memory that
	 * grows detaches its old buffer, whose length is then 0: that is
	 * checked, not `memory.buffer`, a getter that costs a call each time
	 * (a tenth of a large `cat`'s time, profiled).
	 */
	views(): { u8: Uint8Array; dv: DataView } {
		if (this.#u8.byteLength === 0) {
			this.#u8 = new Uint8Array(this.#ex.memory.buffer);
			this.#dv = new DataView(this.#ex.memory.buffer);
		}
		return { u8: this.#u8, dv: this.#dv };
	}

	/** @internal Call `fn(out)` and read the handle it wrote at `out`. */
	handle(fn: (out: number) => number, what: string): number {
		const out = this.#scratch + S.out;
		const result = fn(out);
		if (result !== SUCCESS) {
			throw new Error(`${what} failed (${String(result)})`);
		}
		return this.views().dv.getUint32(out, true);
	}
}

const REQUIRED_EXPORTS = [
	"ghostty_build_info",
	"ghostty_type_json",
	"ghostty_wasm_alloc",
	"ghostty_wasm_free",
	"ghostty_terminal_new",
	"ghostty_terminal_free",
	"ghostty_terminal_set",
	"ghostty_terminal_get",
	"ghostty_terminal_vt_write",
	"ghostty_terminal_resize",
	"ghostty_terminal_reset",
	"ghostty_render_state_new",
	"ghostty_render_state_free",
	"ghostty_render_state_update",
	"ghostty_render_state_get",
	"ghostty_render_state_clean",
	"ghostty_render_state_row_iterator_new",
	"ghostty_render_state_row_iterator_free",
	"ghostty_render_state_row_iterator_next",
	"ghostty_render_state_row_iterator_next_dirty",
	"ghostty_render_state_row_get",
	"ghostty_render_state_row_cells_new",
	"ghostty_render_state_row_cells_free",
	"ghostty_render_state_row_cells_next",
	"ghostty_render_state_row_cells_get",
	"ghostty_cell_get",
] as const;

function readVersion(ex: Exports): string {
	const out = ex.ghostty_wasm_alloc(16);
	try {
		if (ex.ghostty_build_info(BuildInfo.VersionString, out) !== SUCCESS) {
			return "unknown";
		}
		const dv = new DataView(ex.memory.buffer);
		const pointer = dv.getUint32(out, true);
		const length = dv.getUint32(out + 4, true);
		return new TextDecoder().decode(
			new Uint8Array(ex.memory.buffer, pointer, length),
		);
	} finally {
		ex.ghostty_wasm_free(out, 16);
	}
}

function checkLayouts(ex: Exports): void {
	const pointer = ex.ghostty_type_json();
	const bytes = new Uint8Array(ex.memory.buffer);
	let end = pointer;
	while (bytes[end] !== 0) end++;
	const json = JSON.parse(
		new TextDecoder().decode(bytes.subarray(pointer, end)),
	) as { types?: Record<string, StructLayout | undefined> };
	for (const [name, fields] of Object.entries(LAYOUTS)) {
		const layout = json.types?.[name];
		if (layout === undefined) throw new VtLoadError(`${name} is not described`);
		if (name === "GhosttyStyle" && layout.size !== STYLE_SIZE) {
			throw new VtLoadError("GhosttyStyle's size moved");
		}
		for (const [field, offset] of Object.entries(fields)) {
			if (layout.fields[field]?.offset !== offset) {
				throw new VtLoadError(`${name}.${field} moved`);
			}
		}
	}
}

/** `ghostty_mode`: a DEC private mode, or an ANSI one with the top bit. */
function modeKey(mode: number, ansi: boolean): number {
	return (mode & 0x7fff) | (ansi ? 0x8000 : 0);
}

const GRAPHEME_CLUSTERING = 2027;

/**
 * One pane's engine. Mode 2027 (grapheme clustering) is on and kept on, since
 * that is how tmux lays text out whatever the program asks (`write`).
 */
export class VtPane {
	readonly #lib: LibGhosttyVt;
	readonly #term: number;
	readonly #render: number;
	readonly #rowIter: number;
	readonly #rowCells: number;
	#input = 0;
	#inputCap = 0;
	#cols: number;
	#rows: number;
	#disposed = false;
	/** Interned styles: key → id. Id 0 is the default look. */
	readonly #styleIds = new Map<string, number>();
	#newStyles: [number, VtStyle][] = [];

	constructor(
		lib: LibGhosttyVt,
		cols: number,
		rows: number,
		scrollback: number,
	) {
		this.#lib = lib;
		this.#cols = cols;
		this.#rows = rows;
		const ex = lib.ex;
		this.#term = lib.handle(
			(out) => ex.ghostty_terminal_new(0, out, cols, rows),
			"ghostty_terminal_new",
		);
		this.#render = lib.handle(
			(out) => ex.ghostty_render_state_new(0, out),
			"ghostty_render_state_new",
		);
		this.#rowIter = lib.handle(
			(out) => ex.ghostty_render_state_row_iterator_new(0, out),
			"ghostty_render_state_row_iterator_new",
		);
		this.#rowCells = lib.handle(
			(out) => ex.ghostty_render_state_row_cells_new(0, out),
			"ghostty_render_state_row_cells_new",
		);
		// Lines, and bytes enough that the lines are the limit: the byte limit's
		// default is far below 10 000 lines of a wide pane.
		this.#setUsize(TerminalOption.ScrollbackMaxLines, scrollback);
		this.#setUsize(
			TerminalOption.ScrollbackMaxBytes,
			Math.max(1, scrollback) * Math.max(cols, 80) * 128,
		);
		this.#setMode(GRAPHEME_CLUSTERING, false, true);
	}

	get cols(): number {
		return this.#cols;
	}

	get rows(): number {
		return this.#rows;
	}

	/** Feed the pane's output, as tmux sent it. */
	write(bytes: Uint8Array): void {
		if (this.#disposed || bytes.length === 0) return;
		const ex = this.#lib.ex;
		if (bytes.length > this.#inputCap) {
			if (this.#input !== 0) ex.ghostty_wasm_free(this.#input, this.#inputCap);
			this.#inputCap = Math.max(bytes.length, 16384);
			this.#input = ex.ghostty_wasm_alloc(this.#inputCap);
		}
		this.#lib.views().u8.set(bytes, this.#input);
		// What follows a reset is laid out with clustering on again, so the chunk
		// is written in pieces, each ending at a reset.
		let from = 0;
		for (const end of resetEnds(bytes)) {
			ex.ghostty_terminal_vt_write(this.#term, this.#input + from, end - from);
			this.#setMode(GRAPHEME_CLUSTERING, false, true);
			from = end;
		}
		if (from < bytes.length) {
			ex.ghostty_terminal_vt_write(
				this.#term,
				this.#input + from,
				bytes.length - from,
			);
		}
	}

	resize(cols: number, rows: number): void {
		if (this.#disposed || (cols === this.#cols && rows === this.#rows)) return;
		this.#lib.ex.ghostty_terminal_resize(this.#term, cols, rows, 0, 0);
		this.#cols = cols;
		this.#rows = rows;
	}

	/** Forget everything, as a pane being resynchronised from `capture-pane`. */
	reset(): void {
		if (this.#disposed) return;
		this.#lib.ex.ghostty_terminal_reset(this.#term);
		this.#setMode(GRAPHEME_CLUSTERING, false, true);
	}

	/** Whether a mode is set: DEC private by default, `ansi` for ANSI modes. */
	mode(mode: number, ansi = false): boolean {
		const { ex, s } = this.#lib;
		const { dv, u8 } = this.#lib.views();
		dv.setUint16(s + S.modeConfig, modeKey(mode, ansi), true);
		u8[s + S.modeConfig + 2] = 0;
		if (
			ex.ghostty_terminal_get(
				this.#term,
				TerminalData.Mode,
				s + S.modeConfig,
			) !== SUCCESS
		) {
			return false;
		}
		return this.#lib.views().u8[s + S.modeConfig + 2] !== 0;
	}

	/** On the alternate screen (a full-screen program). */
	get alternateScreen(): boolean {
		return this.#getU32(TerminalData.ActiveScreen) === 1;
	}

	get scrollbackRows(): number {
		return this.#getU32(TerminalData.ScrollbackRows);
	}

	/** The terminal's cursor, in its active area (not the viewport). */
	get cursor(): { x: number; y: number } {
		return {
			x: this.#getU16(TerminalData.CursorX),
			y: this.#getU16(TerminalData.CursorY),
		};
	}

	/** The colours that default cells and the 256 palette entries resolve to. */
	setColors(colors: {
		readonly foreground: number;
		readonly background: number;
		readonly cursor?: number;
		readonly palette?: readonly number[];
	}): void {
		const { ex, s } = this.#lib;
		const rgb = (option: TerminalOption, value: number) => {
			const { u8 } = this.#lib.views();
			u8[s + S.u32] = (value >> 16) & 0xff;
			u8[s + S.u32 + 1] = (value >> 8) & 0xff;
			u8[s + S.u32 + 2] = value & 0xff;
			ex.ghostty_terminal_set(this.#term, option, s + S.u32);
		};
		rgb(TerminalOption.ColorForeground, colors.foreground);
		rgb(TerminalOption.ColorBackground, colors.background);
		if (colors.cursor !== undefined)
			rgb(TerminalOption.ColorCursor, colors.cursor);
		if (colors.palette !== undefined && colors.palette.length === 256) {
			const pointer = ex.ghostty_wasm_alloc(768);
			const { u8 } = this.#lib.views();
			colors.palette.forEach((value, i) => {
				u8[pointer + i * 3] = (value >> 16) & 0xff;
				u8[pointer + i * 3 + 1] = (value >> 8) & 0xff;
				u8[pointer + i * 3 + 2] = value & 0xff;
			});
			ex.ghostty_terminal_set(this.#term, TerminalOption.ColorPalette, pointer);
			ex.ghostty_wasm_free(pointer, 768);
		}
	}

	/**
	 * What changed since the last read: the dirty rows (every row with `all`),
	 * the cursor, and the styles first seen. Marks what it read clean.
	 */
	read(all = false): VtFrame {
		const lib = this.#lib;
		const { ex, s } = lib;
		ex.ghostty_render_state_update(this.#render, this.#term);
		ex.ghostty_render_state_get(this.#render, RenderData.Dirty, s + S.u32);
		const dirtyKind = lib.views().dv.getUint32(s + S.u32, true);
		const full = all || dirtyKind === Dirty.Full;
		const rows: VtRow[] = [];
		if (full || dirtyKind !== Dirty.False) {
			lib.views().dv.setUint32(s + S.out, this.#rowIter, true);
			ex.ghostty_render_state_get(
				this.#render,
				RenderData.RowIterator,
				s + S.out,
			);
			if (all) {
				let y = 0;
				while (
					ex.ghostty_render_state_row_iterator_next(this.#rowIter) !== 0 &&
					y < this.#rows
				) {
					rows.push(this.#readRow(y++));
				}
			} else {
				while (
					ex.ghostty_render_state_row_iterator_next_dirty(
						this.#rowIter,
						s + S.y,
					) !== 0
				) {
					const y = lib.views().dv.getUint16(s + S.y, true);
					if (y < this.#rows) rows.push(this.#readRow(y));
				}
			}
			ex.ghostty_render_state_clean(this.#render);
		}
		const styles = this.#newStyles;
		this.#newStyles = [];
		return {
			cols: this.#cols,
			rows: this.#rows,
			full,
			dirty: rows,
			cursor: this.#readCursor(),
			styles,
		};
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const ex = this.#lib.ex;
		ex.ghostty_render_state_row_cells_free(this.#rowCells);
		ex.ghostty_render_state_row_iterator_free(this.#rowIter);
		ex.ghostty_render_state_free(this.#render);
		ex.ghostty_terminal_free(this.#term);
		if (this.#input !== 0) ex.ghostty_wasm_free(this.#input, this.#inputCap);
	}

	#readRow(y: number): VtRow {
		const lib = this.#lib;
		const { ex, s } = lib;
		const cols = this.#cols;
		const cells = new Array<string>(cols).fill(" ");
		const styles = new Uint32Array(cols);
		lib.views().dv.setUint32(s + S.out, this.#rowCells, true);
		ex.ghostty_render_state_row_get(this.#rowIter, RowData.Cells, s + S.out);
		let x = 0;
		while (
			ex.ghostty_render_state_row_cells_next(this.#rowCells) !== 0 &&
			x < cols
		) {
			ex.ghostty_render_state_row_cells_get(
				this.#rowCells,
				RowCellsData.Raw,
				s + S.raw,
			);
			const raw = lib.views().dv.getBigUint64(s + S.raw, true);
			ex.ghostty_cell_get(raw, CellData.Wide, s + S.u32b);
			const wide = lib.views().dv.getUint32(s + S.u32b, true);
			if (wide === Wide.SpacerTail) cells[x] = "";
			else if (wide !== Wide.SpacerHead) cells[x] = this.#readText();
			styles[x] = this.#readStyle();
			x++;
		}
		return { y, cells, styles };
	}

	/** The cell's text, whole: one codepoint or a grapheme cluster. */
	#readText(): string {
		const lib = this.#lib;
		const { ex, s } = lib;
		ex.ghostty_render_state_row_cells_get(
			this.#rowCells,
			RowCellsData.GraphemesBuf,
			s + S.codepoints,
		);
		const { dv } = lib.views();
		const length = Math.min(
			dv.getUint32(s + S.codepoints + 8, true),
			GRAPHEME_CAP,
		);
		if (length === 0) return " ";
		if (length === 1)
			return String.fromCodePoint(dv.getUint32(s + S.graphemes, true));
		const points: number[] = [];
		for (let i = 0; i < length; i++)
			points.push(dv.getUint32(s + S.graphemes + i * 4, true));
		return String.fromCodePoint(...points);
	}

	#readStyle(): number {
		const lib = this.#lib;
		const { ex, s } = lib;
		const fgOk =
			ex.ghostty_render_state_row_cells_get(
				this.#rowCells,
				RowCellsData.Fg,
				s + S.fg,
			) === SUCCESS;
		const bgOk =
			ex.ghostty_render_state_row_cells_get(
				this.#rowCells,
				RowCellsData.Bg,
				s + S.bg,
			) === SUCCESS;
		lib.views().u8[s + S.flag] = 0;
		ex.ghostty_render_state_row_cells_get(
			this.#rowCells,
			RowCellsData.HasStyling,
			s + S.flag,
		);
		const styled = lib.views().u8[s + S.flag] !== 0;
		if (!fgOk && !bgOk && !styled) return 0;
		let flags = 0;
		if (styled) {
			ex.ghostty_render_state_row_cells_get(
				this.#rowCells,
				RowCellsData.Style,
				s + S.style,
			);
			flags = lib.views().dv.getUint16(s + S.style + 12, true);
		}
		const { u8 } = lib.views();
		const fg = fgOk ? rgbAt(u8, s + S.fg) : -1;
		const bg = bgOk ? rgbAt(u8, s + S.bg) : -1;
		const key = `${String(fg)},${String(bg)},${String(flags)}`;
		let id = this.#styleIds.get(key);
		if (id === undefined) {
			id = this.#styleIds.size + 1;
			this.#styleIds.set(key, id);
			this.#newStyles.push([id, styleOf(fg, bg, flags)]);
		}
		return id;
	}

	#readCursor(): VtCursor | undefined {
		const lib = this.#lib;
		const { ex, s } = lib;
		const get = (kind: RenderData, size: 1 | 2 | 4): number => {
			lib.views().dv.setUint32(s + S.u32, 0, true);
			ex.ghostty_render_state_get(this.#render, kind, s + S.u32);
			const { dv, u8 } = lib.views();
			return size === 1
				? u8[s + S.u32]
				: size === 2
					? dv.getUint16(s + S.u32, true)
					: dv.getUint32(s + S.u32, true);
		};
		if (get(RenderData.CursorViewportHasValue, 1) === 0) return undefined;
		// No default cursor colour is given to the terminal (`setColors`
		// leaves it to the page's theme), so a colour here is the program's
		// own: OSC 12, until OSC 112.
		const color =
			get(RenderData.ColorCursorHasValue, 1) !== 0
				? (() => {
						lib.views().dv.setUint32(s + S.u32, 0, true);
						ex.ghostty_render_state_get(
							this.#render,
							RenderData.ColorCursor,
							s + S.u32,
						);
						return rgbAt(lib.views().u8, s + S.u32);
					})()
				: undefined;
		return {
			x: get(RenderData.CursorViewportX, 2),
			y: get(RenderData.CursorViewportY, 2),
			visible: get(RenderData.CursorVisible, 1) !== 0,
			blinking: get(RenderData.CursorBlinking, 1) !== 0,
			shape: get(RenderData.CursorVisualStyle, 4),
			...(color === undefined ? {} : { color }),
		};
	}

	#getU32(kind: TerminalData): number {
		const { ex, s } = this.#lib;
		this.#lib.views().dv.setUint32(s + S.u32, 0, true);
		ex.ghostty_terminal_get(this.#term, kind, s + S.u32);
		return this.#lib.views().dv.getUint32(s + S.u32, true);
	}

	#getU16(kind: TerminalData): number {
		const { ex, s } = this.#lib;
		this.#lib.views().dv.setUint32(s + S.u32, 0, true);
		ex.ghostty_terminal_get(this.#term, kind, s + S.u32);
		return this.#lib.views().dv.getUint16(s + S.u32, true);
	}

	#setUsize(option: TerminalOption, value: number): void {
		const { ex, s } = this.#lib;
		this.#lib.views().dv.setUint32(s + S.u32, value, true);
		ex.ghostty_terminal_set(this.#term, option, s + S.u32);
	}

	#setMode(mode: number, ansi: boolean, value: boolean): void {
		const { ex, s } = this.#lib;
		const { dv, u8 } = this.#lib.views();
		dv.setUint16(s + S.modeConfig, modeKey(mode, ansi), true);
		u8[s + S.modeConfig + 2] = value ? 1 : 0;
		ex.ghostty_terminal_set(this.#term, TerminalOption.Mode, s + S.modeConfig);
	}
}

/**
 * Where each RIS (`ESC c`) or `DECRST 2027` (`ESC [ ? 2 0 2 7 l`) ends: what
 * turns grapheme clustering off. A sequence split across two chunks is missed
 * (a pane's output arrives in lines, and both are rare).
 */
function resetEnds(bytes: Uint8Array): number[] {
	const decrst = [0x5b, 0x3f, 0x32, 0x30, 0x32, 0x37, 0x6c];
	const ends: number[] = [];
	// `indexOf` finds each ESC natively: a byte-by-byte loop here was a
	// fifth of a large `cat`'s time in the pty host, profiled.
	for (
		let i = bytes.indexOf(0x1b);
		i >= 0 && i < bytes.length - 1;
		i = bytes.indexOf(0x1b, i + 1)
	) {
		if (bytes[i + 1] === 0x63) ends.push(i + 2);
		else if (decrst.every((byte, k) => bytes[i + 1 + k] === byte))
			ends.push(i + 1 + decrst.length);
	}
	return ends;
}

function rgbAt(u8: Uint8Array, at: number): number {
	return (u8[at] << 16) | (u8[at + 1] << 8) | u8[at + 2];
}

function styleOf(fg: number, bg: number, flags: number): VtStyle {
	const style: { -readonly [K in keyof VtStyle]: VtStyle[K] } = {};
	if (fg >= 0) style.fg = fg;
	if (bg >= 0) style.bg = bg;
	if (flags & 1) style.bold = true;
	if (flags & 2) style.italic = true;
	if (flags & 4) style.faint = true;
	if (flags & 8) style.blink = true;
	if (flags & 16) style.inverse = true;
	if (flags & 32) style.invisible = true;
	if (flags & 64) style.strikethrough = true;
	if (flags & 128) style.overline = true;
	const underline = (flags >> UNDERLINE_SHIFT) & 0x7;
	if (underline > 0) style.underline = underline;
	return style;
}
