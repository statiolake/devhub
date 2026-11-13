/**
 * A `devhub:` link from outside DevHub: queued until DevHub is ready (a link
 * that launched it), followed at once after (a link to the running app), one
 * at a time, through the same navigation an in-app chip uses.
 */

import { describe, expect, it, vi } from "vitest";
import { DevhubUrlOpens, devhubUrlsIn } from "./openFromUrl.js";
import {
	parseExternalDevhubUrl,
	resolveDevhubLink,
	type LinkPlaces,
} from "../../model/devhubLink.js";
import { navigateLink } from "../../model/devhubLinkNavigation.js";
import type { AppIntentWire } from "../../ipc/appShell.js";

const AGENT = "3f2a9c1e-7b4d-4e2a-9c1e-7b4d4e2a9c1e";

const PLACES: LinkPlaces = {
	workspaces: [
		{
			id: "w1",
			label: "login-fix",
			root: "/Users/me/app",
			local: true,
			agents: [{ id: AGENT, displayName: "API fix", status: "idle" }],
		},
	],
	tasks: [{ id: 3, title: "列追加", status: "answer" }],
	escalations: [],
	orchestrator: true,
};

/** `AppController.openDevhubUrl`'s routing, with the intents recorded. */
function follower() {
	const intents: AppIntentWire[] = [];
	const open = async (url: string) => {
		const parsed = parseExternalDevhubUrl(url);
		if (!parsed.ok) throw new Error(parsed.problem);
		const found = resolveDevhubLink(parsed.link, PLACES);
		if (!found.found) throw new Error(found.why);
		await navigateLink(found.target, {
			dispatch: (intent) => {
				intents.push(intent);
				return Promise.resolve(undefined);
			},
			openLinkedFile: () => Promise.resolve(),
			sessionAgent: () => Promise.resolve(null),
		});
	};
	return { intents, open };
}

describe("links from outside DevHub", () => {
	it("waits for DevHub on a cold start, then follows each as an explicit move", async () => {
		const queue = new DevhubUrlOpens();
		queue.offer(`devhub://agent/${AGENT}`);
		queue.offer("devhub:task/3");
		expect(queue.queued).toBe(2);
		const { intents, open } = follower();
		queue.answerWith(open, vi.fn());
		await queue.settled();
		expect(queue.queued).toBe(0);
		expect(intents).toEqual([
			{
				type: "select_context",
				context: { kind: "agent", agentId: AGENT },
				reason: "explicit",
			},
			{
				type: "show_orchestrator_view",
				view: { kind: "task", id: 3 },
				reason: "explicit",
			},
		]);
	});

	it("follows a link to the running app at once, and says one that leads nowhere", async () => {
		const queue = new DevhubUrlOpens();
		const { intents, open } = follower();
		const report = vi.fn();
		queue.answerWith(open, report);
		queue.offer("devhub:agent/ffff0000");
		queue.offer("devhub:workspace/login-fix/");
		await queue.settled();
		expect(report).toHaveBeenCalledTimes(1);
		expect(intents).toEqual([
			{
				type: "select_context",
				context: { kind: "workspace", workspaceId: "w1" },
				reason: "explicit",
			},
		]);
	});

	it("finds a link on a command line, which is how a second launch hands one over", () => {
		expect(
			devhubUrlsIn([
				"--user-data-dir=/x",
				"devhub://agent/3f2a",
				"/tmp/a.md",
				"DEVHUB:task/3",
			]),
		).toEqual(["devhub://agent/3f2a", "DEVHUB:task/3"]);
	});

	it("has one answerer", () => {
		const queue = new DevhubUrlOpens();
		queue.answerWith(() => Promise.resolve(), vi.fn());
		expect(() => {
			queue.answerWith(() => Promise.resolve(), vi.fn());
		}).toThrow();
	});
});
