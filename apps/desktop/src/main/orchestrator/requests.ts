/**
 * The person's requests to the orchestrator: the Orchestrator screen's +
 * (`Cmd+Q +`, "Orchestrator: New Request…"), `docs/orchestrator.md`,
 * "Requests".
 *
 * A request is the person's words, delivered at once as their own message
 * (the `request` event, like an answer: held only while off), and kept here
 * so the board shows it from the moment it is sent:
 *
 * - **送信待ち** (`held`): the mode is off, so it waits to be delivered;
 * - **受付待ち** (`sent`): delivered; the orchestrator is to file it as a
 *   task (an Issue, an escalation, an agent's work) and say where, with
 *   `devhub --tell orchestrator request done ID --note "<where>"`;
 * - **登録済み** (`filed`): done, with that note; the board shows the last few.
 *
 * Kept on disk across restarts (`orchestrator-requests.json`), at most
 * `MAX_REQUESTS` (the oldest filed ones go first).
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type RequestState = "held" | "sent" | "filed";

export interface PersonRequest {
	readonly id: number;
	readonly text: string;
	readonly at: number;
	state: RequestState;
	sentAt?: number;
	filed?: { readonly at: number; readonly note?: string };
}

export const MAX_REQUESTS = 200;
export const MAX_REQUEST_LENGTH = 20_000;

export interface RequestStorage {
	load(): readonly PersonRequest[];
	save(requests: readonly PersonRequest[]): void;
}

export class RequestBook {
	readonly #requests: PersonRequest[];

	constructor(private readonly storage?: RequestStorage) {
		this.#requests = [...(storage?.load() ?? [])];
	}

	all(): readonly PersonRequest[] {
		return this.#requests;
	}

	get(id: number): PersonRequest | undefined {
		return this.#requests.find((one) => one.id === id);
	}

	/** Not filed yet: what the board lists, oldest first. */
	open(): readonly PersonRequest[] {
		return this.#requests.filter((one) => one.state !== "filed");
	}

	add(text: string, at: number): PersonRequest {
		const id = Math.max(0, ...this.#requests.map((one) => one.id)) + 1;
		const made: PersonRequest = { id, text, at, state: "held" };
		this.#requests.push(made);
		while (this.#requests.length > MAX_REQUESTS) {
			const index = this.#requests.findIndex((one) => one.state === "filed");
			this.#requests.splice(index === -1 ? 0 : index, 1);
		}
		this.#save();
		return made;
	}

	sent(id: number, at: number): void {
		const one = this.get(id);
		if (one === undefined || one.state !== "held") return;
		one.state = "sent";
		one.sentAt = at;
		this.#save();
	}

	file(id: number, at: number, note: string | undefined): PersonRequest {
		const one = this.get(id);
		if (one === undefined)
			throw new Error(
				`there is no request #${String(id)}. Run 'devhub --tell orchestrator request list'.`,
			);
		one.state = "filed";
		one.filed = { at, ...(note === undefined ? {} : { note }) };
		this.#save();
		return one;
	}

	#save(): void {
		this.storage?.save(this.#requests);
	}
}

/** `<userData>/devhub/orchestrator-requests.json`, written atomically. */
export class RequestFile implements RequestStorage {
	refused: string | undefined;

	constructor(
		private readonly path: string,
		private readonly log: (line: string) => void = () => undefined,
	) {}

	load(): readonly PersonRequest[] {
		if (!existsSync(this.path)) return [];
		try {
			const file = JSON.parse(readFileSync(this.path, "utf8")) as {
				version?: unknown;
				requests?: unknown;
			};
			if (file.version !== 1 || !Array.isArray(file.requests))
				throw new TypeError("not a requests file");
			return (file.requests as Partial<PersonRequest>[]).flatMap((one) =>
				typeof one.id === "number" &&
				typeof one.text === "string" &&
				typeof one.at === "number" &&
				(one.state === "held" || one.state === "sent" || one.state === "filed")
					? [one as PersonRequest]
					: [],
			);
		} catch (error: unknown) {
			const aside = `${this.path}.corrupt`;
			try {
				renameSync(this.path, aside);
			} catch {
				// Gone already: nothing to move.
			}
			this.refused = `${this.path} could not be read (${error instanceof Error ? error.message : String(error)}); it was moved to ${aside}, and the requests start empty.`;
			return [];
		}
	}

	save(requests: readonly PersonRequest[]): void {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			const temporary = `${this.path}.${String(process.pid)}.tmp`;
			writeFileSync(temporary, JSON.stringify({ version: 1, requests }), {
				mode: 0o600,
			});
			renameSync(temporary, this.path);
		} catch (error: unknown) {
			this.log(
				`[devhub] could not write ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
