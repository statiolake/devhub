import { describe, expect, it } from "vitest";

import {
	NEOVIM_RESTARTED_EVENT,
	type NeovimPageEvent,
} from "../../ipc/neovim.js";
import type {
	NeovimRpc,
	NotificationListener,
	RequestHandler,
} from "./neovimRpc.js";
import { NeovimUiSessions } from "./neovimUiSessions.js";

/** A Neovim's end of one UI connection. */
class FakeNeovim implements NeovimRpc {
	closed = false;
	readonly requests: [string, readonly unknown[]][] = [];
	readonly #close: (() => void)[] = [];
	#notification: NotificationListener | undefined;
	request(method: string, params: readonly unknown[]): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("closed"));
		this.requests.push([method, params]);
		if (method === "nvim_get_api_info")
			return Promise.resolve([
				3,
				{ version: { major: 0, minor: 12, patch: 6 } },
			]);
		if (method === "nvim_get_mode") return Promise.resolve({ blocking: false });
		return Promise.resolve(null);
	}
	notify(): void {}
	onClose(listener: () => void): void {
		if (this.closed) listener();
		else this.#close.push(listener);
	}
	onNotification(listener: NotificationListener): void {
		this.#notification = listener;
	}
	onRequest(_handler: RequestHandler): void {}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const listener of this.#close.splice(0)) listener();
	}
	send(method: string, params: readonly unknown[]): void {
		this.#notification?.(method, params);
	}
	/** The size the last real attach asked for. */
	attachedAt(): readonly unknown[] | undefined {
		return this.requests.filter(([m]) => m === "nvim_ui_attach").at(-1)?.[1];
	}
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(answers: (FakeNeovim | Error)[]) {
	const events: NeovimPageEvent[] = [];
	const ended: string[] = [];
	const sessions = new NeovimUiSessions<string>({
		connect: () => {
			const next = answers.shift();
			return next === undefined || next instanceof Error
				? Promise.reject(next ?? new Error("nothing listens"))
				: Promise.resolve(next);
		},
		clipboard: { read: () => Promise.resolve(""), write: () => {} },
		output: {
			toPage: (_page, event) => events.push(event),
			bufferChanged: () => {},
			ended: (id) => ended.push(id),
		},
	});
	return { sessions, events, ended };
}

const target = {
	workspaceId: "w",
	socketPath: "/s",
	server: 1,
	cols: 80,
	rows: 24,
};

describe("an attach", () => {
	it("waits for a socket named before its Neovim listens", async () => {
		const neovim = new FakeNeovim();
		const missing = Object.assign(new Error("connect ENOENT /s"), {
			code: "ENOENT",
		});
		const refused = Object.assign(new Error("connect ECONNREFUSED /s"), {
			code: "ECONNREFUSED",
		});
		const { sessions, ended } = setup([missing, refused, neovim]);
		await sessions.attach("page", target);
		expect(neovim.attachedAt()?.slice(0, 2)).toEqual([80, 24]);
		expect(ended).toEqual([]);
	});

	it("asked twice while it connects, makes one connection: the second waits for it", async () => {
		const missing = Object.assign(new Error("connect ENOENT /s"), {
			code: "ENOENT",
		});
		const neovim = new FakeNeovim();
		const extra = new FakeNeovim();
		const { sessions, ended } = setup([missing, neovim, extra]);
		const answers = await Promise.all([
			sessions.attach("page", target),
			sessions.attach("page", { ...target, rows: 30 }),
		]);
		expect(answers).toHaveLength(2);
		expect(extra.requests).toEqual([]);
		expect(
			neovim.requests.filter(([m]) => m === "nvim_get_api_info"),
		).toHaveLength(1);
		expect(neovim.attachedAt()?.slice(0, 2)).toEqual([80, 24]);
		expect(neovim.requests.at(-1)).toEqual(["nvim_ui_try_resize", [80, 30]]);
		expect(ended).toEqual([]);
	});

	it("fails at once when the socket refuses for another reason", async () => {
		const denied = Object.assign(new Error("connect EACCES /s"), {
			code: "EACCES",
		});
		const { sessions } = setup([denied, new FakeNeovim()]);
		await expect(sessions.attach("page", target)).rejects.toThrow("EACCES");
	});
});

describe("a :restart", () => {
	it("attaches to the new server on the same socket, at the page's size, and is no end", async () => {
		const old = new FakeNeovim();
		const fresh = new FakeNeovim();
		const { sessions, events, ended } = setup([
			old,
			new Error("not yet"),
			fresh,
		]);
		await sessions.attach("page", target);
		sessions.call("w", "nvim_ui_try_resize", [100, 30]);
		old.send("redraw", [["restart", ["/s"]]]);
		old.close();
		await settle(250);
		expect(ended).toEqual([]);
		expect(fresh.attachedAt()?.slice(0, 2)).toEqual([100, 30]);
		const marker = events.findIndex(
			(e) =>
				e.type === "redraw" &&
				(e.batches[0] as unknown[])[0] === NEOVIM_RESTARTED_EVENT,
		);
		expect(marker).toBeGreaterThan(0);
		// What the new server draws goes to the same page, after the marker.
		fresh.send("redraw", [["flush", []]]);
		expect(events.at(-1)).toMatchObject({
			type: "redraw",
			batches: [["flush", []]],
		});
		// Its close, with no restart said, is the end.
		fresh.close();
		expect(ended).toEqual(["w"]);
	});

	it("is an end when the old server just exits", async () => {
		const old = new FakeNeovim();
		const { sessions, ended } = setup([old]);
		await sessions.attach("page", target);
		old.close();
		expect(ended).toEqual(["w"]);
	});
});
