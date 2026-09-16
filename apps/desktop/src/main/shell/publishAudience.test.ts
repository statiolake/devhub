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
import {
	chromeAudience,
	displayAudience,
	projectionAudience,
} from "./publishAudience.js";

const SHELL = "shell page";
const SIDEBAR = "sidebar page";
const AGENTS = "agents page";
const PICKER = "picker page";
const TOASTS = "toasts page";
const TOOLTIP = "tooltip page";
const SETTINGS = "settings page";

function pages(options?: {
	readonly picker?: boolean;
	readonly toasts?: boolean;
	readonly tooltip?: boolean;
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
		tooltip: {
			contents: () => (options?.tooltip === false ? undefined : TOOLTIP),
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

/**
 * The palette is neither a projection nor a failure, and sending it to the
 * projection audience was a coincidence that had already stopped being true.
 *
 * `toasts` has `onTheme` on its bridge and no model behind it, so it was not
 * in the projection audience and had therefore never been recoloured at
 * runtime — a page wearing the palette it was served with, on a window that
 * had since changed theme. The tooltip would have been the second such page
 * the moment it left the Sidebar's document.
 *
 * So the rule is stated rather than coincidental, and this is what keeps it
 * so: every page with `onTheme` is in this audience. That is all of them.
 */
describe("the palette", () => {
	it("goes to every page DevHub draws chrome on", () => {
		expect(chromeAudience(pages())).toEqual([
			SHELL,
			SIDEBAR,
			AGENTS,
			PICKER,
			TOASTS,
			TOOLTIP,
		]);
	});

	/**
	 * The two pages this audience exists for. A notice and a tooltip are
	 * drawn over a live workbench, so a stale palette on either is a light
	 * box on a dark window — the most visible possible way to be wrong.
	 */
	it("reaches the two pages that have no model at all", () => {
		const told = chromeAudience(pages());
		expect(told).toContain(TOASTS);
		expect(told).toContain(TOOLTIP);
		// Which is exactly what the projection audience does not do, and
		// correctly so: neither page has a snapshot to be told about.
		expect(projectionAudience(pages())).not.toContain(TOASTS);
		expect(projectionAudience(pages())).not.toContain(TOOLTIP);
	});

	it("says nothing to a window that is gone", () => {
		expect(chromeAudience(pages({ gone: true }))).toEqual([]);
	});

	it("skips a page that does not exist yet", () => {
		expect(chromeAudience(pages({ tooltip: false }))).not.toContain(TOOLTIP);
	});
});
