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
const SIDEBAR = "sidebar page";
const AGENTS = "agents page";
const PICKER = "picker page";
const TOASTS = "toasts page";
const SETTINGS = "settings page";

function pages(options?: {
	readonly picker?: boolean;
	readonly toasts?: boolean;
	readonly gone?: boolean;
}) {
	return {
		window: {
			isDestroyed: () => options?.gone === true,
			webContents: SHELL,
		},
		sidebar: { contents: () => SIDEBAR as string | undefined },
		agents: { contents: () => AGENTS as string | undefined },
		picker: {
			contents: () => (options?.picker === false ? undefined : PICKER),
		},
		toasts: {
			contents: () => (options?.toasts === false ? undefined : TOASTS),
		},
	};
}

describe("a projection", () => {
	it("goes to every page that draws from the model", () => {
		expect(projectionAudience(pages())).toEqual([
			SHELL,
			SIDEBAR,
			AGENTS,
			PICKER,
		]);
	});

	it("goes to the one page there is before the picker exists", () => {
		expect(projectionAudience(pages({ picker: false }))).toEqual([
			SHELL,
			SIDEBAR,
			AGENTS,
		]);
	});
});

describe("a failure", () => {
	it("reaches exactly one page: the one that draws failures", () => {
		expect(displayAudience(pages())).toEqual([TOASTS]);
		expect(displayAudience(pages())).toHaveLength(1);
	});

	/**
	 * The page it began on makes no difference while that page is one of this
	 * window's own. The App Shell page, the picker and the toasts page itself
	 * all draw a failure in the same place, because there is one place.
	 */
	it("is drawn on the toasts view wherever in this window it began", () => {
		expect(displayAudience(pages(), SHELL)).toEqual([TOASTS]);
		expect(displayAudience(pages(), SIDEBAR)).toEqual([TOASTS]);
		expect(displayAudience(pages(), AGENTS)).toEqual([TOASTS]);
		expect(displayAudience(pages(), PICKER)).toEqual([TOASTS]);
		expect(displayAudience(pages(), TOASTS)).toEqual([TOASTS]);
	});

	/**
	 * Settings is its own window. A failure raised there and drawn on the shell
	 * window's notices is a report about what the person is looking at, put on
	 * a window they are not — and possibly on one that is hidden.
	 */
	it("goes back to the window it began in when that is not this one", () => {
		expect(displayAudience(pages(), SETTINGS)).toEqual([SETTINGS]);
	});

	it("still reaches Settings when the shell window has gone", () => {
		expect(displayAudience(pages({ gone: true }), SETTINGS)).toEqual([
			SETTINGS,
		]);
	});
});

describe("a window that has gone", () => {
	it("has no audience of either kind", () => {
		expect(projectionAudience(pages({ gone: true }))).toEqual([]);
		expect(displayAudience(pages({ gone: true }))).toEqual([]);
	});
});
