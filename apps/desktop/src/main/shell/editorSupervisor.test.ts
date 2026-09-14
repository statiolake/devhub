import { describe, expect, it } from "vitest";
import {
	deadEditorKeys,
	editorGaveUpFailure,
	EditorSupervisor,
	MAX_EDITOR_RESTARTS,
	RESTART_BACKOFF_MS,
	EDITOR_HEALTHY_MS,
} from "./editorSupervisor.js";

const FOLDER = "/dev/api";

/**
 * Every way `ensureEditorView` can fail to produce a workbench.
 *
 * They are listed here as one table because that is the claim being tested:
 * there is no cause with a budget of its own, and none that reaches a person
 * as an app-wide sentence when the folder it is about has a Workspace. A new
 * rejection added to `openEditorView` and not to this list will not fail this
 * file — but it will fail the one rule that matters, which `failed` enforces
 * for anything routed through it.
 */
const REJECTIONS = [
	"the App Shell window has not been created yet",
	"the workbench renderer stopped: crashed (exit code 133)",
	"The workbench process ended.",
	"No workbench view was created.",
	"windows().open rejected",
	"the workbench did not survive the computer going to sleep",
];

describe("the editor supervisor's budget", () => {
	it("gives every cause of a missing workbench one shared budget", () => {
		const supervisor = new EditorSupervisor();

		// One folder, one failure per cause, all of them counted together: the
		// sixth is the one that runs out, whichever causes got there.
		const verdicts = REJECTIONS.map((reason, index) =>
			supervisor.failed(FOLDER, index * 10),
		);

		expect(verdicts.map((verdict) => verdict.kind)).toEqual([
			...Array.from({ length: MAX_EDITOR_RESTARTS }, () => "restart"),
			"gave-up",
		]);
	});

	it("waits twice as long after every failure", () => {
		const supervisor = new EditorSupervisor();

		const delays = Array.from({ length: MAX_EDITOR_RESTARTS }, () => {
			const verdict = supervisor.failed(FOLDER, 0);
			return verdict.kind === "restart" ? verdict.delayMs : undefined;
		});

		expect(delays).toEqual([
			RESTART_BACKOFF_MS,
			RESTART_BACKOFF_MS * 2,
			RESTART_BACKOFF_MS * 4,
			RESTART_BACKOFF_MS * 8,
			RESTART_BACKOFF_MS * 16,
		]);
	});

	it("does not count a workbench that loaded as a workbench that recovered", () => {
		const supervisor = new EditorSupervisor();

		// The crash loop: it loads every time, and dies immediately every time.
		// Resetting on `did-finish-load` kept this at attempt one for ever —
		// which is a restart every 250 ms, per folder, with no ceiling.
		for (let attempt = 0; attempt < MAX_EDITOR_RESTARTS; attempt += 1) {
			supervisor.loaded(FOLDER, attempt * 100);
			supervisor.failed(FOLDER, attempt * 100 + 50);
		}

		expect(supervisor.failures(FOLDER)).toBe(MAX_EDITOR_RESTARTS);
		expect(supervisor.failed(FOLDER, 1_000).kind).toBe("gave-up");
	});

	it("forgets the failures of a workbench that stayed up", () => {
		const supervisor = new EditorSupervisor();
		supervisor.failed(FOLDER, 0);
		supervisor.failed(FOLDER, 1);

		supervisor.loaded(FOLDER, 10);
		const verdict = supervisor.failed(FOLDER, 10 + EDITOR_HEALTHY_MS);

		// A day of editing between two crashes is not a crash loop, and the
		// second crash must start again at the shortest wait.
		expect(verdict).toEqual({
			kind: "restart",
			attempt: 1,
			delayMs: RESTART_BACKOFF_MS,
		});
	});

	it("stays given up however many times it is asked", () => {
		const supervisor = new EditorSupervisor();
		for (let attempt = 0; attempt <= MAX_EDITOR_RESTARTS; attempt += 1) {
			supervisor.failed(FOLDER, 0);
		}

		expect(supervisor.gaveUp(FOLDER)).toBe(true);
		expect(supervisor.failed(FOLDER, 0).kind).toBe("gave-up");
		supervisor.loaded(FOLDER, 0);
		expect(supervisor.gaveUp(FOLDER)).toBe(true);
	});
});

/**
 * What `syncEditorViews` does with the supervisor, on each projection.
 *
 * The loop is reproduced rather than imported because `AppController` is an
 * Electron main process; what is under test is the rule it applies, and the
 * rule is entirely the supervisor's.
 */
function projection(
	supervisor: EditorSupervisor,
	wanted: readonly string[],
): readonly string[] {
	for (const folder of supervisor.gaveUpKeys()) {
		if (!wanted.includes(folder)) {
			supervisor.park(folder);
		} else if (supervisor.parked(folder)) {
			supervisor.forget(folder);
		}
	}
	return wanted.filter((folder) => !supervisor.gaveUp(folder));
}

describe("what a projection tick may attempt", () => {
	it("never attempts a folder the supervisor has given up on", () => {
		const supervisor = new EditorSupervisor();
		for (let attempt = 0; attempt <= MAX_EDITOR_RESTARTS; attempt += 1) {
			supervisor.failed(FOLDER, 0);
		}

		// The wake cadence: a tick every 300 ms, for ten seconds. Not one of
		// them is an attempt, and not one of them is a notice.
		const attempts = Array.from({ length: 33 }, () =>
			projection(supervisor, [FOLDER, "/dev/other"]),
		);

		expect(attempts.every((attempted) => !attempted.includes(FOLDER))).toBe(
			true,
		);
		expect(attempts.at(-1)).toEqual(["/dev/other"]);
	});

	it("attempts it again once a person has asked for it again", () => {
		const supervisor = new EditorSupervisor();
		for (let attempt = 0; attempt <= MAX_EDITOR_RESTARTS; attempt += 1) {
			supervisor.failed(FOLDER, 0);
		}

		// Giving up made the Workspace unavailable, so it leaves the wanted
		// set; Retry puts it back. Only that round trip clears the verdict —
		// the tick between giving up and the model catching up must not.
		expect(projection(supervisor, [FOLDER])).toEqual([]);
		expect(supervisor.gaveUp(FOLDER)).toBe(true);
		projection(supervisor, []);
		expect(projection(supervisor, [FOLDER])).toEqual([FOLDER]);
		expect(supervisor.gaveUp(FOLDER)).toBe(false);
	});
});

describe("the wake health pass", () => {
	it("names the workbenches that did not survive the sleep", () => {
		expect(
			deadEditorKeys([
				{ key: "/dev/api", alive: false },
				{ key: "/dev/web", alive: true },
				{ key: "", alive: false },
			]),
		).toEqual(["/dev/api", ""]);
	});

	it("has nothing to say when every workbench is still there", () => {
		expect(deadEditorKeys([{ key: "/dev/api", alive: true }])).toEqual([]);
	});
});

describe("where giving up is reported", () => {
	it("puts a Workspace's workbench on that Workspace", () => {
		for (const reason of REJECTIONS) {
			expect(
				editorGaveUpFailure({ workspaceId: "ws-1", attempt: 6, reason }),
			).toEqual({
				subject: "workspace",
				id: "ws-1",
				code: "editor_restart_exhausted",
				detail: `The workbench stopped 6 times. ${reason}`,
			});
		}
	});

	it("speaks app-wide only for the editor no Workspace owns", () => {
		expect(
			editorGaveUpFailure({
				workspaceId: undefined,
				attempt: 6,
				reason: "Scratch died.",
			}),
		).toEqual({
			subject: "app",
			code: "editor_restart_exhausted",
			detail: "The workbench stopped 6 times. Scratch died.",
		});
	});
});
