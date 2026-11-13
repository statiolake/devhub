/**
 * The Task Manager: what each Workspace and Agent costs, now.
 *
 * One header and one table. The header is the machine — memory used of
 * total, broken down as Activity Monitor does (app, wired, compressed, cached
 * files, free), the pressure the kernel reports, swap — and DevHub's own
 * total. The table is DevHub's processes in the shape a person thinks in
 * (`diagnostics/taskTree.ts`): Workspaces with their terminal and Agents, then DevHub itself, tmux, and Other. Each row has two memory
 * figures: its footprint (what it costs wherever its pages are) and what of
 * that is in RAM. Every number is right-aligned in tabular figures, and a
 * short bar ahead of the footprint says the row's share of DevHub's total,
 * its in-RAM part solid and the rest (compressed, swapped) faint — so a
 * row whose pages went out keeps its length and loses its fill.
 *
 * It refreshes about every two seconds while the window is visible and not at
 * all otherwise, one request at a time (`useSnapshots`). The keyboard walks the
 * rows the way the Sidebar's tree is walked: ↑ ↓ move, → opens, ← closes or
 * goes to the parent, and Escape closes the window.
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
  formatBytes,
  type TaskManagerApi,
  type TaskRowWire,
  type TaskSnapshotWire,
} from "../ipc/taskManager";
import type { AppError } from "../ipc/appShell";
import { useRaiseFailure } from "../shell/model/pageModel";
import { devhub } from "./client";
import { visibleRows, type SortKey, type VisibleRow } from "./rows";
import { TokensView } from "./TokensView";
import "../shell/styles/tokens.css";
import "../shell/styles/windowBackground.css";
import "../shell/styles/macos.css";
import "./taskManager.css";

/** How often a visible window asks again. */
export const REFRESH_MS = 2_000;

/** A row this much of DevHub's total is drawn as one of the heavy ones. */
const HEAVY_SHARE = 0.15;

/**
 * Snapshots while the page is visible: one now, the next `REFRESH_MS` after
 * the last one answered, and none while the window is hidden, minimised or
 * covered (Chromium says `hidden` for each).
 */
function useSnapshots(
  api: TaskManagerApi,
  onError: (error: unknown) => void,
  enabled = true,
): { snapshot: TaskSnapshotWire | undefined; refresh: () => void } {
  const [snapshot, setSnapshot] = useState<TaskSnapshotWire>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const take = useCallback(() => {
    clearTimeout(timer.current);
    if (!enabled || inFlight.current || document.visibilityState !== "visible")
      return;
    inFlight.current = true;
    void api
      .snapshot()
      .then(
        (next) => {
          if (alive.current) setSnapshot(next);
        },
        (error: unknown) => {
          if (alive.current) onError(error);
        },
      )
      .finally(() => {
        inFlight.current = false;
        if (
          alive.current &&
          enabled &&
          document.visibilityState === "visible"
        ) {
          timer.current = setTimeout(take, REFRESH_MS);
        }
      });
  }, [api, onError, enabled]);
  useEffect(() => {
    alive.current = true;
    take();
    const visibility = () => {
      if (document.visibilityState === "visible") take();
      else clearTimeout(timer.current);
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [take]);
  return { snapshot, refresh: take };
}

const PRESSURE_LABEL = {
  normal: "Normal",
  warning: "Warning",
  critical: "Critical",
  unknown: "Unknown",
} as const;

function percent(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

/** The parts of the machine's memory, in the order the meter lays them. */
const PARTS = [
  { key: "appBytes", label: "App" },
  { key: "wiredBytes", label: "Wired" },
  { key: "compressedBytes", label: "Compressed" },
  { key: "cachedBytes", label: "Cached files" },
  { key: "freeBytes", label: "Free" },
] as const;

function Header({ snapshot }: { snapshot: TaskSnapshotWire }) {
  const { system, total } = snapshot;
  const { breakdown } = system;
  const share = (bytes: number) =>
    system.totalBytes > 0
      ? `${Math.min(100, (bytes / system.totalBytes) * 100).toFixed(2)}%`
      : "0%";
  return (
    <section className="tm-header" aria-label="System memory">
      <div className="tm-header-top">
        <div className="tm-meter-caption">
          <span className="tm-key">Memory</span>
          <span className="tm-figure">
            {formatBytes(system.usedBytes)}
            <span className="tm-of">
              {" "}
              used of {formatBytes(system.totalBytes)}
            </span>
          </span>
        </div>
        <dl className="tm-facts">
          <div title={system.pressureSource}>
            <dt>Pressure</dt>
            <dd className="tm-pressure" data-pressure={system.pressure}>
              <span className="tm-dot" aria-hidden="true" />
              {PRESSURE_LABEL[system.pressure]}
            </dd>
          </div>
          <div>
            <dt>Swap</dt>
            <dd>
              {system.swapTotalBytes === 0 ? (
                <span className="tm-of">none</span>
              ) : (
                <>
                  {formatBytes(system.swapUsedBytes)}
                  <span className="tm-of">
                    {" "}
                    of {formatBytes(system.swapTotalBytes)}
                  </span>
                </>
              )}
            </dd>
          </div>
        </dl>
      </div>
      <div
        className="tm-meter"
        data-pressure={system.pressure}
        role="meter"
        aria-label="Memory used"
        aria-valuemin={0}
        aria-valuemax={system.totalBytes}
        aria-valuenow={system.usedBytes}
      >
        {PARTS.slice(0, 4).map((part) => (
          <span
            key={part.key}
            data-part={part.key}
            style={{ width: share(breakdown[part.key]) }}
          />
        ))}
      </div>
      <ul className="tm-legend" aria-label="Where memory is">
        {PARTS.map((part) => (
          <li key={part.key}>
            <span
              className="tm-swatch"
              data-part={part.key}
              aria-hidden="true"
            />
            <span className="tm-key">{part.label}</span>
            <span className="tm-figure">
              {formatBytes(breakdown[part.key])}
            </span>
            {part.key === "compressedBytes" &&
            breakdown.compressorStoredBytes > 0 ? (
              <span className="tm-of">
                holds {formatBytes(breakdown.compressorStoredBytes)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="tm-devhub">
        <span className="tm-key">DevHub</span>
        <span className="tm-figure">{formatBytes(total.memoryBytes)}</span>
        <span className="tm-of">
          · {formatBytes(total.residentBytes)} in RAM ·{" "}
          {percent(total.cpuPercent)} CPU · {total.processCount} processes
        </span>
      </div>
    </section>
  );
}

const SORT_LABEL = {
  memory: "Footprint",
  resident: "In RAM",
  cpu: "CPU",
} as const;

const ACTION_LABEL = {
  stop: "Stop",
  reveal: "Show",
  kill: "End…",
} as const;

const ACTION_TITLE = {
  stop: "Stop this Agent",
  reveal: "Show it in the DevHub window",
  kill: "End this process",
} as const;

function Row({
  visible,
  total,
  selected,
  onSelect,
  onToggle,
  onAction,
}: {
  visible: VisibleRow;
  total: number;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onAction: (row: TaskRowWire, action: TaskRowWire["actions"][number]) => void;
}) {
  const { row, depth, open } = visible;
  const share = total > 0 ? row.memoryBytes / total : 0;
  const inRam =
    row.memoryBytes > 0 ? Math.min(1, row.residentBytes / row.memoryBytes) : 0;
  const expandable = row.children.length > 0;
  return (
    <div
      role="row"
      id={`tm-row-${row.id}`}
      className="tm-row"
      data-kind={row.kind}
      data-depth={depth}
      data-heavy={share >= HEAVY_SHARE ? "true" : undefined}
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
      <div role="gridcell" className="tm-name">
        {Array.from({ length: depth }, (_, level) => (
          <span key={level} className="tm-guide" aria-hidden="true" />
        ))}
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
        {row.pid === undefined ? null : (
          <span className="tm-pid">{row.pid}</span>
        )}
        {row.detail === undefined || row.kind === "process" ? null : (
          <span className="tm-detail">{row.detail}</span>
        )}
        <span className="tm-actions">
          {row.actions.map((action) => (
            <button
              key={action}
              type="button"
              className="tm-action"
              data-action={action}
              title={ACTION_TITLE[action]}
              onClick={(event) => {
                event.stopPropagation();
                onAction(row, action);
              }}
            >
              {ACTION_LABEL[action]}
            </button>
          ))}
        </span>
      </div>
      <div role="gridcell" className="tm-num tm-memory">
        <span className="tm-bar" aria-hidden="true">
          <span style={{ width: `${Math.min(100, share * 100).toFixed(1)}%` }}>
            <span style={{ width: `${(inRam * 100).toFixed(1)}%` }} />
          </span>
        </span>
        <span className="tm-figure">{formatBytes(row.memoryBytes)}</span>
      </div>
      <div role="gridcell" className="tm-num tm-resident">
        {formatBytes(row.residentBytes)}
      </div>
      <div
        role="gridcell"
        className="tm-num tm-cpu"
        data-busy={row.cpuPercent >= 25 ? "true" : undefined}
      >
        {percent(row.cpuPercent)}
      </div>
      <div role="gridcell" className="tm-num tm-count">
        {row.processCount}
      </div>
    </div>
  );
}

type Tab = "processes" | "tokens";

const TABS: readonly { key: Tab; label: string }[] = [
  { key: "processes", label: "Processes" },
  { key: "tokens", label: "Tokens" },
];

/**
 * The window's two tabs. ← → move between them as a tab list does, and
 * ⌘1 / ⌘2 choose one from anywhere in the window.
 */
function Tabs({
  value,
  onChange,
}: {
  value: Tab;
  onChange: (tab: Tab) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const index = ["1", "2"].indexOf(event.key);
      if (index < 0) return;
      event.preventDefault();
      onChange(TABS[index]!.key);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onChange]);
  return (
    <div
      className="tm-tabs"
      role="tablist"
      aria-label="Task Manager"
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const at = TABS.findIndex((one) => one.key === value);
        const next =
          (at + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) %
          TABS.length;
        onChange(TABS[next]!.key);
        refs.current[next]?.focus();
      }}
    >
      {TABS.map((one, index) => (
        <button
          key={one.key}
          ref={(element) => {
            refs.current[index] = element;
          }}
          type="button"
          role="tab"
          aria-selected={value === one.key}
          tabIndex={value === one.key ? 0 : -1}
          title={`${one.label} (⌘${String(index + 1)})`}
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

export function TaskManagerApp({ client }: { client: TaskManagerApi }) {
  const raise = useRaiseFailure(devhub());
  const [message, setMessage] = useState<string>();
  const [failure, setFailure] = useState<AppError>();
  useEffect(() => devhub().onNativeError(setFailure), []);
  const onSnapshotError = useCallback((error: unknown) => {
    setMessage(
      `Could not read the processes: ${error instanceof Error ? error.message : String(error)}`,
    );
  }, []);
  const [tab, setTab] = useState<Tab>("processes");
  const { snapshot, refresh } = useSnapshots(
    client,
    onSnapshotError,
    tab === "processes",
  );
  const onTokensError = useCallback((error: unknown) => {
    setMessage(
      `Could not read the transcripts: ${error instanceof Error ? error.message : String(error)}`,
    );
  }, []);
  const close = useCallback(() => {
    void client.close();
  }, [client]);
  const toolbar = (tools: ReactNode) => (
    <header className="tm-toolbar">
      <h1 className="tm-title">Task Manager</h1>
      <Tabs value={tab} onChange={setTab} />
      <div className="tm-tools">{tools}</div>
    </header>
  );
  const [sort, setSort] = useState<SortKey>("memory");
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string>();
  const [copied, setCopied] = useState(false);

  const rows = useMemo(
    () => (snapshot ? visibleRows(snapshot.rows, sort, toggled) : []),
    [snapshot, sort, toggled],
  );
  const toggle = useCallback((id: string) => {
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const act = useCallback(
    (row: TaskRowWire, action: TaskRowWire["actions"][number]) => {
      setMessage(undefined);
      const done = (() => {
        switch (action) {
          case "stop":
            return client.stopAgent(row.agentId ?? "");
          case "reveal":
            return client.reveal(
              row.agentId === undefined
                ? { kind: "workspace", workspaceId: row.workspaceId ?? "" }
                : { kind: "agent", agentId: row.agentId },
            );
          case "kill":
            return client.kill(row.pid ?? 0);
        }
      })();
      void Promise.resolve(done).then(
        () => {
          refresh();
        },
        (error: unknown) => {
          setMessage(error instanceof Error ? error.message : String(error));
        },
      );
    },
    [client, refresh],
  );

  const copy = useCallback(() => {
    void client.copy().then(
      () => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 1_500);
      },
      (error: unknown) => {
        raise(error);
      },
    );
  }, [client, raise]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void client.close();
        return;
      }
      const index = rows.findIndex((one) => one.row.id === selected);
      const at = rows[index];
      const go = (next: VisibleRow | undefined) => {
        if (!next) return;
        event.preventDefault();
        setSelected(next.row.id);
        document
          .getElementById(`tm-row-${next.row.id}`)
          ?.scrollIntoView({ block: "nearest" });
      };
      switch (event.key) {
        case "ArrowDown":
          go(rows[index + 1] ?? rows[0]);
          return;
        case "ArrowUp":
          go(index <= 0 ? rows[0] : rows[index - 1]);
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
    },
    [client, rows, selected, toggle],
  );

  return (
    <div className="tm-window">
      {tab === "tokens" ? (
        <TokensView
          client={client}
          onError={onTokensError}
          onClose={close}
          toolbar={toolbar}
        />
      ) : (
        <>
          {toolbar(
            <>
              <div
                className="tm-segmented"
                role="radiogroup"
                aria-label="Sort by"
              >
                {(["memory", "resident", "cpu"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={sort === key}
                    onClick={() => {
                      setSort(key);
                    }}
                  >
                    {SORT_LABEL[key]}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="mac-button tm-copy"
                disabled={snapshot === undefined}
                onClick={copy}
              >
                {copied ? "Copied" : "Copy Snapshot"}
              </button>
            </>,
          )}
          {snapshot === undefined ? (
            <div className="tm-loading mac-caption">Reading processes…</div>
          ) : (
            <>
              <Header snapshot={snapshot} />
              <div
                className="tm-table"
                role="treegrid"
                aria-label="Processes"
                aria-activedescendant={
                  selected === undefined ? undefined : `tm-row-${selected}`
                }
                tabIndex={0}
                onKeyDown={onKeyDown}
              >
                <div role="row" className="tm-row tm-columns">
                  <div role="columnheader" className="tm-name">
                    Name
                  </div>
                  <div
                    role="columnheader"
                    className="tm-num tm-memory"
                    aria-sort={sort === "memory" ? "descending" : "none"}
                    onClick={() => {
                      setSort("memory");
                    }}
                  >
                    Footprint
                  </div>
                  <div
                    role="columnheader"
                    className="tm-num tm-resident"
                    aria-sort={sort === "resident" ? "descending" : "none"}
                    onClick={() => {
                      setSort("resident");
                    }}
                  >
                    In RAM
                  </div>
                  <div
                    role="columnheader"
                    className="tm-num tm-cpu"
                    aria-sort={sort === "cpu" ? "descending" : "none"}
                    onClick={() => {
                      setSort("cpu");
                    }}
                  >
                    CPU
                  </div>
                  <div role="columnheader" className="tm-num tm-count">
                    Procs
                  </div>
                </div>
                {rows.map((visible) => (
                  <Row
                    key={visible.row.id}
                    visible={visible}
                    total={snapshot.total.memoryBytes}
                    selected={visible.row.id === selected}
                    onSelect={setSelected}
                    onToggle={toggle}
                    onAction={act}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
      {message === undefined && failure === undefined ? null : (
        <footer className="tm-message" role="status">
          <span>{message ?? failure?.summary}</span>
          <button
            type="button"
            className="mac-button plain"
            onClick={() => {
              setMessage(undefined);
              setFailure(undefined);
            }}
          >
            Dismiss
          </button>
        </footer>
      )}
    </div>
  );
}
