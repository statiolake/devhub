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
 *
 * # The CLI's defaults
 *
 * Choosing a row changes this session only. Beside the rows of the model
 * and the effort, the picker also says which one the CLI's *new* sessions
 * start on (`model/claudeDefaults.ts`), with a mark at the row's right end,
 * and every other row has a button that makes it that default: Claude Code's
 * user settings are changed, as its own `/model` and `/effort` save them in
 * a terminal, and this session is left where it is. Option-Return does the
 * same for the highlighted row. When something above the user settings
 * decides the default (the profile's arguments, the environment, managed,
 * local or project settings), the mark and the button say so: a default
 * saved then does not take effect until that is gone.
 *
 * An effort nothing named is the CLI's own, resolved when its process
 * started (Claude does not report it); it reads as the level that resolves
 * to — "CLI's default (medium)" — and where that came from is its hint.
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
import {
  SAVABLE_EFFORTS,
  SOURCE_WORDS,
  userSettingsDecide,
  type CliDefault,
  type CliDefaults,
} from "../../model/claudeDefaults";
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

/** The settings that have a CLI's default for new sessions. */
type DefaultName = "model" | "effort";

function hasDefault(name: SettingName): name is DefaultName {
  return name === "model" || name === "effort";
}

/**
 * The row that is the CLI's default: the one of that value, else the one
 * that resolves to it; a model nothing set is the account's own default,
 * which Claude lists as the choice `default`.
 */
function defaultRow(
  rows: readonly SettingChoice[],
  known: CliDefault,
): SettingChoice | undefined {
  const value = known.value ?? (known.source === "built-in" ? "default" : "");
  return (
    rows.find((row) => row.id === value) ??
    rows.find((row) => row.resolved !== undefined && row.resolved === value)
  );
}

/** Where a default comes from, in the words a hint says it. */
function sourceSentence(known: CliDefault): string {
  return known.source === "built-in"
    ? "Claude Code's own default"
    : `set by ${SOURCE_WORDS[known.source]}`;
}

/**
 * Why making a row the default would not take effect now — something above
 * the user settings decides it — or undefined when it would.
 */
function shadowedBy(known: CliDefault): string | undefined {
  return userSettingsDecide(known.source)
    ? undefined
    : `${SOURCE_WORDS[known.source]} sets the default now, so new sessions keep that until it is gone`;
}

/** What a session's effort reads as while nothing named it: the level the CLI resolves. */
function unknownEffort(known: CliDefault | undefined): string {
  return known?.value === undefined
    ? UNKNOWN_VALUE.effort
    : `${UNKNOWN_VALUE.effort} (${known.value})`;
}

/** The full name of the session's model, as an effort is saved for it. */
function modelName(session: SessionFacts): string | undefined {
  const current = session.model.current;
  if (current === undefined) return undefined;
  return (
    session.model.choices.find((choice) => choice.id === current)?.resolved ??
    current
  );
}

/** What a picker of a setting with a CLI's default is given of it. */
interface DefaultOffer {
  readonly known: CliDefault;
  /** Make the row `id` the default. */
  readonly set: (id: string) => void;
}

/** The hint of a value nothing named: the CLI's default, and where it is from, when known. */
function unknownHint(name: SettingName, known: CliDefault | undefined): string {
  if (name !== "effort" || known?.value === undefined)
    return UNKNOWN_HINT[name];
  return `No effort was chosen here, so the Agent runs at the CLI's own, which resolves to ${known.value} (${sourceSentence(known)}). Claude does not report it, so this is what it started with.`;
}

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
  known,
}: {
  readonly name: SettingName;
  readonly setting: Setting;
  readonly labelId?: string;
  readonly known?: CliDefault | undefined;
}) {
  return (
    <>
      <span className="conversation-setting-label" id={labelId}>
        {SETTING_LABELS[name]}
      </span>
      <span className="conversation-setting-value">
        {rowsOf(setting).find((row) => row.id === setting.current)?.label ??
          (name === "effort" ? unknownEffort(known) : UNKNOWN_VALUE[name])}
      </span>
    </>
  );
}

function SettingPicker({
  name,
  setting,
  disabled,
  pickerRef,
  offer,
}: {
  readonly name: SettingName;
  readonly setting: Setting;
  readonly disabled: boolean;
  readonly pickerRef: RefObject<SettingPickerHandle | null>;
  readonly offer: DefaultOffer | undefined;
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
          title={unknown ? unknownHint(name, offer?.known) : undefined}
        >
          <SettingWords name={name} setting={setting} known={offer?.known} />
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
      offer={offer}
    />
  );
}

function ChoosableSetting({
  name,
  setting,
  disabled,
  pickerRef,
  offer,
}: {
  readonly name: SettingName;
  readonly setting: Setting;
  readonly disabled: boolean;
  readonly pickerRef: RefObject<SettingPickerHandle | null>;
  readonly offer: DefaultOffer | undefined;
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
  const byDefault =
    offer === undefined ? undefined : defaultRow(rows, offer.known);
  /** Why a row cannot be made the default, or undefined when it can. */
  const notSavable = (row: SettingChoice): string | undefined =>
    name === "effort" && !SAVABLE_EFFORTS.includes(row.id)
      ? `Claude Code's settings do not keep ${row.id} as a default: it is for one session only`
      : undefined;
  const makeDefault = (row: SettingChoice) => {
    if (offer === undefined || row === byDefault || notSavable(row)) return;
    offer.set(row.id);
  };

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
    if (
      open &&
      event.key === "Enter" &&
      event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey
    ) {
      // Option-Return: the highlighted row becomes the CLI's default.
      event.preventDefault();
      const row = rows[highlighted ?? 0];
      if (row !== undefined) makeDefault(row);
      return;
    }
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
          open
            ? undefined
            : unknown
              ? unknownHint(name, offer?.known)
              : current?.detail
        }
        onClick={() => {
          button.current?.focus();
          if (open) close();
          else show();
        }}
        onKeyDown={onKeyDown}
        onBlur={close}
      >
        <SettingWords
          name={name}
          setting={setting}
          labelId={`${id}-label`}
          known={offer?.known}
        />
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
                {offer === undefined ? null : row === byDefault ? (
                  <span
                    className="mac-caption conversation-setting-default"
                    data-default="true"
                    title={`New sessions start on this: ${sourceSentence(offer.known)}`}
                  >
                    Default
                  </span>
                ) : (
                  <span
                    role="button"
                    aria-label={`Make ${row.label} the default for new sessions`}
                    aria-disabled={notSavable(row) !== undefined || undefined}
                    className="mac-caption conversation-setting-default"
                    data-make-default="true"
                    title={
                      notSavable(row) ??
                      [
                        "Make this the default for new sessions, in ~/.claude/settings.json. This session is not changed. (⌥↩)",
                        shadowedBy(offer.known),
                      ]
                        .filter((each) => each !== undefined)
                        .join(" — ")
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      makeDefault(row);
                    }}
                  >
                    Make default
                  </span>
                )}
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
  const { cliDefaults, setCliDefault, reportFailure } =
    useConversationActions();
  const model = modelName(session);
  const [defaults, setDefaults] = useState<CliDefaults | undefined>(undefined);
  /** Counts the defaults' changes here, so a change is read back. */
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    let current = true;
    cliDefaults(model).then(
      (read) => {
        if (current) setDefaults(read);
      },
      // Defaults that can't be read are not offered; the session's own
      // settings work as they did.
      () => {
        if (current) setDefaults(undefined);
      },
    );
    return () => {
      current = false;
    };
  }, [cliDefaults, model, changes]);
  const offer = (name: SettingName): DefaultOffer | undefined => {
    if (!hasDefault(name) || defaults === undefined) return undefined;
    return {
      known: defaults[name],
      set: (id) => {
        setCliDefault(name, id, name === "effort" ? model : undefined).then(
          () => setChanges((count) => count + 1),
          reportFailure,
        );
      },
    };
  };
  return (
    <div className="conversation-settings">
      {SETTING_NAMES.filter((name) => shown(name, session)).map((name) => (
        <SettingPicker
          key={name}
          name={name}
          setting={session[name]}
          disabled={disabled}
          pickerRef={pickers[name]}
          offer={offer(name)}
        />
      ))}
    </div>
  );
}
