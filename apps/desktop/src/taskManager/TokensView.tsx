/**
 * The Task Manager's Tokens tab: who used how many tokens.
 *
 * Main adds the transcripts up (`model/tokenReport.ts`); this draws one
 * report, asked for again every `TOKENS_REFRESH_MS` while the tab is shown and
 * the window visible — each ask reads only what the transcripts gained since
 * the last (`main/tokenUsage/`).
 *
 * Three choices, each a radio group the arrow keys move along: the range
 * (Claude's 5-hour window first, since that is what limits the person), what
 * the rows are (Agents, tasks, Workspaces, roles, models), and the view —
 * without cache (raw counts) or cache-aware (weighted by list price, with the
 * hit rate and the estimated cost). The view switches without asking main:
 * a report carries both.
 *
 * Above the table, the totals: a few figures and one bar of where the input
 * went (uncached, cache read, cache write 5 min and 1 h). Each row has a
 * sparkline of its tokens (or cost) over the range. The table walks as the
 * process tree does: ↑ ↓ move, → opens an Agent's subagents (a task's or a
 * Workspace's Agents), ← closes, and every column heading sorts.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  formatCost,
  formatRate,
  formatTokens,
  type TokenGrouping,
  type TokenQueryWire,
  type TokenRangeKind,
  type TokenReportWire,
  type TokenRowWire,
  type TokenView,
} from "../ipc/tokenUsage";
import type { TaskManagerApi } from "../ipc/taskManager";
import { modelLabel } from "../model/tokenPrices";
import {
  DEFAULT_SORT,
  TOKEN_COLUMNS,
  visibleTokenRows,
  type TokenColumnKey,
  type TokenSort,
  type VisibleTokenRow,
} from "./tokenRows";

/** How often the shown tab asks again. */
export const TOKENS_REFRESH_MS = 5_000;

const RANGES: readonly { key: TokenRangeKind; label: string }[] = [
  { key: "window5h", label: "5-hour window" },
  { key: "today", label: "Today" },
  { key: "week", label: "Weekly window" },
  { key: "days7", label: "7 days" },
  { key: "custom", label: "Custom" },
];

const GROUPINGS: readonly { key: TokenGrouping; label: string }[] = [
  { key: "agent", label: "Agent" },
  { key: "task", label: "Task" },
  { key: "workspace", label: "Workspace" },
  { key: "role", label: "Role" },
  { key: "model", label: "Model" },
];

const VIEWS: readonly { key: TokenView; label: string; title: string }[] = [
  {
    key: "raw",
    label: "Without cache",
    title: "Every token as processed: input, cache read, cache write, output",
  },
  {
    key: "weighted",
    label: "Cache-aware",
    title:
      "Weighted by list price: cache reads cheap, cache writes dear; with the hit rate and the estimated cost",
  },
];

const ROLE_LABEL = {
  orchestrator: "Orchestrator",
  worker: "Worker",
  unmanaged: "Unmanaged",
  outside: "Outside DevHub",
} as const;

/**
 * A row of buttons of which one is chosen: Tab reaches the chosen one, the
 * arrow keys move the choice, as a native radio group does.
 */
function Segmented<K extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { key: K; label: string; title?: string }[];
  value: K;
  onChange: (key: K) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const at = options.findIndex((one) => one.key === value);
    const next = (at + step + options.length) % options.length;
    onChange(options[next]!.key);
    refs.current[next]?.focus();
  };
  return (
    <div
      className="tm-segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map((one, index) => (
        <button
          key={one.key}
          ref={(element) => {
            refs.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={value === one.key}
          tabIndex={value === one.key ? 0 : -1}
          title={one.title}
          onClick={() => {
            onChange(one.key);
          }}
        >
          {one.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Reports while the tab is shown and the window visible: one now (and at
 * every change of the query), the next `TOKENS_REFRESH_MS` after the last
 * answered.
 */
function useTokenReports(
  api: TaskManagerApi,
  query: TokenQueryWire,
  onError: (error: unknown) => void,
): { report: TokenReportWire | undefined; loading: boolean } {
  const [report, setReport] = useState<TokenReportWire>();
  const [loading, setLoading] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const generation = useRef(0);
  const key = JSON.stringify(query);
  useEffect(() => {
    const mine = ++generation.current;
    let inFlight = false;
    const take = () => {
      clearTimeout(timer.current);
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      void api
        .tokens(JSON.parse(key) as TokenQueryWire)
        .then(
          (next) => {
            if (generation.current === mine) {
              setReport(next);
              setLoading(false);
            }
          },
          (error: unknown) => {
            if (generation.current === mine) {
              setLoading(false);
              onError(error);
            }
          },
        )
        .finally(() => {
          inFlight = false;
          if (
            generation.current === mine &&
            document.visibilityState === "visible"
          )
            timer.current = setTimeout(take, TOKENS_REFRESH_MS);
        });
    };
    setLoading(true);
    take();
    const visibility = () => {
      if (document.visibilityState === "visible") take();
      else clearTimeout(timer.current);
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      generation.current += 1;
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [api, key, onError]);
  return { report, loading };
}

/** `09:41`, or `Nov 12 09:41` when not today. */
function when(ms: number, now: number): string {
  const at = new Date(ms);
  const time = at.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return new Date(now).toDateString() === at.toDateString()
    ? time
    : `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

/** A value for `<input type="datetime-local">`, in local time. */
function localInput(ms: number): string {
  const at = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return at.toISOString().slice(0, 16);
}

/** The parts of the input, in the order the bar lays them. */
const INPUT_PARTS = [
  { key: "input", label: "Uncached" },
  { key: "cacheRead", label: "Cache read" },
  { key: "cacheWrite5m", label: "Cache write 5m" },
  { key: "cacheWrite1h", label: "Cache write 1h" },
] as const;

function Figure({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="tk-figure" title={title}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Summary({
  report,
  view,
}: {
  report: TokenReportWire;
  view: TokenView;
}) {
  const { totals, range } = report;
  const input = totals.processedInput;
  const share = (n: number) =>
    input > 0 ? `${((n / input) * 100).toFixed(2)}%` : "0%";
  return (
    <section className="tm-header tk-summary" aria-label="Token totals">
      <div className="tm-header-top">
        <div className="tm-meter-caption">
          <span className="tm-key">{range.label}</span>
          <span className="tm-figure">
            {when(range.from, report.takenAt)} –{" "}
            {when(range.to, report.takenAt)}
          </span>
        </div>
        <span className="tm-of tk-source">
          {range.source}
          {range.resetsAt === undefined
            ? ""
            : ` · resets ${when(range.resetsAt, report.takenAt)}`}
        </span>
      </div>
      <dl className="tk-figures">
        {view === "raw" ? (
          <>
            <Figure
              label="Total tokens"
              value={formatTokens(totals.total)}
              title="All input processed, cache included, and output"
            />
            <Figure
              label="Input processed"
              value={formatTokens(totals.processedInput)}
            />
            <Figure label="Output" value={formatTokens(totals.output)} />
            <Figure
              label="Requests"
              value={totals.requests.toLocaleString("en-US")}
            />
          </>
        ) : (
          <>
            <Figure
              label="Est. cost"
              value={formatCost(totals.cost)}
              title="Estimated at Anthropic's API list price; a Claude plan is not billed this"
            />
            <Figure
              label="Weighted input"
              value={formatTokens(totals.weightedInput)}
              title="Input as tokens at base input price"
            />
            <Figure label="Output" value={formatTokens(totals.output)} />
            <Figure
              label="Cache hit rate"
              value={formatRate(totals.hitRate)}
              title="Cache reads of all input"
            />
          </>
        )}
      </dl>
      <div
        className="tm-meter tk-input"
        role="img"
        aria-label={`Input: ${INPUT_PARTS.map((part) => `${part.label} ${formatTokens(totals[part.key])}`).join(", ")}`}
      >
        {INPUT_PARTS.map((part) =>
          totals[part.key] > 0 ? (
            <span
              key={part.key}
              data-part={part.key}
              title={`${part.label}: ${formatTokens(totals[part.key])} (${share(totals[part.key])})`}
              style={{ width: share(totals[part.key]) }}
            />
          ) : null,
        )}
      </div>
      <ul className="tm-legend" aria-label="Where the input went">
        {INPUT_PARTS.map((part) => (
          <li key={part.key}>
            <span
              className="tm-swatch"
              data-part={part.key}
              aria-hidden="true"
            />
            <span className="tm-key">{part.label}</span>
            <span className="tm-figure">{formatTokens(totals[part.key])}</span>
          </li>
        ))}
      </ul>
      {view === "weighted" ? (
        <p className="tk-note">
          Cost is an estimate at Anthropic&apos;s API list price (prices of{" "}
          {report.prices.asOf}); a Claude plan is not billed this — its 5-hour
          and weekly windows are what limit it.
          {totals.unpricedTokens > 0
            ? ` ${formatTokens(totals.unpricedTokens)} tokens on models with no pinned price (Codex’s) are not in it.`
            : ""}
        </p>
      ) : null}
      {report.overlapping ? (
        <p className="tk-note">
          An Agent bound to two tasks at once counts toward both: the rows add
          up to more than the total.
        </p>
      ) : null}
    </section>
  );
}

/** The row's own trend over the range; its last bucket in the accent. */
function Sparkline({
  series,
  label,
}: {
  series: readonly number[];
  label: string;
}) {
  const width = 64;
  const height = 16;
  const max = Math.max(...series, 0);
  if (max <= 0 || series.length < 2)
    return <span className="tk-spark" aria-hidden="true" />;
  const x = (index: number) => (index / (series.length - 1)) * (width - 4) + 2;
  const y = (value: number) => height - 2 - (value / max) * (height - 4);
  const points = series
    .map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`)
    .join(" ");
  const last = series.length - 1;
  return (
    <svg
      className="tk-spark"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      width={width}
      height={height}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <polyline points={points} />
      <circle cx={x(last)} cy={y(series[last] ?? 0)} r={2} />
    </svg>
  );
}

function sparkLabel(
  row: TokenRowWire,
  view: TokenView,
  report: TokenReportWire,
): string {
  const series = view === "raw" ? row.series : row.costSeries;
  let peak = 0;
  series.forEach((value, index) => {
    if (value > (series[peak] ?? 0)) peak = index;
  });
  const at = report.range.from + peak * report.bucketMs;
  const value = series[peak] ?? 0;
  return `Peak ${view === "raw" ? formatTokens(value) : formatCost(value)} around ${when(at, report.takenAt)}`;
}

function detailOf(row: TokenRowWire): string | undefined {
  const parts = [
    row.detail,
    row.kind === "agent" && row.role !== undefined && row.role !== "outside"
      ? ROLE_LABEL[row.role]
      : undefined,
    row.kind === "agent" || row.kind === "task" || row.kind === "workspace"
      ? row.models.slice(0, 3).map(modelLabel).join(", ")
      : undefined,
  ].filter((part) => part !== undefined && part !== "");
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function Row({
  visible,
  view,
  report,
  selected,
  onSelect,
  onToggle,
}: {
  visible: VisibleTokenRow;
  view: TokenView;
  report: TokenReportWire;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const { row, depth, open } = visible;
  const expandable = row.children.length > 0;
  const detail = detailOf(row);
  return (
    <div
      role="row"
      id={`tk-row-${row.id}`}
      className="tm-row tk-row"
      data-kind={row.kind}
      data-depth={depth}
      aria-level={depth + 1}
      aria-expanded={expandable ? open : undefined}
      aria-selected={selected}
      onClick={() => {
        onSelect(row.id);
      }}
      onDoubleClick={() => {
        if (expandable) onToggle(row.id);
      }}
    >
      <div role="gridcell" className="tm-name" title={detail}>
        {depth > 0 ? <span className="tm-guide" aria-hidden="true" /> : null}
        <button
          type="button"
          tabIndex={-1}
          className="tm-disclosure"
          aria-hidden="true"
          data-open={open ? "true" : undefined}
          disabled={!expandable}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(row.id);
          }}
        >
          <svg viewBox="0 0 10 10" width="10" height="10">
            <path d="M3.5 2 L7 5 L3.5 8" />
          </svg>
        </button>
        <span className="tm-label">{row.label}</span>
        {detail === undefined ? null : (
          <span className="tm-detail">{detail}</span>
        )}
      </div>
      <div role="gridcell" className="tk-trend">
        <Sparkline
          series={view === "raw" ? row.series : row.costSeries}
          label={sparkLabel(row, view, report)}
        />
      </div>
      {TOKEN_COLUMNS[view].map((column) => (
        <div
          key={column.key}
          role="gridcell"
          className="tm-num"
          data-column={column.key}
        >
          {column.text(row.totals)}
        </div>
      ))}
    </div>
  );
}

function Sources({ report }: { report: TokenReportWire }) {
  const said = report.sources.filter(
    (one) => one.problem !== undefined || one.catchingUp === true,
  );
  if (said.length === 0) return null;
  return (
    <ul className="tk-sources" aria-label="Transcripts">
      {said.map((one) => (
        <li key={`${one.machine}/${one.cli}/${one.root}`}>
          {one.problem === undefined
            ? `Reading older ${one.cli === "claude" ? "Claude" : "Codex"} transcripts${one.machine === "local" ? "" : ` on ${one.machine.replace(/^ssh:/u, "")}`}: the figures will grow.`
            : `${one.cli === "claude" ? "Claude" : "Codex"} on ${one.machine.replace(/^ssh:/u, "")} could not be read: ${one.problem}`}
        </li>
      ))}
    </ul>
  );
}

export function TokensView({
  client,
  onError,
  onClose,
  toolbar,
}: {
  client: TaskManagerApi;
  onError: (error: unknown) => void;
  onClose: () => void;
  /** Where the view's own tools go: the window's toolbar. */
  toolbar: (tools: ReactNode) => ReactNode;
}) {
  const [range, setRange] = useState<TokenRangeKind>("window5h");
  const [custom, setCustom] = useState(() => {
    const now = Date.now();
    return { from: now - 24 * 3_600_000, to: now };
  });
  const [by, setBy] = useState<TokenGrouping>("agent");
  const [view, setView] = useState<TokenView>("raw");
  const [sort, setSort] = useState<TokenSort>({
    key: DEFAULT_SORT.raw,
    ascending: false,
  });
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string>();
  const [copied, setCopied] = useState(false);
  const query: TokenQueryWire = useMemo(
    () =>
      range === "custom"
        ? { range, by, from: custom.from, to: custom.to }
        : { range, by },
    [range, by, custom],
  );
  const { report, loading } = useTokenReports(client, query, onError);

  const chooseView = useCallback((next: TokenView) => {
    setView(next);
    setSort({ key: DEFAULT_SORT[next], ascending: false });
  }, []);
  const rows = useMemo(
    () => (report ? visibleTokenRows(report.rows, view, sort, opened) : []),
    [report, view, sort, opened],
  );
  const toggle = useCallback((id: string) => {
    setOpened((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const sortBy = (key: TokenColumnKey) => {
    setSort((current) =>
      current.key === key
        ? { key, ascending: !current.ascending }
        : { key, ascending: false },
    );
  };

  const copy = () => {
    void client.copyTokens(query, view).then(
      () => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 1_500);
      },
      (error: unknown) => {
        onError(error);
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    const index = rows.findIndex((one) => one.row.id === selected);
    const at = rows[index];
    const go = (next: VisibleTokenRow | undefined) => {
      if (!next) return;
      event.preventDefault();
      setSelected(next.row.id);
      document
        .getElementById(`tk-row-${next.row.id}`)
        ?.scrollIntoView({ block: "nearest" });
    };
    switch (event.key) {
      case "ArrowDown":
        go(rows[index + 1] ?? rows[0]);
        return;
      case "ArrowUp":
        go(index <= 0 ? rows[0] : rows[index - 1]);
        return;
      case "Home":
        go(rows[0]);
        return;
      case "End":
        go(rows[rows.length - 1]);
        return;
      case "Enter":
      case " ":
        if (at && at.row.children.length > 0) {
          event.preventDefault();
          toggle(at.row.id);
        }
        return;
      case "ArrowRight":
        if (at && at.row.children.length > 0 && !at.open) {
          event.preventDefault();
          toggle(at.row.id);
        } else go(at?.open ? rows[index + 1] : undefined);
        return;
      case "ArrowLeft":
        if (at?.open) {
          event.preventDefault();
          toggle(at.row.id);
        } else go(rows.find((one) => one.row.id === at?.parentId));
        return;
    }
  };

  const columns = TOKEN_COLUMNS[view];
  return (
    <>
      {toolbar(
        <>
          <Segmented
            label="View"
            options={VIEWS}
            value={view}
            onChange={chooseView}
          />
          <button
            type="button"
            className="mac-button tm-copy"
            disabled={report === undefined}
            onClick={copy}
          >
            {copied ? "Copied" : "Copy Table"}
          </button>
        </>,
      )}
      <div className="tk-controls">
        <Segmented
          label="Range"
          options={RANGES}
          value={range}
          onChange={setRange}
        />
        <Segmented
          label="Group by"
          options={GROUPINGS}
          value={by}
          onChange={setBy}
        />
        {range === "custom" ? (
          <div className="tk-custom">
            <label>
              <span className="tm-key">From</span>
              <input
                type="datetime-local"
                value={localInput(custom.from)}
                onChange={(event) => {
                  const at = Date.parse(event.target.value);
                  if (Number.isFinite(at))
                    setCustom((current) => ({ ...current, from: at }));
                }}
              />
            </label>
            <label>
              <span className="tm-key">To</span>
              <input
                type="datetime-local"
                value={localInput(custom.to)}
                onChange={(event) => {
                  const at = Date.parse(event.target.value);
                  if (Number.isFinite(at))
                    setCustom((current) => ({ ...current, to: at }));
                }}
              />
            </label>
          </div>
        ) : null}
      </div>
      {report === undefined ? (
        <div className="tm-loading mac-caption">
          {loading ? "Reading transcripts…" : "No report."}
        </div>
      ) : (
        <>
          <Summary report={report} view={view} />
          <Sources report={report} />
          <div
            className="tm-table tk-table"
            data-view={view}
            role="treegrid"
            aria-label="Tokens"
            aria-activedescendant={
              selected === undefined ? undefined : `tk-row-${selected}`
            }
            tabIndex={0}
            onKeyDown={onKeyDown}
          >
            <div role="row" className="tm-row tm-columns tk-row">
              <div role="columnheader" className="tm-name">
                {GROUPINGS.find((one) => one.key === by)?.label}
              </div>
              <div role="columnheader" className="tk-trend">
                Trend
              </div>
              {columns.map((column) => (
                <div
                  key={column.key}
                  role="columnheader"
                  className="tm-num"
                  data-column={column.key}
                  aria-sort={
                    sort.key === column.key
                      ? sort.ascending
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button
                    type="button"
                    className="tk-sort"
                    title={column.title}
                    onClick={() => {
                      sortBy(column.key);
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    {column.label}
                  </button>
                </div>
              ))}
            </div>
            {rows.length === 0 ? (
              <div className="tm-loading mac-caption">
                No requests in this range.
              </div>
            ) : (
              rows.map((visible) => (
                <Row
                  key={visible.row.id}
                  visible={visible}
                  view={view}
                  report={report}
                  selected={visible.row.id === selected}
                  onSelect={setSelected}
                  onToggle={toggle}
                />
              ))
            )}
          </div>
        </>
      )}
    </>
  );
}
