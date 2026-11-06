/**
 * The board header's Events switch and pending count, and, on hover or
 * focus of either, a card with what the next delivery would send now — as
 * main composes it (`EventDispatcher.preview`, the board's `nextDelivery`):
 * the person's held words, each as the message of its own it goes as, then
 * the batch, `event_prompt` with `{EVENT}` filled, and when it goes. With
 * nothing to send it says so. The card is the GitHub pill's
 * (`OrchestratorGitHub.tsx`), the messages monospace and scrolled.
 */

import type { OrchestratorBoardWire } from "../../ipc/contract";
import { clockTime, useHoverCard } from "./OrchestratorGitHub";

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
      return "paused: sent when Events is turned on";
    case "nobody":
      return "never: no orchestrator is running";
  }
}

export function EventsSwitch({
  board,
  disabled,
  onToggle,
}: {
  readonly board: OrchestratorBoardWire;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}) {
  const { shown, wrap } = useHoverCard();
  const next = board.nextDelivery;
  const human = next?.human ?? [];
  const batch = next?.batch;
  const nothing = human.length === 0 && batch === undefined;
  const when = deliveryWhenWords(next?.when, board.paused);
  return (
    <span className="orchestrator-delivery-wrap" {...wrap}>
      <button
        type="button"
        className="orchestrator-pause"
        role="switch"
        aria-checked={!board.paused}
        aria-expanded={shown}
        aria-controls="orchestrator-delivery-card"
        disabled={disabled}
        onClick={onToggle}
      >
        <span className="orchestrator-pause-track" aria-hidden="true">
          <span className="orchestrator-pause-knob" />
        </span>
        {/* The switch says on or off; the word is only what it is. */}
        Events
      </button>
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
