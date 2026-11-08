/**
 * DevHub's binding of libghostty-vt, Ghostty's terminal core compiled to
 * wasm32 (`apps/desktop/vendor/libghostty-vt/`): one engine per tmux pane in
 * the control-mode terminal (`docs/terminal-mode.md`).
 *
 * The engine is fed a pane's `%output` and read for the painter: each dirty
 * row's cells — the text, a style DevHub interns into an id, the width — and
 * the cursor. Only the calls DevHub uses are bound. The C ABI is reached
 * through pointers into the module's memory; one scratch block is allocated
 * at load and reused by every call, and the memory's views are taken again
 * whenever it has grown (growing detaches the old ones).
 *
 * **What is checked at load.** The build's version and the layouts of the
 * structs read here come from the module itself (`ghostty_build_info`,
 * `ghostty_type_json`); a version this binding was not written for, or a
 * layout that moved, is a refusal (`VtLoadError`), not wrong colours. The
 * option and data numbers below are that build's — `0.1.0-dev`, from before
 * the 1.0 tag — and are the one thing to change for the release build.
 */

/** The build this binding was written against. */
export const SUPPORTED_VERSIONS: readonly string[] = ["0.1.0-dev"];

const enum TerminalOption {
	ColorForeground = 11,
	ColorBackground = 12,
	ColorCursor = 13,
	ColorPalette = 14,
	ScrollbackMaxBytes = 27,
	ScrollbackMaxLines = 28,
	Mode = 34,
}

const enum TerminalData {
	Cols = 1,
	Rows = 2,
	CursorX = 3,
	CursorY = 4,
	ActiveScreen = 6,
	CursorVisible = 7,
	Title = 12,
	ScrollbackRows = 15,
	Mode = 37,
}

const enum RenderData {
	Dirty = 3,
	RowIterator = 4,
	CursorVisualStyle = 10,
	CursorVisible = 11,
	CursorBlinking = 12,
	CursorViewportHasValue = 14,
	CursorViewportX = 15,
	CursorViewportY = 16,
}

const enum RowData {
	Dirty = 1,
	Cells = 3,
}

const enum RowCellsData {
	Raw = 1,
	Style = 2,
	GraphemesLen = 3,
	GraphemesBuf = 4,
	Bg = 5,
	Fg = 6,
	HasStyling = 8,
}

const enum CellData {
	Codepoint = 1,
	Wide = 3,
}

const enum BuildInfo {
	Version = 5,
}

/** `GhosttyRenderStateDirty`. */
const enum Dirty {
	None = 0,
	Full = 2,
}

/** `GhosttyCellWide`. */
const enum Wide {
	Wide = 1,
	SpacerTail = 2,
	SpacerHead = 3,
}

const SUCCESS = 0;

/** A cell's look, apart from its text. Colours are 24-bit RGB; absent is the default. */
export interface VtStyle {
	readonly fg?: number;
	readonly bg?: number;
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly faint?: boolean;
	readonly blink?: boolean;
	readonly inverse?: boolean;
	readonly invisible?: boolean;
	readonly strikethrough?: boolean;
	readonly overline?: boolean;
	/** `GhosttySgrUnderline`: 1 single, 2 double, 3 curly, 4 dotted, 5 dashed. */
	readonly underline?: number;
}

/** One row as the painter takes it. */
export interface VtRow {
	readonly y: number;
	/** Each cell's text: `""` for the right half of a wide character. */
	readonly cells: string[];
	/** Each cell's style id (`VtFrame.styles`); 0 is the default look. */
	readonly styles: Uint32Array;
}

export interface VtCursor {
	readonly x: number;
	readonly y: number;
	readonly visible: boolean;
	readonly blinking: boolean;
	/** `GhosttyCursorVisualStyle`: 0 bar, 1 block, 2 underline, 3 hollow block. */
	readonly shape: number;
}

/** What changed since the last read. */
export interface VtFrame {
	readonly cols: number;
	readonly rows: number;
	/** Every row is in `rows`: the screen was cleared, resized or switched. */
	readonly full: boolean;
	readonly dirty: readonly VtRow[];
	readonly cursor: VtCursor | undefined;
	/** Styles first used in this frame, by id. */
	readonly styles: readonly (readonly [number, VtStyle])[];
}

export class VtLoadError extends Error {}

interface FieldLayout {
	readonly offset: number;
	readonly size: number;
}
interface StructLayout {
	readonly size: number;
	readonly fields: Readonly<Record<string, FieldLayout>>;
}

type Fn = (...args: (number | bigint)[]) => number;
type Exports = Readonly<Record<string, Fn>> & {
	readonly memory: WebAssembly.Memory;
};

/** The style fields read, at the offsets this binding assumes they are. */
const STYLE_FIELDS: Readonly<Record<string, number>> = {
	bold: 56,
	italic: 57,
	faint: 58,
	blink: 59,
	inverse: 60,
	invisible: 61,
	strikethrough: 62,
	overline: 63,
	underline: 64,
};
const STYLE_SIZE = 72;

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
	keys: 64,
	values: 96,
	written: 128,
	style: 192,
	graphemes: 512,
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
		this.#scratch = ex.ghostty_wasm_alloc_u8_array(S.size);
	}

	static async load(bytes: BufferSource): Promise<LibGhosttyVt> {
		// The module logs through its import before `load` has its exports.
		const loaded: { memory?: WebAssembly.Memory } = {};
		const instance = await WebAssembly.instantiate(bytes, {
			env: {
				log: (pointer: number, length: number) => {
					const memory = loaded.memory;
					if (memory === undefined) return;
					console.error(
						"[devhub] libghostty-vt:",
						new TextDecoder().decode(
							new Uint8Array(memory.buffer, pointer, length),
						),
					);
				},
			},
		});
		const ex = instance.instance.exports as unknown as Exports;
		loaded.memory = ex.memory;
		for (const name of REQUIRED_EXPORTS) {
			if (typeof ex[name] !== "function") {
				throw new VtLoadError(`libghostty-vt has no ${name}`);
			}
		}
		const version = readVersion(ex);
		if (!SUPPORTED_VERSIONS.includes(version)) {
			throw new VtLoadError(
				`libghostty-vt ${version} is not a build this binding knows (${SUPPORTED_VERSIONS.join(", ")})`,
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

	/** @internal The memory's views, taken again if it grew. */
	views(): { u8: Uint8Array; dv: DataView } {
		if (this.#u8.buffer !== this.#ex.memory.buffer) {
			this.#u8 = new Uint8Array(this.#ex.memory.buffer);
			this.#dv = new DataView(this.#ex.memory.buffer);
		}
		return { u8: this.#u8, dv: this.#dv };
	}

	/** @internal Call `fn(out)` and read the handle it wrote at `out`. */
	handle(fn: (out: number) => number, what: string): number {
		const out = this.#scratch + S.out;
		const result = fn(out);
		if (result !== SUCCESS)
			throw new Error(`${what} failed (${String(result)})`);
		return this.views().dv.getUint32(out, true);
	}
}

const REQUIRED_EXPORTS = [
	"ghostty_build_info",
	"ghostty_type_json",
	"ghostty_wasm_alloc_u8_array",
	"ghostty_wasm_free_u8_array",
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
	"ghostty_render_state_set",
	"ghostty_render_state_row_iterator_new",
	"ghostty_render_state_row_iterator_free",
	"ghostty_render_state_row_iterator_next",
	"ghostty_render_state_row_get",
	"ghostty_render_state_row_set",
	"ghostty_render_state_row_cells_new",
	"ghostty_render_state_row_cells_free",
	"ghostty_render_state_row_cells_next",
	"ghostty_render_state_row_cells_get",
	"ghostty_cell_get",
] as const;

function readVersion(ex: Exports): string {
	const out = ex.ghostty_wasm_alloc_u8_array(16);
	try {
		if (ex.ghostty_build_info(BuildInfo.Version, out) !== SUCCESS)
			return "unknown";
		const dv = new DataView(ex.memory.buffer);
		const pointer = dv.getUint32(out, true);
		const length = dv.getUint32(out + 4, true);
		return new TextDecoder().decode(
			new Uint8Array(ex.memory.buffer, pointer, length),
		);
	} finally {
		ex.ghostty_wasm_free_u8_array(out, 16);
	}
}

function checkLayouts(ex: Exports): void {
	const pointer = ex.ghostty_type_json();
	const bytes = new Uint8Array(ex.memory.buffer);
	let end = pointer;
	while (bytes[end] !== 0) end++;
	const layouts = JSON.parse(
		new TextDecoder().decode(bytes.subarray(pointer, end)),
	) as Record<string, StructLayout | undefined>;
	const style = layouts.GhosttyStyle;
	if (style?.size !== STYLE_SIZE)
		throw new VtLoadError("GhosttyStyle's size moved");
	for (const [name, offset] of Object.entries(STYLE_FIELDS)) {
		if (style.fields[name]?.offset !== offset) {
			throw new VtLoadError(`GhosttyStyle.${name} moved`);
		}
	}
	const mode = layouts.GhosttyTerminalModeConfig;
	if (mode?.fields.mode?.offset !== 0 || mode.fields.value?.offset !== 2) {
		throw new VtLoadError("GhosttyTerminalModeConfig moved");
	}
}

/** `ghostty_mode`: a DEC private mode, or an ANSI one with the top bit. */
function modeKey(mode: number, ansi: boolean): number {
	return (mode & 0x7fff) | (ansi ? 0x8000 : 0);
}

const GRAPHEME_CLUSTERING = 2027;

/**
 * One pane's engine. Mode 2027 (grapheme clustering) is on and kept on, since
 * that is how tmux lays text out whatever the program asks (`ensureClustering`).
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
			if (this.#input !== 0)
				ex.ghostty_wasm_free_u8_array(this.#input, this.#inputCap);
			this.#inputCap = Math.max(bytes.length, 16384);
			this.#input = ex.ghostty_wasm_alloc_u8_array(this.#inputCap);
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
		)
			return false;
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
			const pointer = ex.ghostty_wasm_alloc_u8_array(768);
			const { u8 } = this.#lib.views();
			colors.palette.forEach((value, i) => {
				u8[pointer + i * 3] = (value >> 16) & 0xff;
				u8[pointer + i * 3 + 1] = (value >> 8) & 0xff;
				u8[pointer + i * 3 + 2] = value & 0xff;
			});
			ex.ghostty_terminal_set(this.#term, TerminalOption.ColorPalette, pointer);
			ex.ghostty_wasm_free_u8_array(pointer, 768);
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
		let { u8, dv } = lib.views();
		const dirtyKind = dv.getUint32(s + S.u32, true);
		const full = all || dirtyKind === Dirty.Full;
		const rows: VtRow[] = [];
		if (full || dirtyKind !== Dirty.None) {
			dv.setUint32(s + S.out, this.#rowIter, true);
			ex.ghostty_render_state_get(
				this.#render,
				RenderData.RowIterator,
				s + S.out,
			);
			let y = 0;
			while (
				ex.ghostty_render_state_row_iterator_next(this.#rowIter) !== 0 &&
				y < this.#rows
			) {
				({ u8, dv } = lib.views());
				u8[s + S.flag] = 0;
				ex.ghostty_render_state_row_get(
					this.#rowIter,
					RowData.Dirty,
					s + S.flag,
				);
				if (full || lib.views().u8[s + S.flag] !== 0) {
					rows.push(this.#readRow(y));
					lib.views().u8[s + S.flag] = 0;
					ex.ghostty_render_state_row_set(this.#rowIter, 0, s + S.flag);
				}
				y++;
			}
			({ dv } = lib.views());
			dv.setUint32(s + S.u32, Dirty.None, true);
			ex.ghostty_render_state_set(this.#render, 0, s + S.u32);
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
		if (this.#input !== 0)
			ex.ghostty_wasm_free_u8_array(this.#input, this.#inputCap);
	}

	#readRow(y: number): VtRow {
		const lib = this.#lib;
		const { ex, s } = lib;
		const cols = this.#cols;
		const cells = new Array<string>(cols).fill(" ");
		const styles = new Uint32Array(cols);
		let { dv } = lib.views();
		dv.setUint32(s + S.out, this.#rowCells, true);
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
			({ dv } = lib.views());
			const raw = dv.getBigUint64(s + S.raw, true);
			ex.ghostty_cell_get(raw, CellData.Wide, s + S.u32b);
			({ dv } = lib.views());
			const wide = dv.getUint32(s + S.u32b, true);
			if (wide === Wide.SpacerTail || wide === Wide.SpacerHead) {
				cells[x] = wide === Wide.SpacerTail ? "" : " ";
			} else {
				cells[x] = this.#readText(raw);
			}
			styles[x] = this.#readStyle();
			x++;
		}
		return { y, cells, styles };
	}

	#readText(raw: bigint): string {
		const lib = this.#lib;
		const { ex, s } = lib;
		lib.views().dv.setUint32(s + S.u32, 0, true);
		ex.ghostty_render_state_row_cells_get(
			this.#rowCells,
			RowCellsData.GraphemesLen,
			s + S.u32,
		);
		const length = lib.views().dv.getUint32(s + S.u32, true);
		if (length > 1 && length <= GRAPHEME_CAP) {
			ex.ghostty_render_state_row_cells_get(
				this.#rowCells,
				RowCellsData.GraphemesBuf,
				s + S.graphemes,
			);
			const { dv } = lib.views();
			const points: number[] = [];
			for (let i = 0; i < length; i++)
				points.push(dv.getUint32(s + S.graphemes + i * 4, true));
			return String.fromCodePoint(...points);
		}
		ex.ghostty_cell_get(raw, CellData.Codepoint, s + S.u32);
		const codepoint = lib.views().dv.getUint32(s + S.u32, true);
		return codepoint === 0 ? " " : String.fromCodePoint(codepoint);
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
		let { u8, dv } = lib.views();
		const styled = u8[s + S.flag] !== 0;
		if (!fgOk && !bgOk && !styled) return 0;
		let flags = 0;
		let underline = 0;
		if (styled) {
			u8.fill(0, s + S.style, s + S.style + STYLE_SIZE);
			dv.setUint32(s + S.style, STYLE_SIZE, true);
			ex.ghostty_render_state_row_cells_get(
				this.#rowCells,
				RowCellsData.Style,
				s + S.style,
			);
			({ u8, dv } = lib.views());
			const at = s + S.style;
			for (let bit = 0; bit < 8; bit++)
				if (u8[at + 56 + bit] !== 0) flags |= 1 << bit;
			underline = dv.getInt32(at + STYLE_FIELDS.underline, true);
		}
		const fg = fgOk ? rgbAt(u8, s + S.fg) : -1;
		const bg = bgOk ? rgbAt(u8, s + S.bg) : -1;
		const key = `${String(fg)},${String(bg)},${String(flags)},${String(underline)}`;
		let id = this.#styleIds.get(key);
		if (id === undefined) {
			id = this.#styleIds.size + 1;
			this.#styleIds.set(key, id);
			this.#newStyles.push([id, styleOf(fg, bg, flags, underline)]);
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
		return {
			x: get(RenderData.CursorViewportX, 2),
			y: get(RenderData.CursorViewportY, 2),
			visible: get(RenderData.CursorVisible, 1) !== 0,
			blinking: get(RenderData.CursorBlinking, 1) !== 0,
			shape: get(RenderData.CursorVisualStyle, 4),
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
function* resetEnds(bytes: Uint8Array): Generator<number> {
	const decrst = [0x5b, 0x3f, 0x32, 0x30, 0x32, 0x37, 0x6c];
	for (let i = 0; i < bytes.length - 1; i++) {
		if (bytes[i] !== 0x1b) continue;
		if (bytes[i + 1] === 0x63) {
			yield i + 2;
			continue;
		}
		if (decrst.every((byte, k) => bytes[i + 1 + k] === byte))
			yield i + 1 + decrst.length;
	}
}

function rgbAt(u8: Uint8Array, at: number): number {
	return (u8[at] << 16) | (u8[at + 1] << 8) | u8[at + 2];
}

function styleOf(
	fg: number,
	bg: number,
	flags: number,
	underline: number,
): VtStyle {
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
	if (underline > 0) style.underline = underline;
	return style;
}
