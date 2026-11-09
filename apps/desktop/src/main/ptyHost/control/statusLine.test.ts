import { describe, expect, it } from "vitest";
import {
	TAB_FIELD_COUNT,
	parseStatus,
	parseStyle,
	parseTab,
	statusRuns,
} from "./statusLine.js";

const F = "\u001f";

/** `TAB_FORMAT`'s value for a window, as tmux would send it. */
function tabValue(o: {
	index?: number;
	bell?: boolean;
	activity?: boolean;
	style?: string;
	bellStyle?: string;
	format: string;
	expanded: string;
}): string {
	const fields = [
		String(o.index ?? 0),
		o.bell === true ? "1" : "0",
		o.activity === true ? "1" : "0",
		"0",
		o.style ?? "default",
		o.bellStyle ?? "reverse",
		"reverse",
		o.format,
		o.expanded,
	];
	expect(fields).toHaveLength(TAB_FIELD_COUNT);
	return fields.join(F);
}

describe("the status line as data", () => {
	it("cuts a leading #I out as the keycap and trims the padding", () => {
		// The person's format: " #I <command>:#W ".
		const tab = parseTab(
			tabValue({
				index: 3,
				style: "bold",
				format: " #I #{pane_current_command}:#W ",
				expanded: " 3 zsh:devhub ",
			}),
		);
		expect(tab).toEqual({
			key: true,
			label: [{ text: "zsh:devhub" }],
			style: { bold: true },
			bell: false,
			activity: false,
		});
	});

	it("keeps the index in the name when the format does not lead with it", () => {
		const tab = parseTab(
			tabValue({ index: 1, format: "#W (#I)", expanded: "api (1)" }),
		);
		expect(tab?.key).toBe(false);
		expect(tab?.label).toEqual([{ text: "api (1)" }]);
	});

	it("reads tmux's default #I:#W and a styled #I", () => {
		expect(
			parseTab(tabValue({ index: 12, format: "#I:#W", expanded: "12:vim" }))
				?.label,
		).toEqual([{ text: "vim" }]);
		expect(
			parseTab(
				tabValue({
					index: 2,
					format: "#[fg=blue]#I #[default]#W",
					expanded: "#[fg=blue]2 #[default]web",
				}),
			),
		).toMatchObject({ key: true, label: [{ text: "web" }] });
	});

	it("says a bell and its style's colour, and activity", () => {
		const tab = parseTab(
			tabValue({
				bell: true,
				bellStyle: "fg=colour1,reverse",
				format: "#W",
				expanded: "w",
			}),
		);
		expect(tab).toMatchObject({ bell: true, alert: { index: 1 } });
		expect(
			parseTab(tabValue({ activity: true, format: "#W", expanded: "w" })),
		).toMatchObject({ activity: true, bell: false });
		expect(
			parseTab(tabValue({ activity: true, format: "#W", expanded: "w" }))
				?.alert,
		).toBeUndefined();
	});

	it("cuts expanded text at its styles, which add up", () => {
		expect(statusRuns("a#[bold]b#[fg=red]c#[nobold,fg=default]d")).toEqual([
			{ text: "a" },
			{ text: "b", bold: true },
			{ text: "c", bold: true, fg: { index: 1 } },
			{ text: "d" },
		]);
		// Not a style tmux takes: text, as typed.
		expect(statusRuns("x#[nope]y")).toEqual([{ text: "x#[nope]y" }]);
	});

	it("reads tmux's colours and attributes", () => {
		expect(parseStyle("fg=#ff8800 italics")).toEqual({
			fg: { rgb: 0xff8800 },
			italic: true,
		});
		expect(parseStyle("fg=brightred,dim")).toEqual({
			fg: { index: 9 },
			dim: true,
		});
		expect(parseStyle("fg=colour208,bg=black,reverse")).toEqual({
			fg: { index: 208 },
		});
		expect(parseStyle("fg=orange")).toEqual({});
		expect(parseStyle("bold", { italic: true })).toEqual({
			bold: true,
			italic: true,
		});
		expect(parseStyle("none", { bold: true, fg: { index: 2 } })).toEqual({
			fg: { index: 2 },
		});
		expect(parseStyle("fg=colour999")).toBeUndefined();
	});

	it("places the line by status-position and status-justify", () => {
		const value = [
			"on",
			"bottom",
			"centre",
			" * ",
			"#[dim]devhub  21:04 ",
			"10",
			"40",
		].join(F);
		expect(parseStatus(value)).toEqual({
			shown: true,
			position: "bottom",
			justify: "centre",
			left: [{ text: "*" }],
			right: [{ text: "devhub  21:04", dim: true }],
		});
		expect(
			parseStatus(
				["off", "top", "absolute-centre", "", "", "10", "40"].join(F),
			),
		).toMatchObject({
			shown: false,
			position: "top",
			justify: "absolute-centre",
			left: [],
			right: [],
		});
	});

	it("cuts status-left at status-left-length", () => {
		expect(
			parseStatus(["2", "bottom", "left", "abcdef", "", "3", "40"].join(F))
				?.left,
		).toEqual([{ text: "abc" }]);
	});
});
