/**
 * How often something happened lately, in memory that does not grow.
 *
 * Four places in main asked this question and all four answered it the same
 * way: push a timestamp on every event, and drop the old ones when somebody
 * reads. Nobody reads. `devhub --metrics` is the only reader of any of them,
 * and a DevHub that is never asked for a reading is the normal case — so the
 * arrays were not journals of the last minute, they were journals of the whole
 * session. One of them was found holding twenty-seven million entries, and the
 * reading that would finally have pruned it was a filter over all of them,
 * which is why taking a reading is what people noticed as the freeze.
 *
 * Counting in buckets removes both halves of that. A fixed ring of buckets
 * covers the window; each event finds its bucket by arithmetic and adds one;
 * a bucket that has been overtaken by the ring is cleared as it is reused. The
 * memory is the ring, whatever the rate, and a reading adds up as many numbers
 * as there are buckets rather than as many as there were events. Nothing is
 * pruned on read, so nothing depends on being read.
 *
 * The cost is the edge: the oldest bucket is included whole, so a window of a
 * minute in sixty buckets answers for the last minute give or take a second.
 * That is the right trade for every caller here — they are all reporting a
 * rate to a person, and none of them can tell a minute from a minute and a
 * second. What they could all tell, and used to say, was a number that had
 * been climbing since launch.
 *
 * Keys are what an event was about — a machine, a notice code, an identity.
 * They are per bucket, so a key nothing has said lately stops costing anything
 * the moment its buckets are reused: there is no separate sweep to forget, and
 * no map that outlives what it was counting.
 */

const DEFAULT_BUCKETS = 60;

/** The one key of a tally that counts a single undifferentiated event. */
const UNKEYED = "";

export class RollingTally {
	readonly #bucketMs: number;
	readonly #epochs: number[];
	readonly #counts: Map<string, number>[];
	readonly #clock: () => number;

	/**
	 * @param windowMs How far back a reading looks.
	 * @param buckets How finely the window is divided — the resolution of the
	 * window's edge, and the whole of the memory this costs.
	 */
	constructor(
		windowMs: number,
		buckets: number = DEFAULT_BUCKETS,
		clock: () => number = Date.now,
	) {
		if (!Number.isInteger(buckets) || buckets < 1) {
			throw new Error("a rolling tally needs at least one bucket");
		}
		if (!(windowMs > 0)) {
			throw new Error("a rolling tally needs a window");
		}
		this.#bucketMs = Math.ceil(windowMs / buckets);
		this.#epochs = Array.from({ length: buckets }, () => -1);
		this.#counts = Array.from({ length: buckets }, () => new Map());
		this.#clock = clock;
	}

	/** Count one event. O(1), and it allocates nothing after the first of its key. */
	record(key: string = UNKEYED): void {
		const bucket = this.#bucket(this.#epoch());
		bucket.set(key, (bucket.get(key) ?? 0) + 1);
	}

	/** How many of this key were counted inside the window. */
	count(key: string = UNKEYED): number {
		let total = 0;
		for (const bucket of this.#live()) {
			total += bucket.get(key) ?? 0;
		}
		return total;
	}

	/** Every key with something in the window, and how much. */
	totals(): Map<string, number> {
		const totals = new Map<string, number>();
		for (const bucket of this.#live()) {
			for (const [key, count] of bucket) {
				totals.set(key, (totals.get(key) ?? 0) + count);
			}
		}
		return totals;
	}

	/**
	 * How many counters this tally is holding right now.
	 *
	 * The bound, said out loud. It is at most one per key per bucket, and a
	 * bucket is emptied as the ring reaches it again, so this is what stops the
	 * thing being what it replaced. Nothing in DevHub reads it; the test that
	 * pins the bound does.
	 */
	retained(): number {
		let held = 0;
		for (const bucket of this.#counts) held += bucket.size;
		return held;
	}

	/** How many buckets the ring has. Fixed at construction. */
	get buckets(): number {
		return this.#epochs.length;
	}

	#epoch(): number {
		return Math.floor(this.#clock() / this.#bucketMs);
	}

	/**
	 * The bucket this epoch belongs in, emptied first if the ring has come all
	 * the way round to it. This is the only place anything is forgotten, and it
	 * happens on the write rather than on a read nobody performs.
	 */
	#bucket(epoch: number): Map<string, number> {
		const index =
			((epoch % this.#epochs.length) + this.#epochs.length) %
			this.#epochs.length;
		const counts = this.#counts[index];
		if (counts === undefined) throw new Error("a tally lost a bucket");
		if (this.#epochs[index] !== epoch) {
			this.#epochs[index] = epoch;
			counts.clear();
		}
		return counts;
	}

	*#live(): Generator<Map<string, number>> {
		const oldest = this.#epoch() - this.#epochs.length + 1;
		for (const [index, epoch] of this.#epochs.entries()) {
			if (epoch < oldest) continue;
			const counts = this.#counts[index];
			if (counts !== undefined) yield counts;
		}
	}
}
