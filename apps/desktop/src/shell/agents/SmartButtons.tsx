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
 * **Where.** A GUI Agent's sit on its composer's top edge, touching it; a
 * terminal's in the pane's bottom right corner above the queued-message
 * status. The box can be dragged anywhere in the pane by its handle, and main
 * remembers where per presentation (`model/smartButtons.ts`); a double-click
 * on the handle puts it back. What is drawn is always clamped to the pane as
 * it is now, so a smaller window never hides it.
 *
 * **How it looks.** Translucent at rest — it sits over the work — and at full
 * strength while pointed at, holding focus, or being dragged
 * (`smartButtons.css`).
 *
 * **Automatic.** The box's Auto menu lists the actions that may be automatic
 * (`AUTOMATIC_TRIGGERS`), each with a check box, for this Agent only and off
 * until ticked. A ticked one is sent on its own when its button would appear
 * — main decides when (`model/automaticActions.ts`) — and its button, when it
 * is on screen, says so. So the box is there whenever the Agent has an action
 * that may be automatic, not only while a button is offered: the moment to
 * tick "Address review comments" is before the comments arrive. With no
 * button offered and nothing ticked it shows only while the pane is pointed
 * at.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentWire } from "../../ipc/appShell";
import type {
  AgentActionWire,
  WorkspaceRepositoryWire,
} from "../../ipc/contract";
import { smartButtonTriggers } from "../../model/agentActions";
import { isAutomaticTrigger } from "../../model/automaticActions";
import {
  clampOffset,
  defaultOffset,
  draggedOffset,
  SMART_BUTTONS_DRAG_THRESHOLD,
  SMART_BUTTONS_MARGIN,
  type Box,
  type Size,
  type SmartButtonsOffset,
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

/**
 * What the default spot is attached to.
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
 * past its rounded corner and touching its top; a small gap above a status,
 * right edges lined up.
 */
const SPACING = {
  gui: { inset: 16, gap: 0 },
  tui: { inset: 0, gap: 4 },
} as const;

interface Metrics {
  readonly pane: Box & Size;
  readonly box: Size;
  readonly spot: SmartButtonsOffset;
}

export function SmartButtons({
  agent,
  stored,
}: {
  readonly agent: AgentWire;
  /** Where main remembers this presentation's box was dragged, if anywhere. */
  readonly stored: SmartButtonsOffset | undefined;
}) {
  const { repositoryStatus, agentActions, runAgentAction, dispatch } =
    useAgents();
  const repository = repositoryStatus.workspaces.find(
    (entry) => entry.workspaceId === agent.workspaceId,
  );
  const offered = smartButtonActions(agent, repository, agentActions);
  const automatic = agentActions.filter((action) =>
    isAutomaticTrigger(action.trigger),
  );
  const ticked = agent.automaticActions ?? [];
  const [menuOpen, setMenuOpen] = useState(false);
  const own = useRef<HTMLDivElement | null>(null);
  const metrics = useMetrics(own, agent, offered.length + (menuOpen ? 1 : 0));
  const [drag, setDrag] = useState<{
    readonly pointer: { readonly x: number; readonly y: number };
    readonly from: SmartButtonsOffset;
    readonly to: SmartButtonsOffset | undefined;
  }>();
  if (offered.length === 0 && automatic.length === 0) return null;

  // Before the first measurement — the one render that precedes the layout
  // effect, never painted — the pane's corner.
  const resting =
    metrics === undefined
      ? (stored ?? {
          right: SMART_BUTTONS_MARGIN,
          bottom: SMART_BUTTONS_MARGIN,
        })
      : clampOffset(stored ?? metrics.spot, metrics.pane, metrics.box);
  const drawn = drag?.to ?? resting;
  const place = (offset: SmartButtonsOffset | undefined) =>
    dispatch({
      type: "place_smart_buttons",
      presentation: agent.presentation,
      ...(offset === undefined ? {} : { offset }),
    });

  return (
    <div
      ref={own}
      className="smart-buttons"
      role="toolbar"
      aria-label="Smart Buttons"
      data-presentation={agent.presentation}
      data-placed={stored === undefined ? "default" : "moved"}
      {...(drag === undefined ? {} : { "data-dragging": "" })}
      {...(offered.length === 0 && ticked.length === 0 && !menuOpen
        ? { "data-quiet": "" }
        : {})}
      style={{
        right: `${String(drawn.right)}px`,
        bottom: `${String(drawn.bottom)}px`,
      }}
    >
      <span
        className="smart-buttons-handle"
        title="Drag to move the Smart Buttons; double-click to put them back"
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
          // double-click is two of those, and neither is a place to remember.
          if (
            drag.to === undefined &&
            Math.hypot(moved.x, moved.y) < SMART_BUTTONS_DRAG_THRESHOLD
          ) {
            return;
          }
          setDrag({
            ...drag,
            to: draggedOffset(drag.from, moved, metrics.pane, metrics.box),
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
      >
        <GripIcon />
      </span>
      {offered.map((action) => (
        <button
          key={action.id}
          type="button"
          className="smart-button"
          title={`${action.displayName} — sent to ${agent.displayName}${
            ticked.includes(action.id) ? " (automatic: sent on its own)" : ""
          }`}
          {...(ticked.includes(action.id) ? { "data-automatic": "" } : {})}
          onClick={() => {
            void runAgentAction(agent.id, action.id);
          }}
        >
          {action.displayName}
        </button>
      ))}
      {automatic.length > 0 ? (
        <AutomaticMenu
          agent={agent}
          choices={automatic}
          ticked={ticked}
          open={menuOpen}
          setOpen={setMenuOpen}
          set={(actionId, on) =>
            dispatch({
              type: "set_automatic_action",
              agentId: agent.id,
              actionId,
              automatic: on,
            })
          }
        />
      ) : null}
    </div>
  );
}

/**
 * The Auto button and its menu: which actions are sent on their own for this
 * Agent. A check box per action that may be automatic, off until ticked.
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
        className="smart-button smart-buttons-auto"
        aria-label="Automatic actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Actions sent to ${agent.displayName} on their own, the moment their button would appear`}
        {...(count > 0 ? { "data-armed": "" } : {})}
        onClick={() => setOpen(!open)}
      >
        {count > 0 ? `Auto ${String(count)}` : "Auto"}
      </button>
      {open ? (
        <div
          className="smart-buttons-menu"
          role="menu"
          aria-label={`Automatic actions for ${agent.displayName}`}
        >
          {choices.map((choice) => {
            const on = ticked.includes(choice.id);
            return (
              <button
                key={choice.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                className="smart-buttons-menu-item"
                onClick={() => {
                  void set(choice.id, !on);
                }}
              >
                <span className="smart-buttons-check" aria-hidden="true">
                  {on ? "✓" : ""}
                </span>
                {choice.displayName}
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}

/**
 * The pane's size, the box's, and the default spot, kept current.
 *
 * Measured, because the default spot is attached to something whose place is
 * the layout's — a composer that grows with what is typed in it, a status
 * that comes and goes — and a CSS rule cannot say "on top of that element"
 * from outside the surface it is in.
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
        box: { width: boxRect.width, height: boxRect.height },
        spot: defaultOffset(
          paneRect,
          anchor?.getBoundingClientRect(),
          SPACING[agent.presentation],
        ),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const each of [pane, box, anchor]) {
      if (each) observer.observe(each);
    }
    return () => observer.disconnect();
    // `agent` and `count`, beyond the observers: the queued-message status
    // coming or going (the Agent's `injection`) moves a terminal's spot, and a
    // button coming or going changes the box's size before any observer has
    // had a frame to say so.
  }, [own, agent, count]);
  return metrics;
}

function GripIcon() {
  return (
    <svg viewBox="0 0 6 10" width="6" height="10" aria-hidden="true">
      {[1, 5].map((x) =>
        [1, 5, 9].map((y) => (
          <circle key={`${String(x)}-${String(y)}`} cx={x} cy={y} r="1" />
        )),
      )}
    </svg>
  );
}
