/**
 * Who hears what, and the one case where "everybody" was the bug.
 *
 * A failure sent to a page that cannot draw it comes back: the page has
 * nowhere to put it, so it hands it to main, and main publishes it again. That
 * is the echo this rule exists to make impossible, and it is made impossible
 * by the audience rather than by counting repeats — a de-duplicator would have
 * to decide how long "the same failure" lasts, and any answer to that is a
 * failure somebody does not get told about.
 */

import { describe, expect, it } from "vitest";
import { displayAudience, projectionAudience } from "./publishAudience.js";

const SHELL = "shell page";
const OVERLAY = "overlay page";

function pages(options?: {
	readonly overlay?: boolean;
	readonly gone?: boolean;
}) {
	return {
		window: {
			isDestroyed: () => options?.gone === true,
			webContents: SHELL,
		},
		modals: {
			contents: () => (options?.overlay === false ? undefined : OVERLAY),
		},
	};
}

describe("a projection", () => {
	it("goes to every page that draws from the model", () => {
		expect(projectionAudience(pages())).toEqual([SHELL, OVERLAY]);
	});

	it("goes to the one page there is before the overlay exists", () => {
		expect(projectionAudience(pages({ overlay: false }))).toEqual([SHELL]);
	});
});

describe("a failure", () => {
	it("reaches exactly one page: the one that draws failures", () => {
		expect(displayAudience(pages())).toEqual([SHELL]);
		expect(displayAudience(pages())).toHaveLength(1);
	});

	it("reaches that page whether or not the overlay is up", () => {
		expect(displayAudience(pages({ overlay: false }))).toEqual([SHELL]);
	});
});

describe("a window that has gone", () => {
	it("has no audience of either kind", () => {
		expect(projectionAudience(pages({ gone: true }))).toEqual([]);
		expect(displayAudience(pages({ gone: true }))).toEqual([]);
	});
});
