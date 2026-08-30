/**
 * The form pieces every Settings section is built from.
 *
 * One shape, used everywhere: a group is a titled box, a row is a right-aligned
 * label and a control, and a control that is not whole until it is committed
 * says so under itself rather than beside it. Sections choose words and values;
 * they never choose a layout.
 *
 * Nothing here knows about the config. That is deliberate — the rules a value
 * has to satisfy live with the config (`model/config.ts`), and a section passes
 * the relevant one in as `validate`, so the window and the loader cannot come
 * to disagree about what is acceptable.
 */

import { useState, type ReactNode } from "react";

// ------------------------------------------------------------------ groups

/**
 * A box of rows under a heading.
 *
 * `note` is what the whole group needs said once — the sentence that would
 * otherwise be repeated under every row in it.
 */
export function Group({
  heading,
  note,
  children,
}: {
  readonly heading?: string;
  readonly note?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="sf-group">
      {heading ? <h2 className="sf-group-heading">{heading}</h2> : null}
      <div className="sf-box">{children}</div>
      {note ? <p className="sf-group-note mac-caption">{note}</p> : null}
    </section>
  );
}

/**
 * A label and its control.
 *
 * The label column is shared by every row in the window and right-aligned
 * against it, which is what makes a stack of unrelated controls read as one
 * form. A row with no label keeps the column, so its control still starts on
 * the same vertical line as every other control.
 */
export function Row({
  label,
  help,
  children,
}: {
  readonly label?: string;
  readonly help?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="sf-row">
      <span className="sf-label">{label}</span>
      <div className="sf-value">{children}</div>
      {help ? <p className="sf-help mac-caption">{help}</p> : null}
    </div>
  );
}

/** A row whose control spans both columns: a list, an editor, a button bar. */
export function WideRow({ children }: { readonly children: ReactNode }) {
  return <div className="sf-row sf-row-wide">{children}</div>;
}

// ---------------------------------------------------------------- controls

export function SwitchRow({
  label,
  help,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly help?: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <Row label={label} help={help}>
      <input
        type="checkbox"
        className="mac-switch"
        aria-label={label}
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
    </Row>
  );
}

/** A popup button over a fixed set of choices. */
export function Popup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly (readonly [T, string])[];
  readonly onChange: (next: T) => void;
}) {
  return (
    <select
      className="mac-popup"
      aria-label={label}
      value={value}
      onChange={(event) => {
        onChange(event.target.value as T);
      }}
    >
      {options.map(([option, text]) => (
        <option key={option} value={option}>
          {text}
        </option>
      ))}
    </select>
  );
}

/**
 * A text field that is applied when it is committed, not while it is typed.
 *
 * Every other control in this window carries a value that is already whole the
 * moment it changes — a checkbox, a popup. A text field does not: between
 * "SF Mono" and "Menlo" the field passes through the empty string, and through
 * "M", and none of those are what the person is asking for. Applying each of
 * them as if it were the final answer means the empty one comes back refused,
 * about a value nobody chose, while the word being typed is still on screen —
 * which is exactly what "changing the font is broken" looks like.
 *
 * So the field holds its own text until it is committed with Return or by
 * moving away, says so while it is holding it, and puts back what is in effect
 * on Escape. `validate` is the same rule the config loader applies, asked here
 * only so the answer arrives before the round trip rather than instead of it —
 * a value that gets past this still has to get past the loader.
 *
 * Every free-text field in this window is one of these. An identifier and a
 * socket name are half-typed on the way to being typed exactly as a font family
 * is, and a window where one field waits and the next does not is a window
 * whose behaviour cannot be guessed.
 */
export function TextField({
  label,
  value,
  placeholder,
  mono,
  narrow,
  autoFocus,
  validate,
  onCommit,
  onAbandon,
  trailing,
}: {
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly mono?: boolean;
  /** A field whose values are short — a number, a depth — is sized for them. */
  readonly narrow?: boolean;
  readonly autoFocus?: boolean;
  readonly validate?: (next: string) => string | undefined;
  readonly onCommit: (next: string) => void;
  /**
   * The field was left with the value it already had, or Escape was pressed.
   *
   * A field that stands for a value already in the config has nothing to do
   * here, and passes nothing. A field that stands for an entry that does not
   * exist yet — the blank row under a list — uses it to go away, which is what
   * keeps "Add" from writing an empty entry into `config.toml` and having it
   * refused before anybody has typed anything.
   */
  readonly onAbandon?: () => void;
  /** What sits on the field's trailing edge: a unit, a resolved value. */
  readonly trailing?: ReactNode;
}) {
  const [pending, setPending] = useState<string>();
  const text = pending ?? value;
  const problem = pending === undefined ? undefined : validate?.(pending);
  const uncommitted = pending !== undefined && pending !== value;

  const commit = () => {
    if (pending === undefined) {
      onAbandon?.();
      return;
    }
    if (validate?.(pending) !== undefined) return;
    setPending(undefined);
    if (pending !== value) onCommit(pending);
    else onAbandon?.();
  };

  return (
    <div className={`sf-stack${narrow ? " is-narrow" : ""}`}>
      <div className="sf-line">
        <input
          className={`mac-field${narrow ? " sf-narrow" : " sf-grow"}${mono ? " sf-mono-field" : ""}`}
          // The blank row under a list is put there by a click on Add, so the
          // caret belongs in it — otherwise Add produces a row and no way of
          // knowing it wants typing.
          autoFocus={autoFocus}
          aria-label={label}
          aria-invalid={problem !== undefined}
          placeholder={placeholder}
          value={text}
          onChange={(event) => {
            setPending(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setPending(undefined);
              onAbandon?.();
            }
          }}
        />
        {trailing}
      </div>
      {problem !== undefined ? (
        <p className="sf-note mac-caption" role="alert">
          {problem}
        </p>
      ) : uncommitted ? (
        <p className="sf-note mac-caption" role="status">
          Not applied yet — press Return.
        </p>
      ) : null}
    </div>
  );
}

/**
 * A number, typed rather than stepped.
 *
 * It is a `TextField` because a number is typed the same way a word is: 13 is
 * "1" and then "3", and a control that applied each digit would ask DevHub to
 * accept a font size of 1. The range is stated in the refusal, so a value out
 * of bounds says what the bounds are instead of only that it was wrong.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  unit,
  onCommit,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly unit?: string;
  readonly onCommit: (next: number) => void;
}) {
  const range = `${label} is a number between ${String(min)} and ${String(max)}.`;
  return (
    <TextField
      label={label}
      value={String(value)}
      narrow
      validate={(next) => {
        const parsed = Number(next.trim());
        if (next.trim().length === 0 || !Number.isFinite(parsed)) return range;
        return parsed < min || parsed > max ? range : undefined;
      }}
      onCommit={(next) => {
        onCommit(Number(next.trim()));
      }}
      trailing={unit ? <span className="mac-caption">{unit}</span> : undefined}
    />
  );
}

/**
 * A list of strings a person can add to, reorder and remove.
 *
 * Order is meaning here — these are command arguments — so the list is ordered
 * and the rows carry the controls that reorder it. Each entry is a committed
 * field for the same reason every other free-text field is.
 */
export function TokenList({
  label,
  addLabel,
  values,
  placeholder,
  validate,
  onChange,
}: {
  readonly label: string;
  /** What the button under the list says, in the words of the thing added. */
  readonly addLabel: string;
  readonly values: readonly string[];
  readonly placeholder?: string;
  readonly validate?: (next: string) => string | undefined;
  readonly onChange: (values: string[]) => void;
}) {
  // The blank row is a row, not a value: `Add` used to append "" to the list,
  // which is a save DevHub refuses — an empty exclusion, an empty argument —
  // arriving before anybody has typed a character. The row exists on screen
  // until it is committed, and joins the list only then.
  const [adding, setAdding] = useState(false);

  return (
    <div className="sf-tokens" aria-label={label}>
      {values.map((value, index) => (
        // Two identical arguments are two arguments: position is the identity.
        <div className="sf-token" key={index}>
          <TextField
            label={`${label} ${String(index + 1)}`}
            value={value}
            placeholder={placeholder}
            validate={validate}
            onCommit={(next) => {
              onChange(
                values.map((item, position) =>
                  position === index ? next : item,
                ),
              );
            }}
          />
          <button
            type="button"
            className="mac-icon-button"
            aria-label={`Move ${label} ${String(index + 1)} up`}
            disabled={index === 0}
            onClick={() => {
              const next = [...values];
              [next[index - 1], next[index]] = [next[index], next[index - 1]];
              onChange(next);
            }}
          >
            <ChevronUpGlyph />
          </button>
          <button
            type="button"
            className="mac-icon-button"
            aria-label={`Remove ${label} ${String(index + 1)}`}
            onClick={() => {
              onChange(values.filter((_, position) => position !== index));
            }}
          >
            <MinusGlyph />
          </button>
        </div>
      ))}
      {values.length === 0 && !adding ? (
        <p className="sf-note mac-caption">None.</p>
      ) : null}
      {adding ? (
        <div className="sf-token">
          <TextField
            label={`New ${label.toLowerCase()}`}
            value=""
            autoFocus
            placeholder={placeholder}
            validate={validate}
            onCommit={(next) => {
              setAdding(false);
              onChange([...values, next]);
            }}
            onAbandon={() => {
              setAdding(false);
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          className="mac-button plain sf-token-add"
          onClick={() => {
            setAdding(true);
          }}
        >
          {addLabel}
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ glyphs

export function ChevronUpGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className="sf-glyph"
    >
      <path d="M4.5 9.75 8 6.25l3.5 3.5" />
    </svg>
  );
}

export function MinusGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className="sf-glyph"
    >
      <path d="M4 8h8" />
    </svg>
  );
}

export function PlusGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className="sf-glyph"
    >
      <path d="M8 4v8M4 8h8" />
    </svg>
  );
}
