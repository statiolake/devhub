/**
 * The session's settings, as the pickers in the composer's toolbar.
 *
 * The pickers list the session's own choices (`SessionFacts`), so the page
 * offers exactly what the adapter says this CLI accepts and nothing it had to
 * guess. A picker shows the session's current value and nothing else: a
 * change is asked for, and the picker moves when the session says it has
 * moved. A change that failed therefore leaves it where it truthfully is.
 * While the session has not named a value, the picker says so in words
 * (`UNKNOWN_VALUE`) rather than standing empty, and a setting the session
 * gave nothing to choose from says why it can't be changed (`unchangeable`).
 *
 * A picker is DevHub's own list, not a `<select>`: the platform's menu for a
 * `<select>` is drawn by macOS at the page's font size beside a check of the
 * menu's own size, and nothing on the page can set either. Opened, a picker
 * is a small panel of DevHub's list rows (`mac-list-row`), as the `/`
 * command list is, with a check the size of the row's words on the current
 * value. It is a select-only combobox: the keyboard stays on the button and
 * the arrows walk the rows (`aria-activedescendant`).
 */

import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { Setting, SessionFacts } from "../../model/conversation";
import {
  useConversationActions,
  type SettingName,
} from "./ConversationContext";
import { CheckIcon, ChevronDownIcon } from "./icons";

const SETTING_NAMES = ["model", "effort", "mode"] as const;

export const SETTING_LABELS: Readonly<Record<SettingName, string>> = {
  model: "Model",
  effort: "Effort",
  mode: "Permissions",
};

/**
 * What a picker says while its session has not named its value: the model
 * and permissions are not known yet (Claude names them only when the first
 * turn starts), and an effort nothing has chosen is the CLI's own default —
 * which Claude does not report, so it is said as that and not as a level.
 */
export const UNKNOWN_VALUE: Readonly<Record<SettingName, string>> = {
  model: "Not known yet",
  effort: "CLI's default",
  mode: "Not known yet",
};

const UNKNOWN_HINT: Readonly<Record<SettingName, string>> = {
  model: "The Agent names its model when its first turn starts",
  effort:
    "No effort was chosen here, and the Agent does not report the one it runs at: it is the CLI's own, from --effort, its environment, its settings or the model's default",
  mode: "The Agent names its permissions when its first turn starts",
};

/** What the composer holds a picker by: a command that changes a setting opens it. */
export interface SettingPickerHandle {
  /** Take the keyboard and show the list, on the current value. */
  readonly open: () => void;
}

/**
 * Whether a setting has anything to show. Each one always does — a value, or
 * what is said while there is none — except an effort the model is known not
 * to take: a known model that lists no efforts, and nothing said about why.
 */
function shown(name: SettingName, session: SessionFacts): boolean {
  const setting = session[name];
  return !(
    name === "effort" &&
    setting.choices.length === 0 &&
    setting.current === undefined &&
    setting.unchangeable === undefined &&
    session.model.current !== undefined
  );
}

type SettingChoice = Setting["choices"][number];

/**
 * The rows a picker lists: the session's choices, and a current value the
 * choices do not name ahead of them — it is still the truth, so it is a row
 * too rather than a picker showing something else.
 */
function rowsOf(setting: Setting): readonly SettingChoice[] {
  const current = setting.current;
  if (
    current === undefined ||
    setting.choices.some((choice) => choice.id === current)
  ) {
    return setting.choices;
  }
  return [{ id: current, label: current }, ...setting.choices];
}

/** A setting's word and its value, as the closed picker and the fact read alike. */
function SettingWords({
  name,
  setting,
  labelId,
}: {
  readonly name: SettingName;
  readonly setting: Setting;
  readonly labelId?: string;
}) {
  return (
    <>
      <span className="conversation-setting-label" id={labelId}>
        {SETTING_LABELS[name]}
      </span>
      <span className="conversation-setting-value">
        {rowsOf(setting).find((row) => row.id === setting.current)?.label ??
          UNKNOWN_VALUE[name]}
      </span>
    </>
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
  readonly pickerRef: RefObject<SettingPickerHandle | null>;
}) {
  if (setting.choices.length === 0) {
    // Nothing to choose from: the value is a fact to read.
    const unknown = setting.current === undefined;
    return (
      <span
        className="conversation-setting"
        data-setting={name}
        data-unknown={unknown || undefined}
      >
        <span
          className="conversation-setting-face"
          title={unknown ? UNKNOWN_HINT[name] : undefined}
        >
          <SettingWords name={name} setting={setting} />
          {setting.unchangeable === undefined ? null : (
            <span className="conversation-setting-note">
              {setting.unchangeable}
            </span>
          )}
        </span>
      </span>
    );
  }
  return (
    <ChoosableSetting
      name={name}
      setting={setting}
      disabled={disabled}
      pickerRef={pickerRef}
    />
  );
}

function ChoosableSetting({
  name,
  setting,
  disabled,
  pickerRef,
}: {
  readonly name: SettingName;
  readonly setting: Setting;
  readonly disabled: boolean;
  readonly pickerRef: RefObject<SettingPickerHandle | null>;
}) {
  const { setSetting, reportFailure } = useConversationActions();
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const rows = rowsOf(setting);
  const currentIndex = rows.findIndex((row) => row.id === setting.current);
  /** The highlighted row while the list is open; closed, nothing. */
  const [highlighted, setHighlighted] = useState<number | undefined>(undefined);
  // A picker that can't be used now (the Agent is rewinding) closes, and
  // stays closed when it can be used again.
  if (disabled && highlighted !== undefined) setHighlighted(undefined);
  const open = highlighted !== undefined;
  const unknown = setting.current === undefined;
  const current = rows[currentIndex];

  const show = () => setHighlighted(Math.max(currentIndex, 0));
  const close = () => setHighlighted(undefined);
  const choose = (row: SettingChoice) => {
    close();
    if (row.id === setting.current) return;
    void setSetting(name, row.id).catch(reportFailure);
  };

  useImperativeHandle(pickerRef, () => ({
    open: () => {
      if (disabled) {
        // As the platform's picker refused to open disabled: said, not
        // swallowed, since the command did nothing.
        throw new Error(
          `The ${SETTING_LABELS[name]} picker can't be opened until the Agent can take a change`,
        );
      }
      button.current?.focus();
      show();
    },
  }));

  useEffect(() => {
    if (!open) return;
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [open, highlighted]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const plain =
      !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (!plain) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        show();
      }
      return;
    }
    const at = highlighted ?? 0;
    const step: Readonly<Record<string, number>> = {
      ArrowDown: 1,
      ArrowUp: -1,
    };
    if (event.key in step) {
      event.preventDefault();
      setHighlighted((at + step[event.key]! + rows.length) % rows.length);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setHighlighted(event.key === "Home" ? 0 : rows.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(rows[at]!);
    } else if (event.key === "Escape") {
      // The list closes; the turn is not interrupted by the same key.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      close();
    }
  };

  const optionId = (index: number) => `${id}-${index}`;
  return (
    <span
      className="conversation-setting"
      data-setting={name}
      data-unknown={unknown || undefined}
    >
      <button
        ref={button}
        type="button"
        role="combobox"
        className="conversation-setting-face"
        aria-labelledby={`${id}-label`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={
          open && highlighted !== undefined ? optionId(highlighted) : undefined
        }
        disabled={disabled}
        title={
          open ? undefined : unknown ? UNKNOWN_HINT[name] : current?.detail
        }
        onClick={() => {
          button.current?.focus();
          if (open) close();
          else show();
        }}
        onKeyDown={onKeyDown}
        onBlur={close}
      >
        <SettingWords name={name} setting={setting} labelId={`${id}-label`} />
        <span className="conversation-setting-chevron">
          <ChevronDownIcon />
        </span>
      </button>
      {open ? (
        <div className="conversation-setting-menu mac">
          <ul
            ref={list}
            id={`${id}-list`}
            className="mac-list conversation-setting-list"
            role="listbox"
            aria-labelledby={`${id}-label`}
          >
            {rows.map((row, index) => (
              <li
                key={row.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === highlighted}
                aria-checked={index === currentIndex}
                className="mac-list-row conversation-setting-choice"
                title={row.detail}
                // The keyboard stays on the button, so the list stays open.
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (index !== highlighted) setHighlighted(index);
                }}
                onClick={() => choose(row)}
              >
                <span className="mac-list-glyph" aria-hidden="true">
                  {index === currentIndex ? <CheckIcon /> : null}
                </span>
                <span className="mac-list-title">{row.label}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </span>
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
    Record<SettingName, RefObject<SettingPickerHandle | null>>
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
