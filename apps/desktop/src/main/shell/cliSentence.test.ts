/**
 * The command line's half of the one conversion, and what Finder's "Open With
 * DevHub" is told through it.
 *
 * `openFromCli` runs under `asSentence`, and Finder's open is `openFromCli`
 * too: a refusal there ends at `noteFailure`, which draws it with
 * `errorWire`. So what `asSentence` throws has to print as a sentence and
 * still be the failure it was, under its own title.
 */

import { describe, expect, it } from "vitest";
import {
	carriedAcrossIpc,
	errorWire,
	errorWireAt,
	withDetail,
} from "../../model/wire.js";
import { portFailure } from "../terminal/ports.js";
import { asSentence } from "./cliSentence.js";

async function refusal(failure: unknown): Promise<unknown> {
	return asSentence(() => Promise.reject(failure)).then(
		() => {
			throw new Error("it did not fail");
		},
		(thrown: unknown) => thrown,
	);
}

describe("a refusal through the command line's conversion", () => {
	const wire = withDetail(
		errorWireAt("workspace_unavailable"),
		"/srv/api is not there any more.",
	);

	it("prints as its title and its detail", async () => {
		const thrown = await refusal(carriedAcrossIpc(wire));
		expect((thrown as Error).message).toBe(
			"The workspace is unavailable. /srv/api is not there any more.",
		);
	});

	it("is still drawn under its own title when nothing prints it (a Finder open)", async () => {
		expect(errorWire(await refusal(carriedAcrossIpc(wire)))).toMatchObject({
			code: "workspace_unavailable",
			summary: "The workspace is unavailable.",
			detail: "/srv/api is not there any more.",
		});
	});

	it("prints a failure raised with its code under its title too", async () => {
		const thrown = await refusal(
			portFailure("unavailable", { detail: "build-box did not answer." }),
		);
		expect((thrown as Error).message).toBe(
			"The machine is unavailable. build-box did not answer.",
		);
		expect(errorWire(thrown).code).toBe("machine_unavailable");
	});

	it("passes a failure nobody worded on as it is", async () => {
		const bug = new Error("boom");
		expect(await refusal(bug)).toBe(bug);
	});
});
