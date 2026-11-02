/**
 * Theme: Preview… — wearing colour themes for this session only.
 *
 * Opens a list of every theme DevHub can wear (`ShellTheme.available`), the
 * one worn now first. While it stands, the row under the cursor is worn at
 * once (`ShellTheme.wearTemporarily(…, "preview")`): the window and its pages,
 * every workbench (told through its managed settings, as for any change), the
 * Agent panes and DevHub's terminals, and through the theme publication the
 * programs in them and the managed Neovims. Choosing a row keeps it for the
 * session; Escape puts back exactly what was worn before the list opened,
 * temporary or not.
 *
 * Nothing is written. The settings stay what they were, and the configured
 * theme comes back the next time they are applied — a save, Reload in
 * Settings, a restart (`ShellTheme.configure`).
 */

import type { ThemePreviewRowWire } from "../../ipc/contract.js";
import type { AvailableColorTheme, ShellTheme } from "./shellTheme.js";

export interface ThemePreviewOptions {
	readonly theme: () => ShellTheme | undefined;
	/** Show the list; the index chosen, or -1. */
	readonly choose: (
		rows: readonly ThemePreviewRowWire[],
		current: number,
	) => Promise<number>;
	readonly report: (problem: string) => void;
}

function typeWord(type: AvailableColorTheme["type"]): string {
	switch (type) {
		case "light":
			return "Light";
		case "dark":
			return "Dark";
		default:
			return "High contrast";
	}
}

function sourceWords(theme: AvailableColorTheme): string {
	switch (theme.source) {
		case "builtin":
			return "VS Code";
		case "devhub":
			return `DevHub library · ${theme.extension}`;
		case "extension":
			return `Extension · ${theme.extension}`;
	}
}

export function themePreviewRows(
	available: readonly AvailableColorTheme[],
): ThemePreviewRowWire[] {
	const seen = new Set<string>();
	const rows: ThemePreviewRowWire[] = [];
	for (const theme of available) {
		if (seen.has(theme.name)) continue;
		seen.add(theme.name);
		rows.push({
			name: theme.name,
			label: theme.label,
			detail: `${typeWord(theme.type)} · ${sourceWords(theme)}`,
		});
	}
	return rows;
}

export class ThemePreview {
	#open = false;

	constructor(private readonly options: ThemePreviewOptions) {}

	get isOpen(): boolean {
		return this.#open;
	}

	async open(): Promise<void> {
		const theme = this.options.theme();
		if (!theme || this.#open) return;
		const rows = themePreviewRows(theme.available());
		if (rows.length === 0) return;
		const before = theme.temporaryTheme();
		const worn = theme.wornName();
		const current = Math.max(
			0,
			rows.findIndex((row) => row.name === worn),
		);
		this.#open = true;
		let chosen: number;
		try {
			chosen = await this.options.choose(rows, current);
		} finally {
			this.#open = false;
		}
		const row = rows[chosen];
		try {
			if (row) {
				theme.wearTemporarily(row.name, "session");
			} else if (before) {
				theme.wearTemporarily(before.name, "session");
			} else {
				theme.wearTemporarily(undefined, "session");
			}
		} catch (error) {
			this.options.report(
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	/** The cursor is on `name`: wear it, if the list is open. */
	preview(name: string): void {
		if (!this.#open) return;
		try {
			this.options.theme()?.wearTemporarily(name, "preview");
		} catch (error) {
			this.options.report(
				error instanceof Error ? error.message : String(error),
			);
		}
	}
}
