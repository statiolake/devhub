/**
 * Smart Buttons: what an idle Agent's pane offers to say next.
 *
 * Commit, push, open a pull request, get a draft ready, answer review
 * comments, fix CI — the moves that come up over and over while work is under
 * way, each a sentence the person would otherwise type. A button is only ever
 * *the same act the Agent actions sheet performs*: it fills in a template the
 * person owns and queues it for the Agent (`runAgentAction`). There is no git
 * run here and no GitHub call; what the Agent does with the sentence is its
 * own business, which is the whole reason this is a message and not a
 * command. What became of the message is the pane's corner's to say
 * (`InjectionStatus`), by its own rules — nothing here says "sent".
 *
 * **When.** Only while the Agent is idle, and only the actions whose
 * trigger's condition holds for the Workspace's repository right now — the
 * rule is `smartButtonTriggers` in `model/agentActions.ts`, read from the
 * repository status main already publishes. So a button disappears on its
 * own the moment its condition stops holding or the Agent starts working.
 * Every action under a trigger that holds is offered, unless its `button` is
 * off in Settings; the Agent actions sheet lists every action regardless.
 *
 * **Shape.** A compact stack, one button per line under a header that holds
 * the drag handle and the automatic actions' switch — never a row that grows
 * as wide as its wording. A terminal's lines are as wide as their words and
 * flush right in its corner; a conversation's are all one width, so the stack
 * reads as one block standing on the composer.
 *
 * **Where.** A GUI Agent's stand on its composer's top edge, touching it; a
 * terminal's in the pane's bottom right corner above the queued-message
 * status. The box can be dragged anywhere in the pane by its handle (or moved
 * with the arrow keys while the handle has focus). Within `SMART_BUTTONS_SNAP`
 * pixels of the composer's (status's, corner's) top or right edge it snaps to
 * it and stays anchored there as that grows and moves; anywhere else it is
 * free. Main remembers where per presentation (`model/smartButtons.ts`); a
 * double-click on the handle, or Home, puts it back. What is drawn is always
 * clamped to the pane as it is now, so a smaller window never hides it.
 *
 * **How it looks.** Translucent at rest — it sits over the work — and at full
 * strength while pointed at, holding focus, or being dragged
 * (`smartButtons.css`).
 *
 * **Automatic.** The bolt in the header opens a switch for every action that
 * may be automatic (`AUTOMATIC_TRIGGERS`), each with what makes it fire: switched
 * on, the action is sent on its own the moment its condition holds — main
 * decides when (`model/automaticActions.ts`) — for this Agent only, off until
 * switched on. A button whose action is switched on is edged in the accent
 * (the header's bolt stays the only switch); one whose condition does not hold
 * is still drawn, in its place, but not pressable (`aria-disabled`). The box is there whenever the
 * Agent has such an action, not only while a button is offered; with no
 * button offered and nothing switched on it shows only while the pane is
 * pointed at.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentWire } from "../../ipc/appShell";
import type {
  AgentActionTriggerWire,
  AgentActionWire,
  WorkspaceRepositoryWire,
} from "../../ipc/contract";
import { ACTION_TRIGGERS, smartButtonTriggers } from "../../model/agentActions";
import { isAutomaticTrigger } from "../../model/automaticActions";
import {
  anchorBox,
  clampOffset,
  defaultSpot,
  draggedOffset,
  isAnchoredSpot,
  sameSpot,
  snapSpot,
  spotOffset,
  SMART_BUTTONS_DRAG_THRESHOLD,
  SMART_BUTTONS_MARGIN,
  type Box,
  type Size,
  type SmartButtonsOffset,
  type SmartButtonsSpot,
} from "../../model/smartButtons";
import { useAgents } from "./AgentsContext";
import "./smartButtons.css";

/**
 * The actions to draw as buttons, in trigger order and then each trigger's
 * own order: every enabled action with `button` on whose trigger holds.
 */
export function smartButtonActions(
  agent: Pick<AgentWire, "status">,
  repository: WorkspaceRepositoryWire | undefined,
  actions: readonly AgentActionWire[],
): readonly AgentActionWire[] {
  return smartButtonTriggers(agent.status, repository).flatMap((trigger) =>
    actions.filter((action) => action.trigger === trigger && action.button),
  );
}

/** One line of the stack: an action, and whether pressing it is on offer. */
export interface SmartButtonLine {
  readonly action: AgentActionWire;
  /** Its condition holds now; false only for a ticked automatic action. */
  readonly active: boolean;
}

/**
 * The lines to draw: the offered actions, plus every action ticked as
 * automatic whose condition does not hold now (drawn but not pressable —
 * it fires on its own when the condition arises). One order throughout:
 * trigger order, then each trigger's own.
 */
export function smartButtonLines(
  agent: Pick<AgentWire, "status" | "automaticActions">,
  repository: WorkspaceRepositoryWire | undefined,
  actions: readonly AgentActionWire[],
): readonly SmartButtonLine[] {
  const holding = smartButtonTriggers(agent.status, repository);
  const ticked = agent.automaticActions ?? [];
  return ACTION_TRIGGERS.flatMap((trigger) =>
    actions
      .filter((action) => action.trigger === trigger && action.button)
      .flatMap((action): SmartButtonLine[] => {
        if (holding.includes(trigger)) return [{ action, active: true }];
        return isAutomaticTrigger(trigger) && ticked.includes(action.id)
          ? [{ action, active: false }]
          : [];
      }),
  );
}

/** How long an exiting line stays mounted: its exit animation, plus slack. */
export const SMART_BUTTONS_EXIT_MS = 220;

/** The person asked for less motion; without `matchMedia`, assume so. */
function reducedMotion(): boolean {
  try {
    return (
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return true;
  }
}

interface Presence {
  readonly line: SmartButtonLine;
  readonly exiting: boolean;
  /** Appeared while the panel was showing: plays its enter animation. */
  readonly entering: boolean;
}

/** How long the position transition stays on after a snap/dock/undock. */
export const SMART_BUTTONS_SETTLE_MS = 260;

/**
 * The lines to mount: the current ones, and for a moment each line that just
 * left, in the place it had, so its exit can play. With reduced motion a line
 * leaves at once.
 */
function usePresence(lines: readonly SmartButtonLine[]): readonly Presence[] {
  const previous = useRef<readonly SmartButtonLine[]>(lines);
  // Lines there from the first render: they were not "coming", so no enter.
  const initial = useRef<Set<string>>(
    new Set(lines.map((line) => line.action.id)),
  );
  const [leaving, setLeaving] = useState<
    readonly { readonly line: SmartButtonLine; readonly index: number }[]
  >([]);
  useLayoutEffect(() => {
    const now = new Set(lines.map((line) => line.action.id));
    const gone = previous.current
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => !now.has(line.action.id));
    previous.current = lines;
    for (const { line } of gone) initial.current.delete(line.action.id);
    if (gone.length === 0 || reducedMotion()) return;
    setLeaving((current) => [
      ...current.filter(
        (entry) => !gone.some((g) => g.line.action.id === entry.line.action.id),
      ),
      ...gone,
    ]);
    const ids = gone.map((g) => g.line.action.id);
    // Not cleared on the next run of this effect: `lines` is a new array
    // every render, and the render this very update causes would cancel it.
    setTimeout(() => {
      setLeaving((current) =>
        current.filter((entry) => !ids.includes(entry.line.action.id)),
      );
    }, SMART_BUTTONS_EXIT_MS);
  }, [lines]);
  const now = new Set(lines.map((line) => line.action.id));
  const merged: Presence[] = lines.map((line) => ({
    line,
    exiting: false,
    entering: !initial.current.has(line.action.id),
  }));
  for (const entry of [...leaving].sort((a, b) => a.index - b.index)) {
    if (now.has(entry.line.action.id)) continue;
    merged.splice(Math.min(entry.index, merged.length), 0, {
      line: entry.line,
      exiting: true,
      entering: false,
    });
  }
  return merged;
}

/** When an automatic action fires, in a line, by its trigger. */
const FIRES_WHEN: Partial<Record<AgentActionTriggerWire, string>> = {
  commit: "After a turn that leaves uncommitted changes",
  push: "When there are commits the branch has not pushed",
  unresolved_review_comments: "When new review comments arrive",
  ci_failing: "When CI starts failing",
};

/**
 * What the box is anchored to.
 *
 * A GUI Agent's box stands on its composer's box — which every conversation
 * draws, so one that is not there is a surface this component does not know.
 * A terminal's stands on the queued-message status in the corner when there
 * is one, and in the corner itself when there is not.
 */
function anchorOf(
  pane: HTMLElement,
  agent: AgentWire,
): HTMLElement | undefined {
  if (agent.presentation === "tui") {
    return (
      pane.querySelector<HTMLElement>(":scope > .agent-injection-status") ??
      undefined
    );
  }
  const composer = pane.querySelector<HTMLElement>(
    `[data-surface-key="agent:${agent.id}"] .conversation-composer-box`,
  );
  if (!composer) {
    throw new Error(
      `GUI Agent ${agent.id} is on screen with no composer for its Smart Buttons to stand on`,
    );
  }
  return composer;
}

/**
 * How the box meets what it stands on: inset from a composer's right edge
 * past its rounded corner and 8px (`--space-2`) clear of its top; a small gap above a status,
 * right edges lined up.
 */
const SPACING = {
  gui: { inset: 16, gap: 8 },
  tui: { inset: 0, gap: 4 },
} as const;

/** How far an arrow key moves the box, in pixels. */
const KEY_STEP = 8;

interface Metrics {
  readonly pane: Box & Size;
  readonly anchor: Box;
  readonly box: Size;
}

export function SmartButtons({
  agent,
  stored,
}: {
  readonly agent: AgentWire;
  /** Where main remembers this presentation's box was put, if anywhere. */
  readonly stored: SmartButtonsSpot | undefined;
}) {
  const { repositoryStatus, agentActions, runAgentAction, dispatch } =
    useAgents();
  const repository = repositoryStatus.workspaces.find(
    (entry) => entry.workspaceId === agent.workspaceId,
  );
  const lines = smartButtonLines(agent, repository, agentActions);
  const offered = lines.filter((line) => line.active);
  const automatic = agentActions.filter((action) =>
    isAutomaticTrigger(action.trigger),
  );
  const ticked = agent.automaticActions ?? [];
  const [menuOpen, setMenuOpen] = useState(false);
  const own = useRef<HTMLDivElement | null>(null);
  const present = usePresence(lines);
  const metrics = useMetrics(own, agent, present.length + (menuOpen ? 1 : 0));
  // Set only by a drop, double-click or key move: the one time the box's
  // position is allowed to glide. Never on mount, page switch or resize.
  const [settling, setSettling] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(settleTimer.current), []);
  const [drag, setDrag] = useState<{
    readonly pointer: { readonly x: number; readonly y: number };
    readonly from: SmartButtonsOffset;
    readonly to: SmartButtonsSpot | undefined;
  }>();
  if (lines.length === 0 && automatic.length === 0) return null;

  const spacing = SPACING[agent.presentation];
  const fallback = defaultSpot(spacing);
  const offsetOf = (spot: SmartButtonsSpot): SmartButtonsOffset =>
    metrics === undefined
      ? // Before the first measurement — the one render that precedes the
        // layout effect, never painted — the pane's corner.
        isAnchoredSpot(spot)
        ? { right: SMART_BUTTONS_MARGIN, bottom: SMART_BUTTONS_MARGIN }
        : spot
      : clampOffset(
          spotOffset(spot, metrics.pane, metrics.anchor, metrics.box, spacing),
          metrics.pane,
          metrics.box,
        );
  const restingSpot = stored ?? fallback;
  const resting = offsetOf(restingSpot);
  const shownSpot = drag?.to ?? restingSpot;
  const drawn = offsetOf(shownSpot);
  /** The spot a box at this offset belongs at, snapped if near the anchor. */
  const snapped = (offset: SmartButtonsOffset): SmartButtonsSpot =>
    metrics === undefined
      ? offset
      : snapSpot(offset, metrics.pane, metrics.anchor, metrics.box, spacing);
  const place = (spot: SmartButtonsSpot | undefined) => {
    setSettling(true);
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(
      () => setSettling(false),
      SMART_BUTTONS_SETTLE_MS,
    );
    return dispatch({
      type: "place_smart_buttons",
      presentation: agent.presentation,
      // Dropped on the default spot is the default spot: forgotten.
      ...(spot === undefined || sameSpot(spot, fallback) ? {} : { spot }),
    });
  };
  const anchored = isAnchoredSpot(shownSpot) ? shownSpot.anchored : undefined;
  const setAutomatic = (actionId: string, on: boolean) =>
    dispatch({
      type: "set_automatic_action",
      agentId: agent.id,
      actionId,
      automatic: on,
    });

  return (
    <div
      ref={own}
      className="smart-buttons"
      role="toolbar"
      aria-label="Smart Buttons"
      aria-orientation="vertical"
      data-presentation={agent.presentation}
      data-placed={stored === undefined ? "default" : "moved"}
      {...(anchored === undefined ? {} : { "data-anchored": anchored })}
      {...(drag === undefined ? {} : { "data-dragging": "" })}
      {...(settling ? { "data-settling": "" } : {})}
      {...(offered.length === 0 && ticked.length === 0 && !menuOpen
        ? { "data-quiet": "" }
        : {})}
      style={{
        right: `${String(drawn.right)}px`,
        bottom: `${String(drawn.bottom)}px`,
      }}
    >
      <div className="smart-buttons-header">
        <span
          className="smart-buttons-handle"
          role="button"
          tabIndex={0}
          aria-label="Move the Smart Buttons"
          aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home"
          title="Drag to move; near the input box it snaps to it and stays there. Double-click to put it back."
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            setDrag({
              pointer: { x: event.clientX, y: event.clientY },
              from: resting,
              to: undefined,
            });
          }}
          onPointerMove={(event) => {
            if (drag === undefined || metrics === undefined) return;
            const moved = {
              x: event.clientX - drag.pointer.x,
              y: event.clientY - drag.pointer.y,
            };
            // Under the threshold the handle was pressed, not moved: a
            // double-click is two of those, and neither is a place to
            // remember.
            if (
              drag.to === undefined &&
              Math.hypot(moved.x, moved.y) < SMART_BUTTONS_DRAG_THRESHOLD
            ) {
              return;
            }
            setDrag({
              ...drag,
              to: snapped(
                draggedOffset(drag.from, moved, metrics.pane, metrics.box),
              ),
            });
          }}
          onPointerUp={(event) => {
            event.currentTarget.releasePointerCapture(event.pointerId);
            const to = drag?.to;
            if (to === undefined) {
              setDrag(undefined);
              return;
            }
            // Held where it was dropped until main's snapshot says so, then
            // drawn from the snapshot; a refusal goes to the page's root and
            // the box goes back to where main still has it.
            void place(to).finally(() => setDrag(undefined));
          }}
          onPointerCancel={() => setDrag(undefined)}
          onDoubleClick={() => {
            void place(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Home") {
              event.preventDefault();
              void place(undefined);
              return;
            }
            const step = {
              ArrowLeft: { x: -KEY_STEP, y: 0 },
              ArrowRight: { x: KEY_STEP, y: 0 },
              ArrowUp: { x: 0, y: -KEY_STEP },
              ArrowDown: { x: 0, y: KEY_STEP },
            }[event.key];
            if (step === undefined || metrics === undefined) return;
            event.preventDefault();
            void place(
              snapped(draggedOffset(resting, step, metrics.pane, metrics.box)),
            );
          }}
        >
          <GripIcon />
        </span>
        {automatic.length > 0 ? (
          <AutomaticMenu
            agent={agent}
            choices={automatic}
            ticked={ticked}
            open={menuOpen}
            setOpen={setMenuOpen}
            set={setAutomatic}
          />
        ) : null}
      </div>
      {present.map(({ line: { action, active }, exiting, entering }) => {
        const on = ticked.includes(action.id);
        const when = FIRES_WHEN[action.trigger];
        return (
          <div
            key={action.id}
            className="smart-button-line"
            {...(on ? { "data-automatic": "" } : {})}
            {...(entering ? { "data-entering": "" } : {})}
            {...(exiting ? { "data-exiting": "", "aria-hidden": true } : {})}
            {...(exiting ? { inert: true } : {})}
          >
            <button
              type="button"
              className="smart-button"
              {...(active
                ? {
                    title: `${action.displayName} — sent to ${agent.displayName}${
                      on ? " (automatic: also sent on its own)" : ""
                    }`,
                    onClick: () => {
                      void runAgentAction(agent.id, action.id);
                    },
                  }
                : {
                    "aria-disabled": true,
                    "data-waiting": "",
                    title: `${action.displayName} — sent to ${agent.displayName} automatically when its condition arises${
                      when === undefined ? "" : ` (${when.toLowerCase()})`
                    }`,
                  })}
            >
              {action.displayName}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The header's bolt and its panel: every action that may be automatic for
 * this Agent, each switch with what makes it fire — including the ones whose
 * button is not on screen now.
 */
function AutomaticMenu({
  agent,
  choices,
  ticked,
  open,
  setOpen,
  set,
}: {
  readonly agent: AgentWire;
  readonly choices: readonly AgentActionWire[];
  readonly ticked: readonly string[];
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly set: (actionId: string, automatic: boolean) => Promise<unknown>;
}) {
  const own = useRef<HTMLSpanElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  // Where the panel was when it opened, in the window. Toggling an action
  // adds or removes buttons and so moves the box; the panel stays put until
  // it is closed.
  const [frozen, setFrozen] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    if (!open) {
      setFrozen(undefined);
      return;
    }
    const rect = menu.current?.getBoundingClientRect();
    if (rect) setFrozen({ left: rect.left, top: rect.top });
  }, [open]);
  const count = choices.filter((choice) => ticked.includes(choice.id)).length;
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      if (!own.current?.contains(event.target as Node | null)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open, setOpen]);
  return (
    <span ref={own} className="smart-buttons-automatic">
      <button
        type="button"
        className="smart-buttons-auto"
        aria-label="Automatic actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          count > 0
            ? `${String(count)} sent to ${agent.displayName} on its own — choose which`
            : `Choose actions to send to ${agent.displayName} on their own`
        }
        {...(count > 0 ? { "data-armed": "" } : {})}
        onClick={() => setOpen(!open)}
      >
        <BoltIcon />
        {count > 0 ? (
          <span className="smart-buttons-auto-count">{count}</span>
        ) : null}
      </button>
      {open ? (
        <div
          className="smart-buttons-menu"
          role="menu"
          aria-label={`Automatic actions for ${agent.displayName}`}
          ref={menu}
          {...(frozen === undefined ? {} : { "data-frozen": "" })}
          style={
            frozen === undefined
              ? undefined
              : {
                  position: "fixed",
                  left: `${String(frozen.left)}px`,
                  top: `${String(frozen.top)}px`,
                  right: "auto",
                  bottom: "auto",
                }
          }
        >
          <div className="smart-buttons-menu-intro" role="none">
            Sent to {agent.displayName} on its own, the moment its button would
            appear
          </div>
          {choices.map((choice) => {
            const on = ticked.includes(choice.id);
            const when = FIRES_WHEN[choice.trigger];
            return (
              <button
                key={choice.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                aria-label={choice.displayName}
                {...(when === undefined ? {} : { title: when })}
                className="smart-buttons-menu-item"
                onClick={() => {
                  void set(choice.id, !on);
                }}
              >
                <span className="smart-buttons-switch" aria-hidden="true" />
                <span className="smart-buttons-menu-text">
                  <span className="smart-buttons-menu-name">
                    {choice.displayName}
                  </span>
                  {when === undefined ? null : (
                    <span className="smart-buttons-menu-when">{when}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}

/**
 * The pane's place and size, the anchor's, and the box's, kept current.
 *
 * Measured, because the anchor's place is the layout's — a composer that
 * grows with what is typed in it, a status that comes and goes — and a CSS
 * rule cannot say "on top of that element" from outside the surface it is in.
 */
function useMetrics(
  own: React.RefObject<HTMLDivElement | null>,
  agent: AgentWire,
  count: number,
): Metrics | undefined {
  const [metrics, setMetrics] = useState<Metrics>();
  useLayoutEffect(() => {
    const box = own.current;
    const pane = box?.parentElement;
    if (!box || !pane) {
      setMetrics(undefined);
      return;
    }
    const anchor = anchorOf(pane, agent);
    const measure = () => {
      const paneRect = pane.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      setMetrics({
        pane: paneRect,
        anchor: anchorBox(
          paneRect,
          anchor?.getBoundingClientRect(),
          SPACING[agent.presentation],
        ),
        box: { width: boxRect.width, height: boxRect.height },
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const each of [pane, box, anchor]) {
      if (each) observer.observe(each);
    }
    return () => observer.disconnect();
    // `agent` and `count`, beyond the observers: the queued-message status
    // coming or going (the Agent's `injection`) moves a terminal's anchor, and
    // a button coming or going changes the box's size before any observer has
    // had a frame to say so.
  }, [own, agent, count]);
  return metrics;
}

function GripIcon() {
  return (
    <svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
      {[1, 5, 9].map((x) =>
        [1, 5].map((y) => (
          <circle key={`${String(x)}-${String(y)}`} cx={x} cy={y} r="1" />
        )),
      )}
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 10 12" width="10" height="12" aria-hidden="true">
      <path d="M6 0 0 7h4l-1 5 6-7H5z" />
    </svg>
  );
}
