/**
 * At most one save running and one waiting, however many are asked for.
 *
 * Every model change that moves the revision asks for a save of the whole
 * state file, and a busy Agent round moves it several times a second. Each
 * save is a full serialise, an fsync, a read and decode of the previous file
 * for the backup and a second fsync; queued one per request behind the store's
 * write chain, a burst of them kept main busy (and the disk) long after the
 * burst was over, each writing a state the next one would replace.
 *
 * A save reads the model when it *starts*, so one that starts after a request
 * covers it. That is the whole rule: a request made while a save is running is
 * answered by the next save, which every request made in the meantime shares.
 * A request is never answered by a save that started before it was made.
 */
export class SaveCoalescer {
	#running: Promise<void> | undefined;
	#next: Promise<void> | undefined;

	constructor(private readonly save: () => Promise<void>) {}

	/** Settles with the first save that starts after this call. */
	request(): Promise<void> {
		if (this.#next !== undefined) return this.#next;
		if (this.#running === undefined) return this.#start();
		this.#next ??= this.#running.then(
			() => this.#start(),
			() => this.#start(),
		);
		return this.#next;
	}

	#start(): Promise<void> {
		this.#next = undefined;
		const run = (async () => {
			await this.save();
		})();
		this.#running = run;
		const clear = () => {
			if (this.#running === run) this.#running = undefined;
		};
		run.then(clear, clear);
		return run;
	}
}
