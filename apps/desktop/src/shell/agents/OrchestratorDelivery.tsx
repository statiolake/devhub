/**
 * The board header's mode control (full · saving · off) and pending count, and, on hover or
 * focus of either, a card with what the next delivery would send now — as
 * main composes it (`EventDispatcher.preview`, the board's `nextDelivery`):
 * the person's held words, each as the message of its own it goes as, then
 * the batch, `event_prompt` with `{EVENT}` filled, and when it goes. With
 * nothing to send it says so. The card is the GitHub pill's
 * (`OrchestratorGitHub.tsx`), the messages monospace and scrolled.
 */

import { useRef, type KeyboardEvent } from "react";
import type {
  OrchestratorBoardWire,
  OrchestratorModeWire,
} from "../../ipc/contract";
import { clockTime, useHoverCard } from "./OrchestratorGitHub";

/** The three modes, in the control's order, with what each one does. */
export const MODES: readonly {
  readonly mode: OrchestratorModeWire;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    mode: "full",
    label: "Full",
    hint: "Full: a delivery at most every delivery_interval, each saying again what still needs action.",
  },
  {
    mode: "saving",
    label: "Saving",
    hint: "Saving: deliveries a third as often, and none while 2 or more tasks are in progress. Your words still go at once.",
  },
  {
    mode: "off",
    label: "Off",
    hint: "Off: everything is held, your words too, and GitHub is not polled. Every launch starts off.",
  },
];

/** Why saving is on, when the usage readout turned it on: one quiet line. */
export function autoSavingWords(
  auto: OrchestratorBoardWire["autoSaving"],
): string | undefined {
  if (auto === undefined) return undefined;
  const cli =
    auto.cli === "claude"
      ? "Claude"
      : auto.cli === "codex"
        ? "Codex"
        : auto.cli;
  const resets =
    auto.resetsAt === undefined
      ? "when the window resets"
      : `when it resets at ${clockTime(auto.resetsAt)}`;
  return `Saving by itself: ${cli} ${auto.window} at ${String(Math.round(auto.usedPercent))}% (${String(auto.threshold)}% or more). Back to full ${resets}.`;
}

type NextDelivery = NonNullable<OrchestratorBoardWire["nextDelivery"]>;

/** When the next delivery goes, as the card's first line says it. */
export function deliveryWhenWords(
  when: NextDelivery["when"],
  paused: boolean,
): string | undefined {
  switch (when?.kind) {
    case undefined:
      return paused ? "paused" : undefined;
    case "now":
      return "now";
    case "at":
      return `at ${clockTime(when.at)} (delivery_interval)`;
    case "after_turn":
      return "when the orchestrator has taken the last message";
    case "paused":
      return "off: sent when the mode is turned to full or saving";
    case "saving_busy":
      return `saving: held while ${String(when.tasks)} tasks are in progress (2 or more)`;
    case "nobody":
      return "never: no orchestrator is running";
  }
}

export function ModeControl({
  board,
  onChoose,
}: {
  readonly board: OrchestratorBoardWire;
  readonly onChoose: (mode: OrchestratorModeWire) => void;
}) {
  const { shown, wrap } = useHoverCard();
  const current: OrchestratorModeWire = board.mode ?? "off";
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const auto = autoSavingWords(board.autoSaving);
  // A radio group: one tab stop, the arrows move the choice and the focus.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    const index = MODES.findIndex((one) => one.mode === current);
    const to =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? MODES.length - 1
          : step === 0
            ? undefined
            : (index + step + MODES.length) % MODES.length;
    if (to === undefined) return;
    event.preventDefault();
    buttons.current[to]?.focus();
    onChoose(MODES[to]!.mode);
  };
  const next = board.nextDelivery;
  const human = next?.human ?? [];
  const batch = next?.batch;
  const nothing = human.length === 0 && batch === undefined;
  const when = deliveryWhenWords(next?.when, board.paused);
  return (
    <span className="orchestrator-delivery-wrap" {...wrap}>
      <div
        className="orchestrator-mode"
        role="radiogroup"
        aria-label="Orchestrator mode"
        aria-describedby={auto === undefined ? undefined : "orchestrator-auto"}
        data-mode={current}
        onKeyDown={onKeyDown}
      >
        {MODES.map((one, index) => (
          <button
            key={one.mode}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            className="orchestrator-mode-option"
            data-mode={one.mode}
            aria-checked={one.mode === current}
            aria-expanded={one.mode === current ? shown : undefined}
            aria-controls="orchestrator-delivery-card"
            tabIndex={one.mode === current ? 0 : -1}
            title={one.hint}
            onClick={() => {
              if (one.mode !== current) onChoose(one.mode);
            }}
          >
            {one.mode === current ? (
              <span className="orchestrator-mode-dot" aria-hidden="true" />
            ) : null}
            {one.label}
          </button>
        ))}
      </div>
      {auto === undefined ? null : (
        <span id="orchestrator-auto" className="orchestrator-mode-auto">
          auto
        </span>
      )}
      {board.held > 0 ? (
        <span className="orchestrator-pending" tabIndex={0}>
          {board.held} pending
        </span>
      ) : null}
      {shown ? (
        <div
          id="orchestrator-delivery-card"
          className="orchestrator-github-card orchestrator-delivery-card"
          role="dialog"
          aria-label="Next delivery"
        >
          {auto === undefined ? null : (
            <div className="orchestrator-github-line">{auto}</div>
          )}
          <div className="orchestrator-github-line">
            <strong>Next delivery</strong>
            {when === undefined ? null : <span>: {when}</span>}
          </div>
          {nothing ? (
            <p className="orchestrator-delivery-none">Nothing to send</p>
          ) : null}
          {human.map((text, index) => (
            <section key={`human-${String(index)}`}>
              <h3 className="orchestrator-delivery-label">
                The person's words, message {index + 1} of {human.length}
              </h3>
              <pre className="orchestrator-delivery-text">{text}</pre>
            </section>
          ))}
          {batch === undefined ? null : (
            <section>
              <h3 className="orchestrator-delivery-label">
                Events, one message: {next?.lines ?? 0} line
                {next?.lines === 1 ? "" : "s"}
                {(next?.more ?? 0) > 0
                  ? `, ${String(next?.more ?? 0)} more counted`
                  : ""}
              </h3>
              <pre className="orchestrator-delivery-text">{batch}</pre>
            </section>
          )}
        </div>
      ) : null}
    </span>
  );
}
