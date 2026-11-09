/**
 * The status line as data (`docs/terminal-mode.md`, "The window tabs"): tmux
 * never draws one for a control client, so DevHub draws the tabs, and what
 * they say is the person's own formats expanded by tmux — never cells read
 * back from a drawing. A window's `window-status-format` (or
 * `-current-format`) gives its tab: a leading `#I` becomes the keycap, the
 * rest the label, with the padding that only separates cells trimmed.
 * `status-left` / `status-right`, `status-justify` and `status-position`
 * place it. Both are read once with `list-windows` / `display-message` and
 * then kept by a `refresh-client -B` subscription, which tmux checks once a
 * second and reports only on a change.
 */

import type {
	StatusColor,
	StatusLine,
	StatusRun,
	StatusStyle,
	WindowTab,
} from "../../../ipc/terminalControl.js";

const FIELD = "\u001f";

/** The subscription to every window's tab (`@*`). */
export const TABS_SUBSCRIPTION = "devhub-tabs";
/** The subscription to the session's status line. */
export const STATUS_SUBSCRIPTION = "devhub-status";

const TAB_FIELDS = [
	"#{window_index}",
	"#{window_bell_flag}",
	"#{window_activity_flag}",
	"#{window_silence_flag}",
	"#{?window_active,#{window-status-current-style},#{window-status-style}}",
	"#{window-status-bell-style}",
	"#{window-status-activity-style}",
	// The format as written, to see whether it leads with `#I`, and expanded
	// (with `strftime`, as tmux expands a status line).
	"#{?window_active,#{window-status-current-format},#{window-status-format}}",
	"#{?window_active,#{T:window-status-current-format},#{T:window-status-format}}",
];

/** A window's tab, as one `FIELD`-separated value (`parseTab`). */
export const TAB_FORMAT = TAB_FIELDS.join(FIELD);
export const TAB_FIELD_COUNT = TAB_FIELDS.length;

/** The session's status line, as one value (`parseStatus`). */
export const STATUS_FORMAT = [
	"#{status}",
	"#{status-position}",
	"#{status-justify}",
	"#{T:status-left}",
	"#{T:status-right}",
	"#{status-left-length}",
	"#{status-right-length}",
	"#{E:pane-active-border-style}",
].join(FIELD);

/** A format that leads with the window's index, past any style. */
const LEADING_INDEX = /^(?:\s|#\[[^\]]*\])*(?:#I|#\{window_index\})/;

/** A window's tab from `TAB_FORMAT`'s value. */
export function parseTab(value: string): WindowTab | undefined {
	const fields = value.split(FIELD);
	if (fields.length < TAB_FIELD_COUNT) return undefined;
	const [
		index,
		bell,
		activity,
		silence,
		style,
		bellStyle,
		activityStyle,
		format,
		...expanded
	] = fields;
	const key = LEADING_INDEX.test(format);
	let label = trimRuns(statusRuns(expanded.join(FIELD)));
	if (key) label = trimRuns(dropPrefix(label, index));
	const alerted = bell === "1" ? bellStyle : activityStyle;
	const alert = parseStyle(alerted)?.fg;
	return {
		key,
		label,
		style: parseStyle(style) ?? {},
		bell: bell === "1",
		activity: activity === "1" || silence === "1",
		...(alert === undefined ? {} : { alert }),
	};
}

/** The status line from `STATUS_FORMAT`'s value. */
export function parseStatus(value: string): StatusLine | undefined {
	const [
		status,
		position,
		justify,
		left,
		right,
		leftLength,
		rightLength,
		activeBorder,
	] = value.split(FIELD);
	if (rightLength === undefined) return undefined;
	const border = parseStyle(activeBorder ?? "")?.fg;
	return {
		shown: status !== "off",
		position: position === "top" ? "top" : "bottom",
		justify:
			justify === "centre" ||
			justify === "right" ||
			justify === "absolute-centre"
				? justify
				: "left",
		left: limitRuns(trimRuns(statusRuns(left)), Number(leftLength)),
		right: limitRuns(trimRuns(statusRuns(right)), Number(rightLength)),
		...(border === undefined ? {} : { activeBorder: border }),
	};
}

/**
 * Expanded text cut at its `#[...]` styles, each run in the style it has
 * there (styles add up, as tmux draws them). A `#[...]` that is not a style
 * tmux would take is text.
 */
export function statusRuns(text: string): StatusRun[] {
	const runs: StatusRun[] = [];
	let style: StatusStyle = {};
	let at = 0;
	let pending = "";
	const flush = () => {
		if (pending !== "") runs.push({ ...style, text: pending });
		pending = "";
	};
	while (at < text.length) {
		const open = text.indexOf("#[", at);
		if (open < 0) {
			pending += text.slice(at);
			break;
		}
		const close = text.indexOf("]", open + 2);
		const next =
			close < 0 ? undefined : parseStyle(text.slice(open + 2, close), style);
		if (next === undefined) {
			pending += text.slice(at, open + 2);
			at = open + 2;
			continue;
		}
		pending += text.slice(at, open);
		flush();
		style = next;
		at = close + 1;
	}
	flush();
	return runs;
}

const ATTRIBUTES: Record<string, keyof Omit<StatusStyle, "fg">> = {
	bold: "bold",
	bright: "bold",
	dim: "dim",
	italics: "italic",
	underscore: "underline",
	"double-underscore": "underline",
	"curly-underscore": "underline",
	"dotted-underscore": "underline",
	"dashed-underscore": "underline",
	strikethrough: "strikethrough",
};

/** What tmux takes in a style but DevHub does not draw. */
const IGNORED = new Set([
	"blink",
	"reverse",
	"hidden",
	"overline",
	"nolist",
	"list",
	"push-default",
	"pop-default",
	"ignore",
	"noignore",
	"norange",
]);

/**
 * A tmux style (`style_parse`): its attributes and its foreground, on top of
 * `base`. The background is the terminal's (DevHub draws only the active
 * tab's pill); `reverse` is not drawn, since a filled tab is what "active"
 * looks like. `undefined`: not a style tmux would take.
 */
export function parseStyle(
	text: string,
	base: StatusStyle = {},
): StatusStyle | undefined {
	const style: {
		-readonly [K in keyof StatusStyle]: StatusStyle[K];
	} = { ...base };
	for (const word of text.split(/[\s,]+/)) {
		if (word === "") continue;
		const lower = word.toLowerCase();
		if (lower === "default") {
			delete style.fg;
			continue;
		}
		if (lower === "none") {
			for (const attribute of Object.values(ATTRIBUTES))
				delete style[attribute];
			continue;
		}
		const eq = lower.indexOf("=");
		if (eq > 0) {
			const name = lower.slice(0, eq);
			const value = lower.slice(eq + 1);
			if (name === "fg") {
				const color = parseColor(value);
				if (color === undefined) return undefined;
				if (color === "default") delete style.fg;
				else if (color !== "unknown") style.fg = color;
				continue;
			}
			if (["bg", "us", "fill"].includes(name)) {
				if (parseColor(value) === undefined) return undefined;
				continue;
			}
			if (["align", "list", "range", "width", "pad"].includes(name)) continue;
			return undefined;
		}
		const off = lower.startsWith("no") ? lower.slice(2) : undefined;
		const attribute = ATTRIBUTES[off ?? lower];
		if (attribute !== undefined) {
			if (off === undefined) style[attribute] = true;
			else delete style[attribute];
			continue;
		}
		if (IGNORED.has(lower) || (off !== undefined && IGNORED.has(off))) continue;
		return undefined;
	}
	return style;
}

const NAMES = [
	"black",
	"red",
	"green",
	"yellow",
	"blue",
	"magenta",
	"cyan",
	"white",
];

/**
 * A colour as tmux names one (`colour_fromstring`). `"unknown"`: a name
 * tmux knows from X11's list, which DevHub leaves at the default ink.
 */
function parseColor(
	text: string,
): StatusColor | "default" | "unknown" | undefined {
	if (text === "default" || text === "terminal") return "default";
	const hex = /^#([0-9a-f]{6})$/.exec(text);
	if (hex !== null) return { rgb: parseInt(hex[1], 16) };
	const numbered = /^colou?r(\d{1,3})$/.exec(text);
	if (numbered !== null) {
		const index = Number(numbered[1]);
		return index < 256 ? { index } : undefined;
	}
	const bright = text.startsWith("bright") ? text.slice(6) : undefined;
	const at = NAMES.indexOf(bright ?? text);
	if (at >= 0) return { index: bright === undefined ? at : at + 8 };
	if (/^[0-9]+$/.test(text)) {
		const index = Number(text);
		return index >= 90 && index <= 97 ? { index: index - 82 } : undefined;
	}
	return /^[a-z][a-z0-9 ]*$/.test(text) ? "unknown" : undefined;
}

/** The runs without the padding at either end. */
export function trimRuns(runs: readonly StatusRun[]): StatusRun[] {
	const out = runs.map((run) => ({ ...run }));
	while (out.length > 0) {
		out[0].text = out[0].text.trimStart();
		if (out[0].text !== "") break;
		out.shift();
	}
	while (out.length > 0) {
		const last = out[out.length - 1];
		last.text = last.text.trimEnd();
		if (last.text !== "") break;
		out.pop();
	}
	return out;
}

/**
 * The runs without `prefix` at their start, if they start with it, nor the
 * `:` that separates it from the name (tmux's default `#I:#W`).
 */
function dropPrefix(runs: readonly StatusRun[], prefix: string): StatusRun[] {
	const first = runs[0];
	if (first === undefined || !first.text.startsWith(prefix)) return [...runs];
	const rest = first.text.slice(prefix.length).replace(/^:/, "");
	return rest === ""
		? runs.slice(1)
		: [{ ...first, text: rest }, ...runs.slice(1)];
}

/** At most `length` characters, as `status-left-length` cuts. */
function limitRuns(runs: StatusRun[], length: number): StatusRun[] {
	if (!Number.isFinite(length)) return runs;
	const out: StatusRun[] = [];
	let left = length;
	for (const run of runs) {
		if (left <= 0) break;
		const chars = [...run.text];
		out.push(
			chars.length <= left
				? run
				: { ...run, text: chars.slice(0, left).join("") },
		);
		left -= chars.length;
	}
	return trimRuns(out);
}
