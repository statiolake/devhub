/**
 * A `display-popup` a control client's binding opened, run by DevHub
 * (phase 3, `docs/terminal-mode.md`).
 *
 * tmux runs a popup's command in a pty of its own, no pane's, with the
 * opening pane's `TMUX` and `TMUX_PANE` in its environment: a `tmux`
 * command in it then takes that pane as "the current pane", which is what a
 * binding like `bind m display-popup "… tmux move-pane -t :$w"` relies on.
 * A control client gets none of it drawn, so DevHub does the same: the
 * command runs in a pty the pty host opens (on a host, a pty there, over
 * `ssh -tt`), told the opener's `TMUX`, `TMUX_PANE` and directory, and its
 * screen is an engine of its own that the page draws as a float. Run in a
 * pane instead (a temporary window or session), the pane's own tty would
 * make it "the current pane" and the binding would act on the wrong one.
 *
 * The pty is opened running `POPUP_SCRIPT`, the same program everywhere
 * (`OpenSpec.popupLaunch`): it reads what to run from its first seven lines
 * of input, with echo off, so nothing about one popup is in the launch.
 */

import type { VtFrame } from "../../../ipc/terminalControl.js";
import type { VtPane } from "../vt/libghosttyVt.js";
import { printfEscaped } from "./tmuxCommand.js";

/**
 * `sh -c` reads: the directory, `TMUX`, `TMUX_PANE`, the shell, the
 * command as `printf` escapes (one line whatever it holds), and the `PATH`
 * tmux would give it (its session's, else the server's: a `tmux` in it is
 * the server's own, as in a pane). An empty command is the shell itself, as
 * tmux runs it.
 */
export const POPUP_SCRIPT = [
	"stty -echo 2>/dev/null",
	"IFS= read -r d; IFS= read -r t; IFS= read -r p; IFS= read -r s; IFS= read -r c; IFS= read -r e; IFS= read -r v",
	"stty echo 2>/dev/null",
	"printf '\\033[H\\033[2J'",
	'c=$(printf "$c")',
	'cd "$d" 2>/dev/null || cd',
	"TMUX=$t TMUX_PANE=$p; export TMUX TMUX_PANE",
	'if [ -n "$e" ]; then PATH=$e; export PATH; fi',
	'if [ -n "$v" ]; then eval "$(printf "$v")"; fi',
	'[ -x "$s" ] || s=/bin/sh',
	'if [ -z "$c" ]; then exec "$s"; fi',
	'exec "$s" -c "$c"',
].join("\n");

export interface PopupPty {
	write(bytes: Uint8Array): void;
	onData(listener: (bytes: Uint8Array) => void): void;
	onExit(listener: (code?: number) => void): void;
	kill(): void;
}

/** What `POPUP_SCRIPT` is told, as its seven lines. */
export function popupInput(job: {
	readonly directory: string;
	readonly tmux: string;
	readonly pane: string;
	readonly shell: string;
	readonly command: string;
	readonly path: string;
	/** `-e NAME=value`, each put in the command's environment as tmux does. */
	readonly environment?: readonly string[];
}): Uint8Array {
	const line = (text: string) => text.replace(/[\r\n]/g, " ");
	return new TextEncoder().encode(
		[
			line(job.directory),
			line(job.tmux),
			line(job.pane),
			line(job.shell),
			printfEscaped(job.command),
			line(job.path),
			// One `export 'NAME=value'` line each, quoted for sh, sent as
			// printf escapes so a value holds anything.
			printfEscaped(
				(job.environment ?? [])
					.filter((pair) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(pair))
					.map((pair) => `export '${pair.replace(/'/g, "'\\''")}'`)
					.join("\n"),
			),
		].join("\n") + "\n",
	);
}

const ESC = "\u001b";
const NAMED_BYTES: Readonly<Record<string, string>> = {
	Enter: "\r",
	Escape: ESC,
	Tab: "\t",
	BTab: `${ESC}[Z`,
	BSpace: "\u007f",
	Space: " ",
	Up: `${ESC}[A`,
	Down: `${ESC}[B`,
	Right: `${ESC}[C`,
	Left: `${ESC}[D`,
	Home: `${ESC}[H`,
	End: `${ESC}[F`,
	PPage: `${ESC}[5~`,
	NPage: `${ESC}[6~`,
	IC: `${ESC}[2~`,
	DC: `${ESC}[3~`,
	F1: `${ESC}OP`,
	F2: `${ESC}OQ`,
	F3: `${ESC}OR`,
	F4: `${ESC}OS`,
	F5: `${ESC}[15~`,
	F6: `${ESC}[17~`,
	F7: `${ESC}[18~`,
	F8: `${ESC}[19~`,
	F9: `${ESC}[20~`,
	F10: `${ESC}[21~`,
	F11: `${ESC}[23~`,
	F12: `${ESC}[24~`,
};

/**
 * A tmux key name (`controlKeys.ts`) as the bytes a terminal sends for it,
 * for the popup's program, which reads its pty as any terminal program does.
 */
export function keyBytes(name: string): string | undefined {
	let rest = name;
	let meta = false;
	let control = false;
	for (;;) {
		if (rest.length > 2 && rest.startsWith("M-")) {
			meta = true;
			rest = rest.slice(2);
		} else if (rest.length > 2 && rest.startsWith("C-")) {
			control = true;
			rest = rest.slice(2);
		} else if (rest.length > 2 && rest.startsWith("S-")) {
			rest = rest.slice(2);
		} else break;
	}
	let bytes = NAMED_BYTES[rest];
	if (bytes === undefined) {
		if ([...rest].length !== 1) return undefined;
		bytes = rest;
	}
	if (control) {
		if (rest === "Space") bytes = "\u0000";
		else if (rest.length === 1) {
			const code = rest.toUpperCase().charCodeAt(0);
			if (code >= 0x40 && code <= 0x5f)
				bytes = String.fromCharCode(code - 0x40);
			else if (rest === "?") bytes = "\u007f";
		}
	}
	return meta ? ESC + bytes : bytes;
}

/** Where the popup is, in cells of the window, its border included. */
export interface PopupBox {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface PopupJobOptions {
	readonly id: number;
	readonly pty: PopupPty;
	readonly vt: VtPane;
	readonly box: PopupBox;
	readonly border: boolean;
	readonly title: string;
	/** `-E` once or twice (`PopupArgs.closeOnExit`). */
	readonly closeOnExit: 0 | 1 | 2;
	readonly input: Uint8Array;
	/** Something to draw: the engine's rows since the last. */
	readonly changed: () => void;
	readonly closed: () => void;
}

/** One popup: its pty, its engine, and when it closes. */
export class PopupJob {
	readonly #o: PopupJobOptions;
	#exited = false;
	#closed = false;
	#all = true;
	#dirty = true;

	/** Its engine: the page reports the mouse to it by its modes. */
	get vt(): VtPane {
		return this.#o.vt;
	}

	constructor(options: PopupJobOptions) {
		this.#o = options;
		options.pty.onData((bytes) => {
			if (this.#closed) return;
			options.vt.write(bytes);
			this.#dirty = true;
			options.changed();
		});
		options.pty.onExit((code) => {
			this.#exited = true;
			const close =
				options.closeOnExit === 1 ||
				(options.closeOnExit === 2 && (code ?? 0) === 0);
			if (close) this.close();
		});
		options.pty.write(options.input);
	}

	get id(): number {
		return this.#o.id;
	}

	get box(): PopupBox {
		return this.#o.box;
	}

	get border(): boolean {
		return this.#o.border;
	}

	get title(): string {
		return this.#o.title;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/**
	 * A key typed while it is open. Once its command has exited (no `-E`),
	 * any key closes it, as tmux's does.
	 */
	key(name: string): void {
		if (this.#exited) {
			this.close();
			return;
		}
		const bytes = keyBytes(name);
		if (bytes !== undefined) this.#o.pty.write(new TextEncoder().encode(bytes));
	}

	/** Text the page typed (an IME's, a paste). */
	bytes(bytes: Uint8Array): void {
		if (this.#exited) return;
		this.#o.pty.write(bytes);
	}

	/** Every row next time: it was hidden, or the page asked again. */
	redraw(): void {
		this.#all = true;
		this.#dirty = true;
	}

	/** Its rows since the last read, if any changed. */
	frame(): VtFrame | undefined {
		if (!this.#dirty) return undefined;
		this.#dirty = false;
		const frame = this.#o.vt.read(this.#all);
		this.#all = false;
		return frame;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		if (!this.#exited) this.#o.pty.kill();
		this.#o.vt.dispose();
		this.#o.closed();
	}
}
