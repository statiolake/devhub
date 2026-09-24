/**
 * The bar over a GUI Agent's transcript: its settings, what it has used, and
 * the ways out of the turn and out of the GUI.
 *
 * The pickers list the session's own choices (`SessionFacts`), so the page
 * offers exactly what the adapter says this CLI accepts and nothing it had to
 * guess. A picker shows the session's current value and nothing else: a
 * change is asked for, and the picker moves when the session says it has
 * moved. A change that failed therefore leaves it where it truthfully is.
 */

import type { RefObject } from "react";
import type { Setting, Transcript, Usage } from "../../model/conversation";
import {
  useConversationActions,
  type SettingName,
} from "./ConversationContext";
import { inputRefusal } from "./Composer";

export const SETTING_LABELS: Readonly<Record<SettingName, string>> = {
  model: "Model",
  effort: "Effort",
  mode: "Permissions",
};

function SettingPicker({
  name,
  setting,
  disabled,
  pickerRef,
}: {
  readonly name: SettingName;
  readonly setting: Setting;
  readonly disabled: boolean;
  readonly pickerRef: RefObject<HTMLSelectElement | null>;
}) {
  const { setSetting, reportFailure } = useConversationActions();
  if (setting.choices.length === 0) {
    // Nothing to choose from: the value is a fact to read, when there is one.
    return setting.current === undefined ? null : (
      <span className="conversation-setting" data-setting={name}>
        <span className="conversation-setting-label">
          {SETTING_LABELS[name]}
        </span>
        <span className="conversation-setting-value">{setting.current}</span>
      </span>
    );
  }
  // A current value the choices do not list is still the truth, so it is an
  // option too rather than a picker showing something else.
  const listed = setting.choices.some(
    (choice) => choice.id === setting.current,
  );
  return (
    <label className="conversation-setting" data-setting={name}>
      <span className="conversation-setting-label">{SETTING_LABELS[name]}</span>
      <select
        ref={pickerRef}
        value={setting.current ?? ""}
        disabled={disabled}
        onChange={(event) => {
          void setSetting(name, event.target.value).catch(reportFailure);
        }}
      >
        {setting.current === undefined ? (
          <option value="" disabled>
            —
          </option>
        ) : null}
        {!listed && setting.current !== undefined ? (
          <option value={setting.current}>{setting.current}</option>
        ) : null}
        {setting.choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function tokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function clock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** What the session has used, as far as its CLI reports it. */
export function usageReadout(usage: Usage): readonly string[] {
  const parts: string[] = [];
  if (usage.contextTokens !== undefined) {
    parts.push(
      usage.contextWindow !== undefined && usage.contextWindow > 0
        ? `Context ${Math.round((usage.contextTokens / usage.contextWindow) * 100)}% (${tokens(usage.contextTokens)} of ${tokens(usage.contextWindow)})`
        : `Context ${tokens(usage.contextTokens)}`,
    );
  }
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(2)}`);
  const limit = usage.rateLimit;
  if (limit?.usedPercent !== undefined) {
    parts.push(
      limit.resetsAt !== undefined
        ? `Limit ${Math.round(limit.usedPercent)}%, resets ${clock(limit.resetsAt)}`
        : `Limit ${Math.round(limit.usedPercent)}%`,
    );
  }
  return parts;
}

export function SessionHeader({
  transcript,
  pickers,
}: {
  readonly transcript: Transcript;
  readonly pickers: Readonly<
    Record<SettingName, RefObject<HTMLSelectElement | null>>
  >;
}) {
  const { interrupt, continueInTerminal, reportFailure } =
    useConversationActions();
  const { session, state, usage } = transcript;
  const disabled = inputRefusal(state) !== undefined;
  const running = state.phase === "ready" && state.turn === "running";
  const readout = usage ? usageReadout(usage) : [];
  return (
    <header className="conversation-header">
      <div className="conversation-settings">
        <SettingPicker
          name="model"
          setting={session.model}
          disabled={disabled}
          pickerRef={pickers.model}
        />
        <SettingPicker
          name="effort"
          setting={session.effort}
          disabled={disabled}
          pickerRef={pickers.effort}
        />
        <SettingPicker
          name="mode"
          setting={session.mode}
          disabled={disabled}
          pickerRef={pickers.mode}
        />
      </div>
      {readout.length > 0 ? (
        <div className="conversation-usage" aria-label="Usage">
          {readout.join(" · ")}
        </div>
      ) : null}
      <div className="conversation-header-actions">
        {running ? (
          <button
            type="button"
            className="conversation-header-button"
            data-tone="deny"
            title="Stop the turn (Esc or Ctrl+C)"
            onClick={() => {
              void interrupt().catch(reportFailure);
            }}
          >
            Stop
          </button>
        ) : null}
        <button
          type="button"
          className="conversation-header-button"
          onClick={() => {
            void continueInTerminal().catch(reportFailure);
          }}
        >
          Continue in terminal
        </button>
      </div>
    </header>
  );
}
