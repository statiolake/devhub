/**
 * A dev container's build log, shown in the window's "Dev Containers" output.
 *
 * DevHub runs `devcontainer up` and writes what it says to one file per
 * container on this Mac (`apps/desktop/src/main/runtime/buildLog.ts`), a new
 * file for each bring-up. This extension is `ui`-kind, so it runs on this Mac
 * and reads that file directly: while a Reopen in Container or Switch
 * Container is running it follows the file into the output as it grows, and
 * Show Build Log reads it whole afterwards — above all after a build that
 * failed.
 *
 * Following starts from the *next* file: whatever is there when the command
 * starts is the previous bring-up's, and a container DevHub only has to start
 * or adopt writes nothing, so the output then says nothing rather than
 * showing an old build as if it were this one. A new file is told from the
 * old by its identity (DevHub replaces the file rather than truncating it).
 *
 * The file system arrives as {@link LogFiles} so the tests can drive it.
 */

import { StringDecoder } from "node:string_decoder";

/** The output the log is shown in: VS Code's `OutputChannel`, as far as used. */
export interface LogOutput {
  clear(): void;
  append(text: string): void;
  show(preserveFocus: boolean): void;
}

/** The file system, as far as reading a growing file needs it. */
export interface LogFiles {
  /** The file's identity and size, or nothing when there is no file. */
  stat(path: string): Promise<{ ino: number; size: number } | undefined>;
  /** Bytes `[from, to)` of the file. */
  read(path: string, from: number, to: number): Promise<Uint8Array>;
}

/** A log being followed into the output. */
export class LogFollower {
  readonly #path: string;
  readonly #output: LogOutput;
  readonly #files: LogFiles;
  /** The file that was there before: the previous bring-up's. */
  readonly #previous: number | undefined;
  #current: number | undefined;
  #offset = 0;
  #decoder = new StringDecoder("utf8");
  #polling: Promise<void> = Promise.resolve();

  private constructor(
    path: string,
    output: LogOutput,
    files: LogFiles,
    previous: number | undefined,
  ) {
    this.#path = path;
    this.#output = output;
    this.#files = files;
    this.#previous = previous;
  }

  /** Start following: from the next file written at `path`. */
  static async start(
    path: string,
    output: LogOutput,
    files: LogFiles,
  ): Promise<LogFollower> {
    const before = await files.stat(path);
    return new LogFollower(path, output, files, before?.ino);
  }

  /**
   * Show what has been written since the last look. Polls do not overlap:
   * each waits for the one before it, so the output is in the file's order.
   */
  poll(): Promise<void> {
    this.#polling = this.#polling.then(() => this.#poll());
    return this.#polling;
  }

  async #poll(): Promise<void> {
    const now = await this.#files.stat(this.#path);
    if (now === undefined || now.ino === this.#previous) return;
    if (now.ino !== this.#current) {
      // A bring-up has begun: its file replaces whatever the output showed.
      this.#current = now.ino;
      this.#offset = 0;
      this.#decoder = new StringDecoder("utf8");
      this.#output.clear();
      this.#output.show(true);
    }
    if (now.size <= this.#offset) return;
    const bytes = await this.#files.read(this.#path, this.#offset, now.size);
    this.#offset += bytes.byteLength;
    this.#output.append(this.#decoder.write(Buffer.from(bytes)));
  }
}

/**
 * Put the whole of the log at `path` in the output and show it. Says whether
 * there was one: a container that was never brought up by DevHub has none.
 */
export async function showLog(
  path: string,
  output: LogOutput,
  files: LogFiles,
): Promise<boolean> {
  const now = await files.stat(path);
  if (now === undefined) return false;
  const bytes = await files.read(path, 0, now.size);
  output.clear();
  output.append(new StringDecoder("utf8").end(Buffer.from(bytes)));
  output.show(false);
  return true;
}
