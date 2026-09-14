import { describe, expect, it } from "vitest";
import { MachineConditions } from "./machineConditions.js";
import type { RuntimeId } from "../runtime/runtime.js";

const HOST = "ssh:example" as RuntimeId;

function conditions(options?: {
	successesToRetract?: number;
	minimumAgeMs?: number;
}) {
	const said: { source: string; summary: string | undefined }[] = [];
	let clock = 0;
	const subject = new MachineConditions({
		publish: (source, summary) => {
			said.push({ source, summary });
		},
		successesToRetract: options?.successesToRetract ?? 2,
		minimumAgeMs: options?.minimumAgeMs ?? 0,
		now: () => clock,
	});
	return {
		subject,
		said,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

describe("a machine that is not answering", () => {
	it("is said once, however many rounds fail", () => {
		const { subject, said } = conditions();
		for (let round = 0; round < 10; round += 1) {
			subject.failed(HOST, "DevHub cannot reach this machine.");
		}
		expect(said).toEqual([
			{
				source: "machine:ssh:example",
				summary: "DevHub cannot reach this machine.",
			},
		]);
	});

	it("keeps the episode's first words when a later round fails differently", () => {
		const { subject, said } = conditions();
		subject.failed(HOST, "DevHub cannot reach this machine.");
		subject.failed(HOST, "The tmux server did not answer in time.");
		expect(said).toHaveLength(1);
		expect(said[0]?.summary).toBe("DevHub cannot reach this machine.");
	});

	/**
	 * The flap, as it was reported: a host that answers one round in three.
	 * Every failing round used to raise a notice and every success to take one
	 * away, so the window reflowed twice a second. One round is not a recovery.
	 */
	it("does not blink through an alternating fail/success episode", () => {
		const { subject, said } = conditions({ successesToRetract: 2 });
		for (let round = 0; round < 6; round += 1) {
			subject.failed(HOST, "DevHub cannot reach this machine.");
			subject.succeeded(HOST);
		}
		expect(said).toHaveLength(1);
		expect(said[0]?.summary).toBeDefined();
	});

	it("is retracted once the machine has answered enough rounds in a row", () => {
		const { subject, said } = conditions({ successesToRetract: 2 });
		subject.failed(HOST, "DevHub cannot reach this machine.");
		subject.succeeded(HOST);
		expect(said).toHaveLength(1);
		subject.succeeded(HOST);
		expect(said).toEqual([
			{
				source: "machine:ssh:example",
				summary: "DevHub cannot reach this machine.",
			},
			{ source: "machine:ssh:example", summary: undefined },
		]);
		// And having been retracted, it is news again if it comes back.
		subject.failed(HOST, "DevHub cannot reach this machine.");
		expect(said).toHaveLength(3);
	});

	it("stays up until it is old enough to have been read", () => {
		const { subject, said, advance } = conditions({
			successesToRetract: 1,
			minimumAgeMs: 5_000,
		});
		subject.failed(HOST, "DevHub cannot reach this machine.");
		subject.succeeded(HOST);
		expect(said).toHaveLength(1);
		advance(5_000);
		subject.succeeded(HOST);
		expect(said[1]).toEqual({
			source: "machine:ssh:example",
			summary: undefined,
		});
	});

	it("goes with a machine DevHub has let go of", () => {
		const { subject, said } = conditions();
		subject.failed(HOST, "DevHub cannot reach this machine.");
		subject.forget(HOST);
		expect(said[1]?.summary).toBeUndefined();
		// Nothing to take down twice.
		subject.forget(HOST);
		expect(said).toHaveLength(2);
	});

	it("says nothing about a machine that never failed", () => {
		const { subject, said } = conditions();
		subject.succeeded(HOST);
		subject.forget(HOST);
		expect(said).toEqual([]);
	});
});
