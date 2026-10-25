/**
 * DevHub main's console, kept in a file as well.
 *
 * Everything main says — every `[devhub] …` line, every warning and every
 * stack — goes to stdout and stderr, which nobody sees in a packaged app
 * launched from the Dock. So the same lines are appended, with a timestamp and
 * a level, to `devhub-main.log` in the log folder (`<userData>/logs`, the one
 * Settings' log button opens), and `DevHub: Open Log` opens it.
 *
 * The file is kept small by one rotation: past `MAIN_LOG_MAX_BYTES` it becomes
 * `devhub-main.log.1`, replacing the one before, and a fresh file starts. A
 * line is written synchronously, as `console` itself writes, so a line said
 * just before a crash is in the file after it. Nothing here may break the
 * console it wraps: a file that cannot be written is said once on the real
 * stderr and then left alone.
 */

import {
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	renameSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { format } from "node:util";

export const MAIN_LOG_FILE = "devhub-main.log";

/** Past this, the file is rotated. */
export const MAIN_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** The folder DevHub's logs are in, given the app's user-data directory. */
export function logDirectoryFor(userDataPath: string): string {
	return join(userDataPath, "logs");
}

/** Where main's log is, given the app's user-data directory. */
export function mainLogPath(userDataPath: string): string {
	return join(logDirectoryFor(userDataPath), MAIN_LOG_FILE);
}

/** One file, appended to, rotated once past `maxBytes`. */
export class RotatingLog {
	private fd: number | undefined;
	private size = 0;
	private broken = false;

	constructor(
		readonly path: string,
		private readonly maxBytes = MAIN_LOG_MAX_BYTES,
		private readonly complain: (message: string) => void = () => undefined,
	) {}

	/** Append `text`; false once the file cannot be written. */
	write(text: string): boolean {
		if (this.broken) return false;
		try {
			const bytes = Buffer.byteLength(text);
			if (
				this.fd !== undefined &&
				this.size > 0 &&
				this.size + bytes > this.maxBytes
			) {
				this.rotate();
			}
			const fd = this.open();
			writeSync(fd, text);
			this.size += bytes;
			return true;
		} catch (error: unknown) {
			this.broken = true;
			this.close();
			this.complain(
				`[devhub] log: ${this.path} cannot be written, logging to the console only: ${String(error)}`,
			);
			return false;
		}
	}

	close(): void {
		if (this.fd === undefined) return;
		try {
			closeSync(this.fd);
		} catch {
			// Closing is tidying; there is nothing left to lose.
		}
		this.fd = undefined;
	}

	private open(): number {
		if (this.fd !== undefined) return this.fd;
		mkdirSync(dirname(this.path), { recursive: true });
		let fd = openSync(this.path, "a");
		let size = fstatSync(fd).size;
		// A file already past the limit from an earlier run starts fresh.
		if (size >= this.maxBytes) {
			closeSync(fd);
			this.moveAside();
			fd = openSync(this.path, "a");
			size = fstatSync(fd).size;
		}
		this.fd = fd;
		this.size = size;
		return fd;
	}

	private rotate(): void {
		this.close();
		this.moveAside();
	}

	/** The current file becomes `.1`; one that has gone is nothing to move. */
	private moveAside(): void {
		try {
			renameSync(this.path, `${this.path}.1`);
		} catch {
			// Deleted from under DevHub, most likely: appending recreates it.
		}
	}
}

const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
type Level = (typeof LEVELS)[number];

/** `2026-10-25T09:41:07.123Z INFO  [devhub] …`, one line per call. */
export function logLine(
	level: Level,
	when: Date,
	args: readonly unknown[],
): string {
	const name = level === "log" ? "INFO" : level.toUpperCase();
	return `${when.toISOString()} ${name.padEnd(5)} ${format(...args)}\n`;
}

/**
 * Tee `console.log/info/warn/error/debug` into the log file. Answers with
 * the file's path and a way to put the console back (for tests).
 */
export function installMainLog(
	logPath: string,
	options: {
		readonly target?: Console;
		readonly maxBytes?: number;
		readonly now?: () => Date;
	} = {},
): { readonly path: string; uninstall(): void } {
	const target = options.target ?? console;
	const now = options.now ?? (() => new Date());
	const originals = new Map<Level, (...args: unknown[]) => void>();
	const original = (level: Level) =>
		originals.get(level) ?? ((): void => undefined);
	for (const level of LEVELS) {
		originals.set(level, target[level].bind(target));
	}
	const file = new RotatingLog(logPath, options.maxBytes, (message) => {
		original("error")(message);
	});
	for (const level of LEVELS) {
		target[level] = (...args: unknown[]) => {
			original(level)(...args);
			file.write(logLine(level, now(), args));
		};
	}
	return {
		path: logPath,
		uninstall: () => {
			for (const level of LEVELS) target[level] = original(level);
			file.close();
		},
	};
}
