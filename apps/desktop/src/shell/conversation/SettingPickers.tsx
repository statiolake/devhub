/**
 * The session's settings, as the pickers in the composer's toolbar.
 *
 * The pickers list the session's own choices (`SessionFacts`), so the page
 * offers exactly what the adapter says this CLI accepts and nothing it had to
 * guess. A picker shows the session's current value and nothing else: a
 * change is asked for, and the picker moves when the session says it has
 * moved. A change that failed therefore leaves it where it truthfully is.
 * While the session has not named a value, the picker says so in words
 * (`UNKNOWN_VALUE`) rather than standing empty.
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

/**
 * What a picker says while its session has not named its value: the model
 * and permissions are not known yet (Claude names them only when the first
 * turn starts), and an effort nothing has chosen is the CLI's own default.
 */
export const UNKNOWN_VALUE: Readonly<Record<SettingName, string>> = {
  model: "Not known yet",
  effort: "Default",
  mode: "Not known yet",
};

const UNKNOWN_HINT: Readonly<Record<SettingName, string>> = {
  model: "The Agent names its model when its first turn starts",
  effort: "No effort was chosen here: the Agent runs at its own default",
  mode: "The Agent names its permissions when its first turn starts",
};

/**
 * Whether a setting has anything to show. Each one always does — a value, or
 * what is said while there is none — except an effort the model is known not
 * to take: a known model that lists no efforts.
 */
function shown(name: SettingName, session: SessionFacts): boolean {
  const setting = session[name];
  return !(
    name === "effort" &&
    setting.choices.length === 0 &&
    setting.current === undefined &&
    session.model.current !== undefined
  );
}

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
  const unknown = setting.current === undefined;
  if (setting.choices.length === 0) {
    // Nothing to choose from: the value is a fact to read.
    return (
      <span
        className="conversation-setting"
        data-setting={name}
        data-unknown={unknown || undefined}
        title={unknown ? UNKNOWN_HINT[name] : undefined}
      >
        <span className="conversation-setting-label">
          {SETTING_LABELS[name]}
        </span>
        <span className="conversation-setting-value">
          {setting.current ?? UNKNOWN_VALUE[name]}
        </span>
      </span>
    );
  }
  // A current value the choices do not list is still the truth, so it is an
  // option too rather than a picker showing something else.
  const listed = setting.choices.some(
    (choice) => choice.id === setting.current,
  );
  return (
    <label
      className="conversation-setting"
      data-setting={name}
      data-unknown={unknown || undefined}
      title={unknown ? UNKNOWN_HINT[name] : undefined}
    >
      <span className="conversation-setting-label">{SETTING_LABELS[name]}</span>
      <select
        ref={pickerRef}
        value={setting.current ?? ""}
        disabled={disabled}
        onChange={(event) => {
          void setSetting(name, event.target.value).catch(reportFailure);
        }}
      >
        {unknown ? (
          <option value="" disabled>
            {UNKNOWN_VALUE[name]}
          </option>
        ) : null}
        {!listed && !unknown ? (
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
      {SETTING_NAMES.filter((name) => shown(name, session)).map((name) => (
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
