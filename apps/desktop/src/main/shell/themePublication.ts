/**
 * Telling the programs in DevHub's terminals which colour theme it wears.
 *
 * The value is `model/publishedTheme.ts`'s; this is its delivery, and the one
 * place that holds the value being delivered:
 *
 * - **the environment**: `environmentFor(machine)` is what every DevHub tmux
 *   server is started with and states with `set-environment -g`
 *   (`TmuxTerminalRuntime.publishThemeEnvironment`), so a new pane — a
 *   Workspace's `ws-` session, an Agent's, the managed Neovim's window —
 *   starts with `DEVHUB_THEME` and the rest;
 * - **the file**: `theme.json` at `themeFilePath`, written whole and renamed
 *   into place, so a watcher never reads half of one;
 * - **the sinks**: whatever else is told — the live tmux servers and the
 *   managed Neovims — registered by the controller once it has them.
 *
 * A change is delivered a moment after it happens (`debounceMs`), so moving
 * through the theme picker's preview is one write per pause rather than one
 * per row, and deliveries never overlap: one that arrives while another is
 * going out goes out after it, with the newest value.
 *
 * Nothing here chooses a colorscheme for anyone. See
 * `docs/window-and-pages.md`, "Terminal programs".
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	themeEnvironment,
	themeFileText,
	type PublishedTheme,
} from "../../model/publishedTheme.js";
import type { RuntimeId } from "../runtime/runtime.js";
import { InvariantViolation } from "../../model/invariant.js";

export type ThemeSink = (theme: PublishedTheme) => Promise<void>;

export interface ThemePublicationOptions {
	/** `theme.json`, on this Mac. */
	readonly file: string;
	readonly debounceMs?: number;
	/** Write `text` to `path` so that no reader sees a partial file. */
	readonly writeFile?: (path: string, text: string) => Promise<void>;
	/** The same, synchronously: the first value, written before any pane. */
	readonly writeFileSync?: (path: string, text: string) => void;
	/** A delivery that failed, for the log. Delivery goes on regardless. */
	readonly onFailure?: (what: string, error: unknown) => void;
}

async function writeAtomically(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${String(process.pid)}.tmp`;
	await writeFile(temporary, text, { mode: 0o644 });
	await rename(temporary, path);
}

function writeAtomicallySync(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${String(process.pid)}.tmp`;
	writeFileSync(temporary, text, { mode: 0o644 });
	renameSync(temporary, path);
}

export class ThemePublication {
	readonly #options: ThemePublicationOptions;
	readonly #sinks: { readonly name: string; readonly sink: ThemeSink }[] = [];
	#current: PublishedTheme | undefined;
	#currentText: string | undefined;
	#writtenText: string | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#delivering: Promise<void> = Promise.resolve();

	constructor(options: ThemePublicationOptions) {
		this.#options = options;
	}

	get file(): string {
		return this.#options.file;
	}

	/** The value being published now, once there is one. */
	current(): PublishedTheme | undefined {
		return this.#current;
	}

	/**
	 * What a new pane on `machine` is given. The file's path only on this
	 * Mac, where the file is.
	 */
	environmentFor(machine: RuntimeId): Readonly<Record<string, string>> {
		const theme = this.#current;
		if (!theme) return {};
		return themeEnvironment(
			theme,
			machine === "local" ? this.#options.file : undefined,
		);
	}

	/** Something else to tell, after the file, on every change. */
	addSink(name: string, sink: ThemeSink): void {
		this.#sinks.push({ name, sink });
	}

	/**
	 * Publish this value. The environment answers with it at once; the file
	 * and the sinks are told shortly, and only when it differs from what they
	 * were told last. Answers whether it differed.
	 */
	publish(theme: PublishedTheme): boolean {
		const text = themeFileText(theme);
		if (text === this.#currentText) return false;
		this.#current = theme;
		this.#currentText = text;
		if (this.#writtenText === undefined) {
			// The first value is on disk before this returns, so the file is
			// there by the time the first shell starts and reads
			// `$DEVHUB_THEME_FILE` — a Neovim colouring its first frame from it
			// must never find it missing.
			try {
				(this.#options.writeFileSync ?? writeAtomicallySync)(
					this.#options.file,
					text,
				);
				this.#writtenText = text;
			} catch (error) {
				this.#options.onFailure?.(this.#options.file, error);
			}
		}
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#deliver();
		}, this.#options.debounceMs ?? 120);
		return true;
	}

	/** Deliver what is pending now, and wait for every delivery to end. */
	async flush(): Promise<void> {
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
			void this.#deliver();
		}
		await this.#delivering;
	}

	/** Stop: nothing pending is delivered. */
	dispose(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#deliver(): Promise<void> {
		this.#delivering = this.#delivering.then(() => this.#deliverNow());
		return this.#delivering;
	}

	async #deliverNow(): Promise<void> {
		const theme = this.#current;
		const text = this.#currentText;
		if (!theme || text === undefined) return;
		if (text !== this.#writtenText) {
			try {
				await (this.#options.writeFile ?? writeAtomically)(
					this.#options.file,
					text,
				);
				this.#writtenText = text;
			} catch (error) {
				this.#options.onFailure?.(this.#options.file, error);
			}
		}
		await Promise.all(
			this.#sinks.map(async ({ name, sink }) => {
				try {
					await sink(theme);
				} catch (error) {
					this.#options.onFailure?.(name, error);
				}
			}),
		);
	}
}

let installed: ThemePublication | undefined;

/** Made once, in `bootstrapShell`, before any terminal exists. */
export function installThemePublication(publication: ThemePublication): void {
	if (installed) {
		throw new InvariantViolation("the theme publication is already installed");
	}
	installed = publication;
}

/** Whether there is one: tests build runtimes and controllers without one. */
export function themePublicationIfInstalled(): ThemePublication | undefined {
	return installed;
}
