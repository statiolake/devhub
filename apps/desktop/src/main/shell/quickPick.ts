/**
 * A program's question for DevHub's quick pick, read from what a page sent
 * (`NEOVIM_CHANNELS.quickPick`): Neovim's `vim.ui.select` and `vim.ui.input`
 * (`docs/native-picker.md`). Anything of another shape is no question.
 */

import type {
	QuickPickRequestWire,
	QuickPickRowWire,
} from "../../ipc/contract.js";

/** At most this many rows: a select longer than this is not a quick pick. */
export const QUICK_PICK_MAX_ROWS = 5000;

const text = (value: unknown, max = 500): string | undefined =>
	typeof value === "string" ? value.slice(0, max) : undefined;

export function quickPickRequestOf(
	value: unknown,
): QuickPickRequestWire | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const v = value as Record<string, unknown>;
	const title = text(v["title"]) ?? "Neovim";
	const question = text(v["question"]) ?? "";
	const rows: QuickPickRowWire[] = [];
	if (Array.isArray(v["rows"])) {
		for (const row of v["rows"].slice(0, QUICK_PICK_MAX_ROWS)) {
			const r = (typeof row === "object" && row !== null ? row : {}) as Record<
				string,
				unknown
			>;
			const label = text(r["label"]);
			if (label === undefined) return undefined;
			const detail = text(r["detail"]);
			rows.push(detail === undefined ? { label } : { label, detail });
		}
	}
	const input = v["input"];
	if (typeof input === "object" && input !== null) {
		const fallback = text((input as Record<string, unknown>)["default"], 4000);
		return { title, question, rows: [], input: { default: fallback ?? "" } };
	}
	if (rows.length === 0) return undefined;
	return { title, question, rows };
}
