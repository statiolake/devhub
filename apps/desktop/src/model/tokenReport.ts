/**
 * Who used how many tokens: the token index's requests, added up by Agent,
 * task, Workspace, role or model, over a time range.
 *
 * **Who a request is.** A request belongs to the transcript file that said it
 * first, a file to a CLI session (a subagent's file to the session that
 * started it), and a session to whoever ran it (`SessionOwner`): an Agent of
 * DevHub's, by what DevHub has known of it — the session an Agent runs now,
 * the sessions a task's binding recorded, the sessions DevHub wrote metadata
 * for. A session none of those name was run outside DevHub (or before it kept
 * track), and is said as its folder.
 *
 * **Tasks** count what their bound Agents used while bound: a request of a
 * session the binding recorded, or of the bound Agent, from its `boundAt` up
 * to its `stoppedAt`. One Agent bound to two tasks at once counts toward
 * both, so the task rows can add up to more than the total, which is said.
 *
 * **Two views.** Raw: what was processed — input, cache reads, cache writes
 * and output, each as it was counted. Cache-aware: each request weighted by
 * its model's list price (`tokenPrices.ts`) — the input as tokens at base
 * input price, and the estimated cost; and the cache hit rate, cache reads of
 * all input. A request on a model with no pinned price counts in the raw view
 * and is said as unpriced in the other.
 *
 * Pure: no clock, no I/O.
 */

import type {
  TokenGrouping,
  TokenRangeKind,
  TokenReportWire,
  TokenRole,
  TokenRowKind,
  TokenRowWire,
  TokenTotalsWire,
} from "../ipc/tokenUsage.js";
import type { IndexedRecord } from "./tokenIndex.js";
import { TOKEN_RETENTION_MS } from "./tokenIndex.js";
import {
  CACHE_WRITE_1H,
  CACHE_WRITE_5M,
  canonicalModel,
  costOf,
  modelLabel,
  PRICE_TABLE,
  PRICES_AS_OF,
  ratesFor,
  weightedInput,
} from "./tokenPrices.js";

/** Whoever ran a session, as DevHub knows them. */
export interface SessionOwner {
  readonly agentId?: string;
  readonly name: string;
  /** The profile's name. */
  readonly profile?: string;
  readonly machine: string;
  readonly workspaceId?: string;
  readonly workspaceLabel?: string;
  readonly role: Exclude<TokenRole, "outside">;
}

/** A task, with who was bound to it and when. */
export interface TokenTask {
  readonly id: number;
  readonly title: string;
  readonly done?: boolean;
  readonly agents: readonly {
    readonly agentId: string;
    readonly sessions: readonly string[];
    readonly boundAt: number;
    readonly stoppedAt?: number;
  }[];
}

/** An open Workspace, to place a session run outside DevHub by its folder. */
export interface TokenWorkspace {
  readonly id: string;
  readonly label: string;
  readonly machine: string;
  readonly root: string;
}

export interface TokenReportInput {
  readonly records: Iterable<IndexedRecord>;
  readonly ownerOf: (
    machine: string,
    cli: string,
    session: string,
  ) => SessionOwner | undefined;
  readonly tasks: readonly TokenTask[];
  readonly workspaces: readonly TokenWorkspace[];
  readonly range: ResolvedRange;
  readonly by: TokenGrouping;
  readonly takenAt: number;
  readonly buckets?: number;
  readonly sources?: TokenReportWire["sources"];
}

export interface ResolvedRange {
  readonly kind: TokenRangeKind;
  readonly from: number;
  readonly to: number;
  readonly label: string;
  readonly source: string;
  /** A plan window's: when it resets. */
  readonly resetsAt?: number;
}

// ---------------------------------------------------------------------------
// Ranges.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const RANGE_LABELS: Readonly<Record<TokenRangeKind, string>> = {
  window5h: "5-hour window",
  today: "Today",
  week: "Weekly window",
  days7: "Last 7 days",
  custom: "Custom",
};

/** Claude's plan windows, as the usage readout last had them. */
export interface PlanWindows {
  /** The 5-hour window's reset, ms since the epoch. */
  readonly fiveHourResetsAt?: number;
  /** The 7-day window's reset. */
  readonly weekResetsAt?: number;
}

/** The start of the local day `now` is in. */
export function startOfDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function planWindow(
  kind: "window5h" | "week",
  length: number,
  resetsAt: number | undefined,
  now: number,
): ResolvedRange {
  const label = RANGE_LABELS[kind];
  const span = kind === "window5h" ? "5 hours" : "7 days";
  if (resetsAt === undefined)
    return {
      kind,
      from: now - length,
      to: now,
      label,
      source: `The last ${span}: Claude's window has not been read`,
    };
  if (resetsAt > now)
    return {
      kind,
      from: Math.max(resetsAt - length, now - length),
      to: now,
      label,
      source: "Claude's window",
      resetsAt,
    };
  // The window it last read has ended; the next starts with the next use.
  return {
    kind,
    from: resetsAt,
    to: now,
    label,
    source: "Since Claude's window reset",
  };
}

/** The range a query names, now. */
export function resolveRange(
  kind: TokenRangeKind,
  now: number,
  windows: PlanWindows,
  custom?: { readonly from?: number; readonly to?: number },
): ResolvedRange {
  switch (kind) {
    case "window5h":
      return planWindow(kind, 5 * HOUR, windows.fiveHourResetsAt, now);
    case "week":
      return planWindow(kind, 7 * DAY, windows.weekResetsAt, now);
    case "today":
      return {
        kind,
        from: startOfDay(now),
        to: now,
        label: RANGE_LABELS.today,
        source: "Since local midnight",
      };
    case "days7":
      return {
        kind,
        from: now - 7 * DAY,
        to: now,
        label: RANGE_LABELS.days7,
        source: "The last 7 × 24 hours",
      };
    case "custom": {
      const to = Math.min(custom?.to ?? now, now);
      const earliest = now - TOKEN_RETENTION_MS;
      const from = Math.max(custom?.from ?? to - DAY, earliest);
      return {
        kind,
        from: Math.min(from, to),
        to,
        label: RANGE_LABELS.custom,
        source:
          (custom?.from ?? from) < earliest
            ? "As asked, from as far back as the index keeps (35 days)"
            : "As asked",
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Totals.

interface Tally {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  weightedInput: number;
  weightedOutput: number;
  cost: number;
  unpricedTokens: number;
}

const tally = (): Tally => ({
  requests: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  weightedInput: 0,
  weightedOutput: 0,
  cost: 0,
  unpricedTokens: 0,
});

/** What one request adds: its counts, and what they weigh. */
interface Weighed {
  readonly record: IndexedRecord;
  readonly total: number;
  readonly weightedInput: number;
  readonly weightedOutput: number;
  readonly cost: number;
  readonly priced: boolean;
}

function weigh(record: IndexedRecord): Weighed {
  const { counts } = record;
  const total =
    counts.input +
    counts.output +
    counts.cacheRead +
    counts.cacheWrite5m +
    counts.cacheWrite1h;
  const at = ratesFor(record.model, counts, record.fast === true);
  if (at === undefined)
    return {
      record,
      total,
      weightedInput: 0,
      weightedOutput: 0,
      cost: 0,
      priced: false,
    };
  return {
    record,
    total,
    weightedInput: weightedInput(counts, at),
    weightedOutput: (counts.output * at.output) / at.input,
    cost: costOf(counts, at),
    priced: true,
  };
}

function add(into: Tally, one: Weighed): void {
  const { counts } = one.record;
  into.requests += 1;
  into.input += counts.input;
  into.output += counts.output;
  into.cacheRead += counts.cacheRead;
  into.cacheWrite5m += counts.cacheWrite5m;
  into.cacheWrite1h += counts.cacheWrite1h;
  into.weightedInput += one.weightedInput;
  into.weightedOutput += one.weightedOutput;
  into.cost += one.cost;
  if (!one.priced) into.unpricedTokens += one.total;
}

export function totalsOf(t: Tally): TokenTotalsWire {
  const processedInput =
    t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  return {
    requests: t.requests,
    input: t.input,
    output: t.output,
    cacheRead: t.cacheRead,
    cacheWrite5m: t.cacheWrite5m,
    cacheWrite1h: t.cacheWrite1h,
    processedInput,
    total: processedInput + t.output,
    weightedInput: t.weightedInput,
    weightedOutput: t.weightedOutput,
    cost: t.cost,
    unpricedTokens: t.unpricedTokens,
    hitRate: processedInput > 0 ? t.cacheRead / processedInput : null,
  };
}

// ---------------------------------------------------------------------------
// Rows.

interface Group {
  readonly id: string;
  readonly kind: TokenRowKind;
  label: string;
  detail?: string;
  role?: TokenRole;
  agentId?: string;
  workspaceId?: string;
  taskId?: number;
  readonly tally: Tally;
  readonly models: Map<string, number>;
  readonly machines: Set<string>;
  readonly series: number[];
  readonly costSeries: number[];
  readonly children: Map<string, Group>;
}

/** What a group is, before any request is in it. */
interface GroupHead {
  readonly id: string;
  readonly kind: TokenRowKind;
  readonly label: string;
  readonly detail?: string;
  readonly role?: TokenRole;
  readonly agentId?: string;
  readonly workspaceId?: string;
  readonly taskId?: number;
}

const ROLE_LABEL: Readonly<Record<TokenRole, string>> = {
  orchestrator: "Orchestrator",
  worker: "Workers (managed)",
  unmanaged: "Unmanaged Agents",
  outside: "Outside DevHub",
};

const basename = (path: string): string =>
  path.replace(/\/+$/u, "").split("/").pop() || path;

/** The open Workspace a folder is in, the deepest one, on its machine. */
function workspaceAt(
  workspaces: readonly TokenWorkspace[],
  machine: string,
  cwd: string | undefined,
): TokenWorkspace | undefined {
  if (cwd === undefined) return undefined;
  let best: TokenWorkspace | undefined;
  for (const one of workspaces) {
    if (one.machine !== machine) continue;
    const root = one.root.replace(/\/+$/u, "");
    if (cwd !== root && !cwd.startsWith(`${root}/`)) continue;
    if (best === undefined || root.length > best.root.length) best = one;
  }
  return best;
}

const onMachine = (machine: string): string =>
  machine === "local" ? "" : ` on ${machine.replace(/^ssh:/u, "")}`;

export function buildTokenReport(input: TokenReportInput): TokenReportWire {
  const { range, by } = input;
  const buckets = Math.max(1, input.buckets ?? 24);
  const span = Math.max(1, range.to - range.from);
  const bucketMs = span / buckets;
  const groups = new Map<string, Group>();
  const all = tally();
  let overlapping = false;

  const group = (into: Map<string, Group>, head: GroupHead): Group => {
    const known = into.get(head.id);
    if (known) return known;
    const made: Group = {
      ...head,
      tally: tally(),
      models: new Map(),
      machines: new Set(),
      series: Array.from({ length: buckets }, () => 0),
      costSeries: Array.from({ length: buckets }, () => 0),
      children: new Map(),
    };
    into.set(head.id, made);
    return made;
  };

  const put = (target: Group, one: Weighed, machine: string) => {
    add(target.tally, one);
    const model = canonicalModel(one.record.model);
    target.models.set(model, (target.models.get(model) ?? 0) + one.total);
    target.machines.add(machine);
    const bucket = Math.min(
      buckets - 1,
      Math.max(0, Math.floor((one.record.at - range.from) / bucketMs)),
    );
    target.series[bucket] = (target.series[bucket] ?? 0) + one.total;
    target.costSeries[bucket] = (target.costSeries[bucket] ?? 0) + one.cost;
  };

  for (const record of input.records) {
    if (record.at < range.from || record.at > range.to) continue;
    const { file } = record;
    const one = weigh(record);
    add(all, one);
    const owner = input.ownerOf(file.machine, file.cli, file.session);
    const cwd = file.state.cwd;
    const placed =
      owner?.workspaceId === undefined
        ? workspaceAt(input.workspaces, file.machine, cwd)
        : undefined;
    const agentHead: GroupHead =
      owner === undefined
        ? {
            id: `outside:${file.machine}:${cwd ?? file.session}`,
            kind: "agent",
            label: `${cwd === undefined ? `Session ${file.session.slice(0, 8)}` : basename(cwd)}`,
            detail: `Outside DevHub · ${file.cli}${onMachine(file.machine)}${cwd === undefined ? "" : ` · ${cwd}`}`,
            role: "outside",
          }
        : {
            id:
              owner.agentId === undefined
                ? `named:${file.machine}:${owner.name}`
                : `agent:${owner.agentId}`,
            kind: "agent",
            label: owner.name,
            detail: [
              owner.profile,
              owner.workspaceLabel,
              owner.machine === "local"
                ? undefined
                : owner.machine.replace(/^ssh:/u, ""),
            ]
              .filter((part) => part !== undefined && part !== "")
              .join(" · "),
            role: owner.role,
            ...(owner.agentId === undefined ? {} : { agentId: owner.agentId }),
            ...(owner.workspaceId === undefined
              ? {}
              : { workspaceId: owner.workspaceId }),
          };
    const heads: GroupHead[] = (() => {
      switch (by) {
        case "agent":
          return [agentHead];
        case "role": {
          const role = owner?.role ?? "outside";
          return [
            { id: `role:${role}`, kind: "role", label: ROLE_LABEL[role], role },
          ];
        }
        case "model": {
          const model = canonicalModel(record.model);
          return [
            {
              id: `model:${model}`,
              kind: "model",
              label: modelLabel(record.model),
              detail: model,
            },
          ];
        }
        case "workspace": {
          if (owner?.workspaceId !== undefined)
            return [
              {
                id: `workspace:${owner.workspaceId}`,
                kind: "workspace",
                label: owner.workspaceLabel ?? owner.workspaceId,
                workspaceId: owner.workspaceId,
              },
            ];
          if (placed !== undefined)
            return [
              {
                id: `workspace:${placed.id}`,
                kind: "workspace",
                label: placed.label,
                workspaceId: placed.id,
              },
            ];
          return [
            {
              id: `folder:${file.machine}:${cwd ?? "?"}`,
              kind: "workspace",
              label: cwd === undefined ? "Unknown folder" : basename(cwd),
              detail: `Not open in DevHub${onMachine(file.machine)}${cwd === undefined ? "" : ` · ${cwd}`}`,
            },
          ];
        }
        case "task": {
          const matched = input.tasks.filter((task) =>
            task.agents.some(
              (entry) =>
                (entry.sessions.includes(file.session) ||
                  (owner?.agentId !== undefined &&
                    entry.agentId === owner.agentId)) &&
                record.at >= entry.boundAt &&
                (entry.stoppedAt === undefined || record.at <= entry.stoppedAt),
            ),
          );
          if (matched.length > 1) overlapping = true;
          if (matched.length === 0)
            return [{ id: "task:none", kind: "none", label: "No task" }];
          return matched.map((task) => ({
            id: `task:${String(task.id)}`,
            kind: "task" as const,
            label: `#${String(task.id)} ${task.title}`,
            ...(task.done === true ? { detail: "done" } : {}),
            taskId: task.id,
          }));
        }
      }
    })();
    for (const head of heads) {
      const row = group(groups, head);
      put(row, one, file.machine);
      // Agents break their usage out by conversation; every other row
      // by the Agents in it.
      const subagent = record.subagent;
      const child: GroupHead =
        by === "agent"
          ? subagent === undefined
            ? {
                id: `${head.id}/main`,
                kind: "main",
                label: "Main conversation",
              }
            : {
                id: `${head.id}/sub:${subagent}`,
                kind: "subagent",
                label:
                  (file.subagent === subagent
                    ? file.subagentLabel
                    : undefined) ?? `Subagent ${subagent.slice(0, 8)}`,
                detail: "subagent",
              }
          : { ...agentHead, id: `${head.id}/${agentHead.id}` };
      put(group(row.children, child), one, file.machine);
    }
  }

  const rowOf = (one: Group): TokenRowWire => ({
    id: one.id,
    kind: one.kind,
    label: one.label,
    ...(one.detail === undefined || one.detail === ""
      ? {}
      : { detail: one.detail }),
    models: [...one.models.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([model]) => model),
    machines: [...one.machines].sort(),
    ...(one.role === undefined ? {} : { role: one.role }),
    ...(one.agentId === undefined ? {} : { agentId: one.agentId }),
    ...(one.workspaceId === undefined ? {} : { workspaceId: one.workspaceId }),
    ...(one.taskId === undefined ? {} : { taskId: one.taskId }),
    totals: totalsOf(one.tally),
    series: one.series,
    costSeries: one.costSeries,
    children:
      // One child that is all of the row says nothing the row does not.
      one.children.size === 1 && by === "agent"
        ? []
        : sortRows([...one.children.values()].map(rowOf)),
  });

  return {
    takenAt: input.takenAt,
    range: {
      kind: range.kind,
      from: range.from,
      to: range.to,
      label: range.label,
      source: range.source,
      ...(range.resetsAt === undefined ? {} : { resetsAt: range.resetsAt }),
    },
    by,
    bucketMs,
    totals: totalsOf(all),
    rows: sortRows([...groups.values()].map(rowOf)),
    ...(overlapping ? { overlapping: true as const } : {}),
    prices: {
      asOf: PRICES_AS_OF,
      rows: PRICE_TABLE.map((row) => ({
        model: row.model,
        label: row.label,
        input: row.input,
        output: row.output,
        cacheRead: row.cacheRead,
        cacheWrite5m: row.input * CACHE_WRITE_5M,
        cacheWrite1h: row.input * CACHE_WRITE_1H,
      })),
    },
    sources: input.sources ?? [],
    retentionMs: TOKEN_RETENTION_MS,
  };
}

/** Most tokens first; a tie by label. */
export function sortRows(rows: readonly TokenRowWire[]): TokenRowWire[] {
  return [...rows].sort(
    (a, b) => b.totals.total - a.totals.total || a.label.localeCompare(b.label),
  );
}
