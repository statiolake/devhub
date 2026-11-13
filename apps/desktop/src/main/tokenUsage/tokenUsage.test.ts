/**
 * The token aggregation, end to end on fixture transcripts: Claude's streamed
 * responses (one usage said on every content block), an inline sidechain and
 * a subagent's own file, a synthetic message, 5-minute and 1-hour cache
 * writes, several models, and a Codex rollout with a `token_count` written
 * twice — read whole and in pieces, across a restart, and added up by Agent,
 * task, Workspace, role and model.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TokenIndex, TOKEN_RETENTION_MS } from "../../model/tokenIndex.js";
import {
	canonicalModel,
	costOf,
	priceOf,
	ratesFor,
	weightedInput,
} from "../../model/tokenPrices.js";
import {
	buildTokenReport,
	resolveRange,
	type SessionOwner,
	type TokenTask,
} from "../../model/tokenReport.js";
import { claudeUsage, codexUsage } from "../../model/tokenTranscripts.js";
import type { TokenReportWire } from "../../ipc/tokenUsage.js";
import {
	TokenUsageService,
	transcriptOf,
	type TokenSource,
} from "./tokenUsageService.js";
import type {
	ListedFile,
	ReadRequest,
	TranscriptMachine,
} from "./transcriptMachine.js";
import { parseListing, parseReads } from "./transcriptMachine.js";

const fixture = (name: string): Buffer =>
	readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

const SESSION = "11111111-1111-4111-8111-111111111111";
const THREAD = "0199a0b0-0000-7000-8000-000000000001";
const CLAUDE = "/home/me/.claude";
const CODEX = "/home/me/.codex";
const MAIN = `${CLAUDE}/projects/-work-app/${SESSION}.jsonl`;
const SUB = `${CLAUDE}/projects/-work-app/${SESSION}/subagents/agent-abc123.jsonl`;
const SUB_META = SUB.replace(/\.jsonl$/u, ".meta.json");
const ROLLOUT = `${CODEX}/sessions/2026/11/13/rollout-2026-11-13T08-00-00-${THREAD}.jsonl`;

/** 2026-11-13T10:00Z: after every fixture request. */
const NOW = Date.parse("2026-11-13T10:00:00.000Z");

/** A machine whose files are a map, with every read it was asked for. */
class FakeMachine implements TranscriptMachine {
	readonly files = new Map<string, { data: Buffer; mtimeMs: number }>();
	readonly reads: ReadRequest[] = [];
	lists = 0;

	put(path: string, data: Buffer, mtimeMs = NOW): void {
		this.files.set(path, { data, mtimeMs });
	}

	append(path: string, data: Buffer): void {
		const known = this.files.get(path);
		this.put(path, Buffer.concat([known?.data ?? Buffer.alloc(0), data]));
	}

	async list(root: { root: string; cli: string }): Promise<ListedFile[]> {
		this.lists += 1;
		return [...this.files.entries()]
			.filter(([path]) => path.startsWith(`${root.root}/`))
			.map(([path, file]) => ({
				path,
				size: file.data.length,
				mtimeMs: file.mtimeMs,
			}));
	}

	async read(requests: readonly ReadRequest[]): Promise<Map<string, Buffer>> {
		this.reads.push(...requests);
		const out = new Map<string, Buffer>();
		for (const one of requests) {
			const file = this.files.get(one.path);
			if (file)
				out.set(
					one.path,
					file.data.subarray(one.offset, one.offset + one.length),
				);
		}
		return out;
	}
}

function machineWithFixtures(): FakeMachine {
	const machine = new FakeMachine();
	machine.put(MAIN, fixture("claude-session.jsonl"));
	machine.put(SUB, fixture("claude-subagent.jsonl"));
	machine.put(SUB_META, fixture("claude-subagent.meta.json"));
	machine.put(ROLLOUT, fixture("codex-rollout.jsonl"));
	return machine;
}

function serviceOn(
	machine: TranscriptMachine,
	options: {
		saved?: { value: unknown };
		remote?: TranscriptMachine;
		now?: () => number;
	} = {},
): TokenUsageService {
	const saved = options.saved ?? { value: undefined };
	const sources: TokenSource[] = [
		{ root: { machine: "local", cli: "claude", root: CLAUDE }, machine },
		{ root: { machine: "local", cli: "codex", root: CODEX }, machine },
		...(options.remote
			? [
					{
						root: { machine: "ssh:box", cli: "claude" as const, root: CLAUDE },
						machine: options.remote,
					},
				]
			: []),
	];
	return new TokenUsageService({
		sources: async () => sources,
		load: async () => saved.value,
		save: async (value) => {
			saved.value = JSON.parse(JSON.stringify(value));
		},
		now: options.now ?? (() => NOW),
	});
}

const OWNER: SessionOwner = {
	agentId: "agent-1",
	name: "Builder",
	profile: "Claude",
	machine: "local",
	workspaceId: "ws-1",
	workspaceLabel: "app",
	role: "worker",
};

const context = {
	tasks: [] as readonly TokenTask[],
	workspaces: [
		{ id: "ws-1", label: "app", machine: "local", root: "/work/app" },
		{ id: "ws-2", label: "api", machine: "local", root: "/work/api" },
	],
	windows: { fiveHourResetsAt: Date.parse("2026-11-13T12:00:00.000Z") },
};

function row(report: TokenReportWire, id: string) {
	const found = report.rows.find((one) => one.id === id);
	if (!found)
		throw new Error(
			`no row ${id} in ${report.rows.map((r) => r.id).join(", ")}`,
		);
	return found;
}

describe("the transcripts", () => {
	it("reads Claude's usage per line, the split of cache writes included", () => {
		const { events, state } = claudeUsage(
			fixture("claude-session.jsonl").toString("utf8"),
			{},
		);
		expect(state).toEqual({ cwd: "/work/app", session: SESSION });
		// Three lines of msg_1, two of msg_2, the sidechain, msg_3; the
		// synthetic message is no request.
		expect(events.map((one) => one.key)).toEqual([
			"msg_1",
			"msg_1",
			"msg_1",
			"msg_2",
			"msg_2",
			"msg_side",
			"msg_3",
		]);
		expect(events[0]!.counts).toEqual({
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite5m: 1000,
			cacheWrite1h: 2000,
		});
		// No split given: every write is the default TTL, five minutes.
		expect(events[3]!.counts.cacheWrite5m).toBe(500);
		expect(events[5]!.subagent).toBe("inline1");
	});

	it("reads one Codex request per new running total, the cached part apart", () => {
		const { events, state } = codexUsage(
			fixture("codex-rollout.jsonl").toString("utf8"),
			{},
		);
		expect(state).toEqual({
			session: THREAD,
			cwd: "/work/api",
			model: "gpt-5.1-codex",
		});
		expect(events.map((one) => one.key)).toEqual([
			`${THREAD}:5300`,
			`${THREAD}:5300`,
			`${THREAD}:12500`,
		]);
		expect(events[2]!.counts).toEqual({
			input: 3000,
			output: 200,
			cacheRead: 4000,
			cacheWrite5m: 0,
			cacheWrite1h: 0,
		});
	});

	it("knows a transcript by its path", () => {
		expect(transcriptOf("claude", CLAUDE, MAIN)).toEqual({ session: SESSION });
		expect(transcriptOf("claude", CLAUDE, SUB)).toEqual({
			session: SESSION,
			subagent: "abc123",
		});
		expect(transcriptOf("claude", CLAUDE, `${CLAUDE}/todos/x.jsonl`)).toBe(
			undefined,
		);
		expect(transcriptOf("codex", CODEX, ROLLOUT)).toEqual({ session: THREAD });
	});

	it("parses what the machine scripts print", () => {
		expect(parseListing("12 1700000000 /a b/c.jsonl\nnoise\n")).toEqual([
			{ path: "/a b/c.jsonl", size: 12, mtimeMs: 1_700_000_000_000 },
		]);
		const reads = parseReads(
			Buffer.from('\u001e/a.jsonl\n{"x":1}\n{"y"\u001e/b.jsonl\n'),
		);
		expect(reads.get("/a.jsonl")?.toString()).toBe('{"x":1}\n{"y"');
		expect(reads.get("/b.jsonl")?.length).toBe(0);
	});
});

describe("the prices", () => {
	it("names a model as the table does", () => {
		expect(canonicalModel("claude-haiku-4-5-20251001")).toBe(
			"claude-haiku-4-5",
		);
		expect(canonicalModel("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
		expect(canonicalModel("us.anthropic.claude-sonnet-5-5")).toBe(
			"claude-sonnet-5-5",
		);
		expect(priceOf("claude-opus-5-5")?.label).toBe("Opus 5.5");
		expect(priceOf("claude-opus-5")?.label).toBe("Opus 5");
		expect(priceOf("gpt-5.1-codex")).toBe(undefined);
	});

	it("weighs cache reads at the model's price and writes at 1.25× and 2×", () => {
		const counts = {
			input: 10,
			output: 200,
			cacheRead: 3000,
			cacheWrite5m: 1000,
			cacheWrite1h: 2000,
		};
		const opus = ratesFor("claude-opus-5-5", counts)!;
		// $4 in, $20 out, reads $0.20 (0.05×).
		expect(weightedInput(counts, opus)).toBeCloseTo(10 + 150 + 1250 + 4000);
		expect(costOf(counts, opus)).toBeCloseTo(
			(10 * 4 + 3000 * 0.2 + 1000 * 5 + 2000 * 8 + 200 * 20) / 1e6,
		);
		expect(ratesFor("claude-opus-5-5", counts, true)?.input).toBe(8);
		// Haiku 5.5's long prompts are priced higher.
		expect(
			ratesFor("claude-haiku-5-5", { ...counts, cacheRead: 200_000 })?.input,
		).toBe(0.5);
	});
});

describe("the index", () => {
	it("keeps a streamed response once, at the largest of each count", () => {
		const index = new TokenIndex();
		const { events, state } = claudeUsage(
			fixture("claude-session.jsonl").toString("utf8"),
			{},
		);
		index.ingest(
			{ machine: "local", cli: "claude", path: MAIN, session: SESSION },
			{ start: 0, consumed: 1, size: 1, mtimeMs: NOW, state, events },
			NOW,
		);
		const records = [...index.records()];
		expect(records.map((one) => one.key)).toEqual([
			"msg_1",
			"msg_2",
			"msg_side",
			"msg_3",
		]);
		expect(records[0]!.counts.output).toBe(200);
	});

	it("keeps a request once across files: a resumed session's copy adds nothing", async () => {
		const machine = machineWithFixtures();
		machine.put(
			`${CLAUDE}/projects/-work-app/22222222-2222-4222-8222-222222222222.jsonl`,
			fixture("claude-session.jsonl"),
		);
		const service = serviceOn(machine);
		await service.refresh();
		expect(service.index.size).toBe(4 + 2 + 2);
	});

	it("reads a file in pieces to the same requests as whole", async () => {
		const whole = serviceOn(machineWithFixtures());
		await whole.refresh();
		const machine = new FakeMachine();
		const session = fixture("claude-session.jsonl");
		const rollout = fixture("codex-rollout.jsonl");
		const pieces = serviceOn(machine);
		// Cut anywhere, mid-line included.
		for (let at = 0; at < Math.max(session.length, rollout.length); at += 333) {
			machine.put(MAIN, session.subarray(0, at));
			machine.put(ROLLOUT, rollout.subarray(0, at));
			await pieces.refresh();
		}
		machine.put(MAIN, session);
		machine.put(ROLLOUT, rollout);
		await pieces.refresh();
		const keys = (service: TokenUsageService) =>
			[...service.index.records()]
				.filter((one) => one.subagent !== "abc123")
				.map((one) => [one.key, one.counts])
				.sort();
		expect(keys(pieces)).toEqual(keys(whole));
	});

	it("reads only what was written since, and nothing after a restart", async () => {
		const machine = machineWithFixtures();
		const saved = { value: undefined as unknown };
		const service = serviceOn(machine, { saved });
		await service.refresh();
		expect(machine.reads.find((one) => one.path === MAIN)?.offset).toBe(0);
		const size = fixture("claude-session.jsonl").length;
		machine.reads.length = 0;
		await service.refresh();
		expect(machine.reads).toEqual([]);
		machine.append(
			MAIN,
			Buffer.from(
				`${JSON.stringify({
					type: "assistant",
					timestamp: "2026-11-13T09:30:00.000Z",
					sessionId: SESSION,
					message: {
						id: "msg_4",
						model: "claude-opus-5-5",
						usage: { input_tokens: 7, output_tokens: 3 },
					},
				})}\n`,
			),
		);
		await service.refresh();
		expect(machine.reads.map((one) => [one.path, one.offset])).toEqual([
			[MAIN, size],
		]);
		await service.save();
		// A restart: the saved index, read from where it was.
		machine.reads.length = 0;
		const again = serviceOn(machine, { saved });
		await again.refresh();
		expect(machine.reads).toEqual([]);
		expect(again.index.size).toBe(service.index.size);
		expect(
			[...again.index.records()].find((one) => one.key === "msg_4")?.counts
				.input,
		).toBe(7);
	});

	it("leaves the saved index alone when nothing was read this run", async () => {
		const saved = { value: { version: 1, kept: true } as unknown };
		await serviceOn(machineWithFixtures(), { saved }).save();
		expect(saved.value).toEqual({ version: 1, kept: true });
	});

	it("reads a rewritten file again from the start", async () => {
		const machine = machineWithFixtures();
		const service = serviceOn(machine);
		await service.refresh();
		machine.put(
			MAIN,
			Buffer.from(
				`${JSON.stringify({
					type: "assistant",
					timestamp: "2026-11-13T09:40:00.000Z",
					message: {
						id: "msg_new",
						model: "claude-opus-5-5",
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				})}\n`,
			),
		);
		await service.refresh();
		const keys = [...service.index.records()].map((one) => one.key);
		expect(keys).toContain("msg_new");
		expect(keys).not.toContain("msg_1");
	});

	it("lets go of what is older than the retention", () => {
		const index = new TokenIndex();
		const { events, state } = claudeUsage(
			fixture("claude-session.jsonl").toString("utf8"),
			{},
		);
		index.ingest(
			{ machine: "local", cli: "claude", path: MAIN, session: SESSION },
			{ start: 0, consumed: 1, size: 1, mtimeMs: NOW, state, events },
			NOW,
		);
		// msg_3 is from the day before: gone a retention after it, the rest not.
		index.prune(
			Date.parse("2026-11-12T20:00:00.000Z") + TOKEN_RETENTION_MS + 1,
		);
		expect([...index.records()].map((one) => one.key)).toEqual([
			"msg_1",
			"msg_2",
			"msg_side",
		]);
	});

	it("reads an SSH host's folders when a report is due, not at every reading", async () => {
		let now = NOW;
		const remote = machineWithFixtures();
		const service = serviceOn(new FakeMachine(), {
			remote,
			now: () => now,
		});
		await service.refresh();
		expect(remote.lists).toBe(1);
		now += 10_000;
		await service.refresh();
		expect(remote.lists).toBe(1);
		await service.refresh({ remote: "now" });
		expect(remote.lists).toBe(2);
		expect(
			[...service.index.records()].every(
				(one) => one.file.machine === "ssh:box",
			),
		).toBe(true);
	});
});

describe("the report", () => {
	async function reportBy(
		by: "agent" | "task" | "workspace" | "role" | "model",
		tasks: readonly TokenTask[] = [],
		range = resolveRange("days7", NOW, {}),
	): Promise<TokenReportWire> {
		const service = serviceOn(machineWithFixtures());
		service.observe([{ cli: "claude", session: SESSION, owner: OWNER }]);
		await service.refresh();
		return buildTokenReport({
			records: service.index.records(),
			ownerOf: (machine, cli, session) =>
				service.ownerOf(machine, cli, session),
			tasks,
			workspaces: context.workspaces,
			range,
			by,
			takenAt: NOW,
		});
	}

	it("adds every request once, raw and weighted", async () => {
		const report = await reportBy("agent");
		const { totals } = report;
		expect(totals.requests).toBe(4 + 2 + 2);
		expect(totals.input).toBe(10 + 4 + 1000 + 2000 + 3 + 5 + 4000 + 3000);
		expect(totals.cacheRead).toBe(3000 + 8000 + 1000 + 4000);
		expect(totals.cacheWrite5m).toBe(1000 + 500 + 8000 + 100);
		expect(totals.cacheWrite1h).toBe(2000);
		expect(totals.output).toBe(200 + 100 + 50 + 1000 + 40 + 60 + 300 + 200);
		expect(totals.processedInput).toBe(
			totals.input +
				totals.cacheRead +
				totals.cacheWrite5m +
				totals.cacheWrite1h,
		);
		expect(totals.cost).toBeCloseTo(
			0.02504 + 0.005116 + 0.00125 + 0.014 + 0.020406 + 0.00166,
			6,
		);
		// Codex's model has no pinned price: its tokens are said as unpriced.
		expect(totals.unpricedTokens).toBe(4000 + 1000 + 300 + 3000 + 4000 + 200);
		expect(totals.hitRate).toBeCloseTo(
			totals.cacheRead / totals.processedInput,
		);
	});

	it("gives an Agent its subagents' usage, broken out", async () => {
		const report = await reportBy("agent");
		const builder = row(report, "agent:agent-1");
		expect(builder.label).toBe("Builder");
		expect(builder.role).toBe("worker");
		expect(builder.totals.requests).toBe(6);
		expect(builder.models).toEqual([
			"claude-sonnet-5-5",
			"claude-opus-5-5",
			"claude-haiku-4-5",
		]);
		expect(
			builder.children.map((one) => [one.label, one.totals.requests]),
		).toEqual([
			["Survey the parser", 2],
			["Main conversation", 3],
			["Subagent inline1", 1],
		]);
		// A session no Agent of DevHub's ran is said by its folder.
		const codex = row(report, `outside:local:/work/api`);
		expect(codex.role).toBe("outside");
		expect(codex.children).toEqual([]);
	});

	it("counts toward a task what its Agents used while bound", async () => {
		const report = await reportBy("task", [
			{
				id: 7,
				title: "Parser",
				agents: [
					{
						agentId: "agent-1",
						sessions: [],
						// Bound at 09:01: msg_1 (09:00) and msg_3 (the day before) are not the task's.
						boundAt: Date.parse("2026-11-13T09:01:00.000Z"),
					},
				],
			},
			{
				id: 8,
				title: "Codex work",
				agents: [
					{
						agentId: "gone",
						sessions: [THREAD],
						boundAt: 0,
						stoppedAt: Date.parse("2026-11-13T08:00:30.000Z"),
					},
				],
			},
		]);
		expect(row(report, "task:7").totals.requests).toBe(4);
		// The binding's session, up to when it stopped.
		expect(row(report, "task:8").totals.requests).toBe(1);
		expect(row(report, "task:none").totals.requests).toBe(3);
		expect(row(report, "task:7").children.map((one) => one.label)).toEqual([
			"Builder",
		]);
	});

	it("groups by Workspace, a folder outside DevHub's Agents by the Workspace it is in", async () => {
		const report = await reportBy("workspace");
		expect(row(report, "workspace:ws-1").totals.requests).toBe(6);
		expect(row(report, "workspace:ws-2").totals.requests).toBe(2);
	});

	it("groups by role and by model", async () => {
		const roles = await reportBy("role");
		expect(roles.rows.map((one) => [one.id, one.totals.requests])).toEqual([
			["role:worker", 6],
			["role:outside", 2],
		]);
		const models = await reportBy("model");
		expect(row(models, "model:claude-opus-5-5").totals.cost).toBeCloseTo(
			0.02504 + 0.005116,
			6,
		);
		expect(row(models, "model:gpt-5.1-codex").totals.cost).toBe(0);
	});

	it("covers only the range, bucketed for the sparklines", async () => {
		const range = resolveRange("window5h", NOW, context.windows);
		// The window resets at 12:00: it began at 07:00.
		expect(range.from).toBe(Date.parse("2026-11-13T07:00:00.000Z"));
		const report = await reportBy("agent", [], range);
		// msg_3, the day before, is outside it.
		expect(report.totals.requests).toBe(7);
		const builder = row(report, "agent:agent-1");
		expect(builder.series.length).toBe(24);
		expect(builder.series.reduce((a, b) => a + b, 0)).toBe(
			builder.totals.total,
		);
	});
});

describe("the ranges", () => {
	it("starts the 5-hour window at its reset less five hours, or falls back", () => {
		expect(resolveRange("window5h", NOW, {}).from).toBe(NOW - 5 * 3_600_000);
		const passed = Date.parse("2026-11-13T09:00:00.000Z");
		expect(
			resolveRange("window5h", NOW, { fiveHourResetsAt: passed }).from,
		).toBe(passed);
		const week = Date.parse("2026-11-15T00:00:00.000Z");
		expect(resolveRange("week", NOW, { weekResetsAt: week }).from).toBe(
			week - 7 * 86_400_000,
		);
		expect(resolveRange("days7", NOW, {}).from).toBe(NOW - 7 * 86_400_000);
		const today = resolveRange("today", NOW, {});
		expect(new Date(today.from).getHours()).toBe(0);
		const custom = resolveRange("custom", NOW, {}, { from: 0, to: NOW - 1 });
		expect(custom.from).toBe(NOW - TOKEN_RETENTION_MS);
		expect(custom.to).toBe(NOW - 1);
	});
});
