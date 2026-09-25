/**
 * The session's settings, as the pickers in the composer's toolbar.
 *
 * The pickers list the session's own choices (`SessionFacts`), so the page
 * offers exactly what the adapter says this CLI accepts and nothing it had to
 * guess. A picker shows the session's current value and nothing else: a
 * change is asked for, and the picker moves when the session says it has
 * moved. A change that failed therefore leaves it where it truthfully is.
 */

import type { RefObject } from "react";
import type { Setting, SessionFacts } from "../../model/conversation";
import {
  useConversationActions,
  type SettingName,
} from "./ConversationContext";

const SETTING_NAMES = ["model", "effort", "mode"] as const;

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

export function SettingPickers({
  session,
  disabled,
  pickers,
}: {
  readonly session: SessionFacts;
  readonly disabled: boolean;
  readonly pickers: Readonly<
    Record<SettingName, RefObject<HTMLSelectElement | null>>
  >;
}) {
  return (
    <div className="conversation-settings">
      {SETTING_NAMES.map((name) => (
        <SettingPicker
          key={name}
          name={name}
          setting={session[name]}
          disabled={disabled}
          pickerRef={pickers[name]}
        />
      ))}
    </div>
  );
}
