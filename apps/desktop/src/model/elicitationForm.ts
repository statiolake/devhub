/**
 * The form of an MCP elicitation: what a server asks the person to fill in
 * before it goes on, as fields the card draws and the adapter reads back.
 *
 * MCP restricts an elicitation's `requestedSchema` to a flat object of
 * primitive properties — text, a number, a yes/no, a choice of one or of
 * several — so a field is one of those four. A schema with no properties is a
 * plain confirmation: a form of no fields, accepted with nothing in it.
 *
 * The card holds what is typed as the strings its controls give
 * (`FormValues`); `formContent` is the one reading of them, used by the card
 * to say what is wrong before it sends and by the adapter to build the reply.
 */

import type { JsonValue } from "./conversation.js";

export interface FormField {
  /** The property's name: the key its value is sent under. */
  readonly key: string;
  /** The schema's title, else the key. */
  readonly label: string;
  readonly description: string | undefined;
  readonly required: boolean;
  readonly input: FormInput;
}

export type FormInput =
  | {
      readonly kind: "text";
      readonly format: "email" | "uri" | "date" | "date-time" | undefined;
      readonly minLength: number | undefined;
      readonly maxLength: number | undefined;
      readonly default: string | undefined;
    }
  | {
      readonly kind: "number";
      readonly integer: boolean;
      readonly minimum: number | undefined;
      readonly maximum: number | undefined;
      readonly default: number | undefined;
    }
  | { readonly kind: "boolean"; readonly default: boolean | undefined }
  | {
      readonly kind: "choice";
      /** Several may be chosen (an array property), else one. */
      readonly multiple: boolean;
      readonly options: readonly FormOption[];
      readonly minItems: number | undefined;
      readonly maxItems: number | undefined;
      /** The values chosen to begin with. */
      readonly default: readonly string[];
    };

export interface FormOption {
  /** What is sent. */
  readonly value: string;
  /** How it reads: its title, else the value. */
  readonly label: string;
}

/**
 * What the card's controls hold, by field key: a text or number field's
 * words, a yes/no as `"true"` or `"false"`, a single choice's value (`""`
 * for none), a multiple choice's values.
 */
export type FormValues = Readonly<Record<string, string | readonly string[]>>;

/** The controls' values before the person touches them: the schema's defaults. */
export function initialValues(fields: readonly FormField[]): FormValues {
  const values: Record<string, string | readonly string[]> = {};
  for (const { key, input } of fields) {
    switch (input.kind) {
      case "text":
        values[key] = input.default ?? "";
        break;
      case "number":
        values[key] = input.default === undefined ? "" : String(input.default);
        break;
      case "boolean":
        values[key] = String(input.default ?? false);
        break;
      case "choice":
        values[key] = input.multiple ? input.default : (input.default[0] ?? "");
        break;
    }
  }
  return values;
}

/**
 * The reply's `content` from what is filled in, and what is wrong with it by
 * field key — empty when it can be sent. A field left empty is left out of
 * the content, and is a problem only when it is required.
 *
 * A value no control of the field could hold (a word for a yes/no, a choice
 * not offered) is not the person's mistake but the caller's, and throws.
 */
export function formContent(
  fields: readonly FormField[],
  values: FormValues,
): {
  readonly content: { readonly [key: string]: JsonValue };
  readonly problems: Readonly<Record<string, string>>;
} {
  const content: Record<string, JsonValue> = {};
  const problems: Record<string, string> = {};
  for (const field of fields) {
    const read = readField(field, values[field.key]);
    if (read.problem !== undefined) problems[field.key] = read.problem;
    else if (read.value !== undefined) content[field.key] = read.value;
  }
  return { content, problems };
}

type Read =
  | { readonly value: JsonValue | undefined; readonly problem?: undefined }
  | { readonly value?: undefined; readonly problem: string };

function readField(
  field: FormField,
  raw: string | readonly string[] | undefined,
): Read {
  const { input } = field;
  if (input.kind === "choice" && input.multiple) {
    if (!Array.isArray(raw))
      throw new Error(
        `field ${field.key} takes a list of choices, got ${JSON.stringify(raw)}`,
      );
    const chosen = raw as readonly string[];
    for (const value of chosen) offered(field, input.options, value);
    if (chosen.length === 0)
      return field.required ? { problem: "Required" } : { value: undefined };
    if (input.minItems !== undefined && chosen.length < input.minItems)
      return { problem: `Choose at least ${input.minItems}` };
    if (input.maxItems !== undefined && chosen.length > input.maxItems)
      return { problem: `Choose at most ${input.maxItems}` };
    return { value: [...chosen] };
  }
  if (typeof raw !== "string")
    throw new Error(
      `field ${field.key} takes one value, got ${JSON.stringify(raw)}`,
    );
  if (input.kind === "boolean") {
    if (raw !== "true" && raw !== "false")
      throw new Error(
        `field ${field.key} is a yes/no, got ${JSON.stringify(raw)}`,
      );
    return { value: raw === "true" };
  }
  const text = input.kind === "text" ? raw : raw.trim();
  if (text === "")
    return field.required ? { problem: "Required" } : { value: undefined };
  switch (input.kind) {
    case "text":
      if (input.minLength !== undefined && text.length < input.minLength)
        return { problem: `At least ${input.minLength} characters` };
      if (input.maxLength !== undefined && text.length > input.maxLength)
        return { problem: `At most ${input.maxLength} characters` };
      return { value: text };
    case "number": {
      const number = Number(text);
      if (!Number.isFinite(number)) return { problem: "Not a number" };
      if (input.integer && !Number.isInteger(number))
        return { problem: "A whole number" };
      if (input.minimum !== undefined && number < input.minimum)
        return { problem: `At least ${input.minimum}` };
      if (input.maximum !== undefined && number > input.maximum)
        return { problem: `At most ${input.maximum}` };
      return { value: number };
    }
    case "choice":
      offered(field, input.options, text);
      return { value: text };
  }
}

function offered(
  field: FormField,
  options: readonly FormOption[],
  value: string,
): void {
  if (!options.some((option) => option.value === value))
    throw new Error(
      `field ${field.key} offers no choice ${JSON.stringify(value)}`,
    );
}
