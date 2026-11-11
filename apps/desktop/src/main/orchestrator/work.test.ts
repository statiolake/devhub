/**
 * Who worked on what (`work.ts`), the memos (`memos.ts`) and the one subject
 * key they share (`subjects.ts`): the mapping, its moves, its pruning and
 * its files.
 */

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	MAX_MEMO_TEXT,
	MEMO_AGENT_GRACE_MS,
	MEMO_DONE_GRACE_MS,
	MemoBook,
	MemoFile,
} from "./memos.js";
import { readSubject, subjectToken, itemOfUrl } from "./subjects.js";
import {
	WORK_DONE_GRACE_MS,
	WorkBook,
	WorkFile,
	type LiveWorkAgent,
} from "./work.js";
import { composeDelivery, type OrchestratorEvent } from "./events.js";

const DAY = 24 * 60 * 60_000;
const ISSUE = "https://github.com/Acme/App/issues/128";

function agent(overrides: Partial<LiveWorkAgent> = {}): LiveWorkAgent {
	return {
		agentId: "a1",
		name: "128 login fix",
		named: true,
		profileId: "claude",
		kind: "claude",
		presentation: "gui",
		machine: "ssh:box",
		folder: "/src/app_128",
		branch: "128-fix",
		issue: ISSUE,
		session: "s1",
		...overrides,
	};
}

function tempPath(name: string): string {
	return join(mkdtempSync(join(tmpdir(), "devhub-work-")), name);
}

describe("the subject key", () => {
	it("reads every way a subject is named, items without case", () => {
		expect(readSubject("issue=acme/app#12")).toEqual({
			kind: "item",
			key: "item acme/app#12",
			itemKind: "issue",
		});
		expect(readSubject("pr=Acme/App#9")).toMatchObject({
			key: "item acme/app#9",
		});
		expect(readSubject("https://github.com/acme/app/pull/9/files")).toEqual({
			kind: "item",
			key: "item acme/app#9",
			itemKind: "pr",
		});
		expect(readSubject("acme/app#3")).toEqual({
			kind: "item",
			key: "item acme/app#3",
		});
		expect(readSubject("esc=04")).toEqual({ kind: "esc", key: "esc 4" });
		expect(readSubject("req=2")).toEqual({ kind: "req", key: "req 2" });
		expect(readSubject("agent=ab12")).toEqual({ kind: "agent", id: "ab12" });
		expect(readSubject("ws=app")).toEqual({ kind: "ws", workspace: "app" });
		expect(readSubject("whatever")).toBeUndefined();
		expect(subjectToken("item acme/app#9", "pr")).toBe("pr=acme/app#9");
		expect(subjectToken("agent a1")).toBe("agent=a1");
		expect(itemOfUrl("https://example.com/x")).toBeUndefined();
	});
});

describe("who worked on what", () => {
	it("keeps an agent under its item with its sessions, and marks it stopped when it is gone", () => {
		const book = new WorkBook();
		book.observe([agent()], 1000);
		book.observe([agent({ session: "s2" })], 2000);
		book.observe([], 3000);
		const record = book.get("item acme/app#128")!;
		expect(record).toMatchObject({ url: ISSUE, itemKind: "issue" });
		expect(record.agents).toEqual([
			expect.objectContaining({
				agentId: "a1",
				machine: "ssh:box",
				folder: "/src/app_128",
				sessions: ["s1", "s2"],
				startedAt: 1000,
				stoppedAt: 3000,
			}),
		]);
	});

	it("takes a resumed agent as the same one: its session's entry, under the new id", () => {
		const book = new WorkBook();
		book.observe([agent()], 1000);
		book.observe([], 2000);
		book.observe([agent({ agentId: "a2" })], 3000);
		const record = book.get("item acme/app#128")!;
		expect(record.agents.map((one) => one.agentId)).toEqual(["a2"]);
		expect(record.agents[0]!.stoppedAt).toBeUndefined();
		expect(record.agents[0]!.startedAt).toBe(1000);
		expect(book.byAgent("a2")?.record.subject).toBe("item acme/app#128");
	});

	it("moves work with no Issue to its Issue once linked, and says so for the memos", () => {
		const book = new WorkBook();
		book.observe([agent({ issue: "pending" })], 1000);
		expect(book.get("agent a1")).toBeDefined();
		const moves = book.observe([agent()], 2000);
		expect(moves).toEqual([{ from: "agent a1", to: "item acme/app#128" }]);
		expect(book.get("agent a1")).toBeUndefined();
		// Resumed under a new id with no item yet: the subject follows the id.
		const pending = new WorkBook();
		pending.observe([agent({ issue: undefined })], 1000);
		pending.observe([], 1500);
		expect(
			pending.observe([agent({ agentId: "a2", issue: undefined })], 2000),
		).toEqual([{ from: "agent a1", to: "agent a2" }]);
	});

	it("keeps a second agent of one subject as its own entry, the latest last", () => {
		const book = new WorkBook();
		book.observe([agent()], 1000);
		book.observe([agent({ agentId: "b1", session: "t1" })], 2000);
		expect(
			book.get("item acme/app#128")!.agents.map((one) => one.agentId),
		).toEqual(["a1", "b1"]);
		expect(book.get("item acme/app#128")!.agents[0]!.stoppedAt).toBe(2000);
	});

	it("takes the session it was closed on, and is pruned a week after its item was read done", () => {
		const book = new WorkBook();
		book.observe([agent({ session: undefined })], 1000);
		book.closed(agent({ session: "s9" }), 2000);
		expect(book.get("item acme/app#128")!.agents[0]).toMatchObject({
			sessions: ["s9"],
			stoppedAt: 2000,
		});
		const done = (key: string) =>
			key === "item acme/app#128" ? 5000 : undefined;
		book.prune(done, 5000);
		expect(book.get("item acme/app#128")!.doneSince).toBe(5000);
		book.prune(done, 5000 + WORK_DONE_GRACE_MS - 1);
		expect(book.get("item acme/app#128")).toBeDefined();
		book.prune(done, 5000 + WORK_DONE_GRACE_MS + 1);
		expect(book.get("item acme/app#128")).toBeUndefined();
	});

	it("is kept across restarts in its file, and a file that does not read is moved aside", () => {
		const path = tempPath("orchestrator-work.json");
		const book = new WorkBook(new WorkFile(path));
		book.observe([agent()], 1000);
		book.observe([], 2000);
		const again = new WorkBook(new WorkFile(path));
		expect(again.get("item acme/app#128")).toEqual(
			book.get("item acme/app#128"),
		);
		writeFileSync(path, "{ not json");
		const file = new WorkFile(path);
		expect(new WorkBook(file).all()).toEqual([]);
		expect(file.refused).toMatch(/moved to .*\.corrupt/u);
		expect(existsSync(`${path}.corrupt`)).toBe(true);
	});
});

describe("the memos", () => {
	it("keeps one note per subject: set replaces it, clear takes it away", () => {
		const book = new MemoBook();
		book.set("item Acme/App#1", "レビュー指摘 2 件を直させる", 1);
		book.set("item acme/app#1", "  CI が通ったら人にレビューを頼む\n", 2);
		expect(book.get("item acme/app#1")).toEqual({
			subject: "item acme/app#1",
			text: "CI が通ったら人にレビューを頼む",
			at: 2,
		});
		expect(book.all()).toHaveLength(1);
		expect(book.clear("item acme/app#1")).toBe(true);
		expect(book.clear("item acme/app#1")).toBe(false);
	});

	it("refuses a note that is empty or longer than the next step", () => {
		const book = new MemoBook();
		expect(() => book.set("esc 1", "  ", 1)).toThrow(/empty/u);
		expect(() => book.set("esc 1", "x".repeat(MAX_MEMO_TEXT + 1), 1)).toThrow(
			/keep it to 500: what you will do next/u,
		);
		expect(book.set("esc 1", "x".repeat(MAX_MEMO_TEXT), 1).text).toHaveLength(
			MAX_MEMO_TEXT,
		);
	});

	it("follows its work to another subject; of two, the later set stays", () => {
		const book = new MemoBook();
		book.set("agent a1", "調査が終わったら Issue を起票させる", 3);
		book.set("item acme/app#1", "古い", 2);
		book.rename("agent a1", "item acme/app#1");
		expect(book.get("agent a1")).toBeUndefined();
		expect(book.get("item acme/app#1")).toMatchObject({
			text: "調査が終わったら Issue を起票させる",
			at: 3,
		});
		book.set("agent a2", "古いほう", 1);
		book.rename("agent a2", "item acme/app#1");
		expect(book.get("item acme/app#1")!.text).toBe(
			"調査が終わったら Issue を起票させる",
		);
	});

	it("is pruned: done subjects after a week, gone ones at once, an unknown agent's after a month", () => {
		const book = new MemoBook();
		book.set("item acme/app#1", "a", 0);
		book.set("esc 3", "b", 0);
		book.set("req 9", "c", 0);
		book.set("agent a1", "d", 0);
		book.set("agent a2", "e", 0);
		const facts = {
			doneAt: (key: string) => (key === "item acme/app#1" ? 10 : undefined),
			gone: (key: string) => key === "req 9",
			agentKnown: (key: string) => key === "agent a2",
		};
		book.prune(facts, 10);
		expect(book.get("req 9")).toBeUndefined();
		expect(book.get("item acme/app#1")!.doneSince).toBe(10);
		book.prune(facts, 10 + MEMO_DONE_GRACE_MS + 1);
		expect(book.get("item acme/app#1")).toBeUndefined();
		expect(book.get("esc 3")).toBeDefined();
		book.prune(facts, MEMO_AGENT_GRACE_MS + 1);
		expect(book.get("agent a1")).toBeUndefined();
		expect(book.get("agent a2")).toBeDefined();
		book.prune(facts, 181 * DAY);
		expect(book.all()).toEqual([]);
	});

	it("is kept across restarts in its file", () => {
		const path = tempPath("orchestrator-memos.json");
		new MemoBook(new MemoFile(path)).set("item acme/app#1", "残り", 5);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			version: 2,
			memos: [{ subject: "item acme/app#1", text: "残り", at: 5 }],
		});
		expect(new MemoBook(new MemoFile(path)).get("item acme/app#1")).toEqual({
			subject: "item acme/app#1",
			text: "残り",
			at: 5,
		});
	});

	it("reads a version 1 file (a log of entries) as each subject's latest entry", () => {
		const path = tempPath("orchestrator-memos.json");
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				memos: [
					{
						subject: "item acme/app#1",
						entries: [
							{ at: 1, text: "## 残り\n- 指摘 2 件", by: "orch" },
							{ at: 4, text: "次: CI を直させる", by: "orch" },
						],
						doneSince: 9,
					},
					{ subject: "esc 2", entries: [] },
				],
			}),
		);
		const file = new MemoFile(path);
		const book = new MemoBook(file);
		expect(file.refused).toBeUndefined();
		expect(book.all()).toEqual([
			{
				subject: "item acme/app#1",
				text: "次: CI を直させる",
				at: 4,
				doneSince: 9,
			},
		]);
		book.set("esc 3", "回答を待つ", 10);
		expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(2);
	});

	it("is not put on delivered lines: board, list and show carry it", () => {
		const line: OrchestratorEvent = {
			type: "needs_action",
			subject: {
				kind: "issue",
				item: {
					repo: "acme/app",
					number: 1,
					url: "https://github.com/acme/app/issues/1",
				},
			},
			breach: { clause: "idle_no_escalation" },
		};
		const plan = composeDelivery(
			[],
			[line],
			{ event_prompt: "{EVENT}", init_prompt: undefined },
			0,
		);
		expect(plan.batch).toMatch(/^\[needs_action\] issue=acme\/app#1 /u);
		expect(plan.batch).not.toContain("メモ");
	});
});
