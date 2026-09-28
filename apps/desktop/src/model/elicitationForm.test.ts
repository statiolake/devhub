import { describe, expect, it } from "vitest";
import { formContent, initialValues, type FormField } from "./elicitationForm.js";

function field(
  key: string,
  input: FormField["input"],
  required = false,
): FormField {
  return { key, label: key, description: undefined, required, input };
}

const NAME = field(
  "name",
  {
    kind: "text",
    format: undefined,
    minLength: 2,
    maxLength: 5,
    default: undefined,
  },
  true,
);
const AGE = field("age", {
  kind: "number",
  integer: true,
  minimum: 0,
  maximum: 150,
  default: undefined,
});
const TAGS = field("tags", {
  kind: "choice",
  multiple: true,
  options: [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ],
  minItems: undefined,
  maxItems: 1,
  default: [],
});

describe("formContent", () => {
  it("has nothing to send and nothing wrong for a form of no fields", () => {
    expect(formContent([], {})).toEqual({ content: {}, problems: {} });
  });

  it("says a required field left empty is required, and leaves an optional one out", () => {
    expect(formContent([NAME, AGE], { name: "", age: "" })).toEqual({
      content: {},
      problems: { name: "Required" },
    });
  });

  it("holds the values to the schema's bounds", () => {
    expect(
      formContent([NAME, AGE, TAGS], {
        name: "a",
        age: "2.5",
        tags: ["a", "b"],
      }).problems,
    ).toEqual({
      name: "At least 2 characters",
      age: "A whole number",
      tags: "Choose at most 1",
    });
    expect(formContent([AGE], { age: "151" }).problems).toEqual({
      age: "At most 150",
    });
  });

  it("types each value as its field says", () => {
    const urgent = field("urgent", { kind: "boolean", default: undefined });
    expect(
      formContent([NAME, AGE, TAGS, urgent], {
        name: "Ann",
        age: " 42 ",
        tags: ["b"],
        urgent: "false",
      }),
    ).toEqual({
      content: { name: "Ann", age: 42, tags: ["b"], urgent: false },
      problems: {},
    });
  });

  it("throws on a value no control of the field could hold", () => {
    expect(() => formContent([TAGS], { tags: ["c"] })).toThrow(
      /offers no choice "c"/,
    );
    expect(() =>
      formContent([field("ok", { kind: "boolean", default: undefined })], {
        ok: "yes",
      }),
    ).toThrow(/yes\/no/);
  });
});

describe("initialValues", () => {
  it("starts each control at the schema's default", () => {
    expect(
      initialValues([
        NAME,
        field("n", {
          kind: "number",
          integer: false,
          minimum: undefined,
          maximum: undefined,
          default: 1.5,
        }),
        field("b", { kind: "boolean", default: true }),
        TAGS,
      ]),
    ).toEqual({ name: "", n: "1.5", b: "true", tags: [] });
  });
});
