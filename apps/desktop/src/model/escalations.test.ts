import { describe, expect, it } from "vitest";
import {
  EscalationError,
  answerEscalation,
  createEscalation,
  escalationFrom,
  escalationState,
  isOpen,
  parseEscalationId,
  withdrawEscalation,
} from "./escalations.js";

const asked = () =>
  createEscalation(
    4,
    {
      taskId: 7,
      title: "本番DBマイグレーション承認",
      markdown: "## 決めてほしいこと\n流してよいか\n",
      options: ["承認する", "見送る"],
      links: ["https://github.com/acme/app/pull/9"],
      linkLabels: { "https://github.com/acme/app/pull/9": "移行の PR" },
    },
    100,
  );

describe("an escalation: one question, one answer", () => {
  it("is open until the person answers it, and closed by the answer", () => {
    const one = asked();
    expect(escalationState(one)).toBe("open");
    expect(one.question).toEqual({
      markdown: "## 決めてほしいこと\n流してよいか",
      at: 100,
      options: ["承認する", "見送る"],
    });
    const answered = answerEscalation(one, "承認する", 200);
    expect(escalationState(answered)).toBe("answered");
    expect(answered.answer).toEqual({
      markdown: "承認する",
      at: 200,
      option: "承認する",
    });
    expect(isOpen(answered)).toBe(false);
    // Free words are an answer too, and no option.
    expect(
      answerEscalation(one, "月曜なら", 200).answer?.option,
    ).toBeUndefined();
  });

  it("is never reopened: a second answer, or one to a withdrawn one, is refused", () => {
    const answered = answerEscalation(asked(), "はい", 200);
    expect(() => answerEscalation(answered, "もう一度", 300)).toThrow(
      /follow-up is a new escalation/u,
    );
    const withdrawn = withdrawEscalation(asked(), "要らなくなった", 150);
    expect(withdrawn.withdrawn).toEqual({ at: 150, note: "要らなくなった" });
    expect(escalationState(withdrawn)).toBe("withdrawn");
    expect(() => answerEscalation(withdrawn, "はい", 200)).toThrow(
      EscalationError,
    );
    expect(() => withdrawEscalation(withdrawn, undefined, 200)).toThrow(
      /withdrawn already/u,
    );
  });

  it("checks what it is given", () => {
    const make = (patch: object) =>
      createEscalation(
        1,
        { taskId: 1, title: "t", markdown: "b", ...patch },
        0,
      );
    expect(() => make({ title: " " })).toThrow(/needs a title/u);
    expect(() => make({ markdown: "  " })).toThrow(/empty/u);
    expect(() => make({ options: ["a", "a"] })).toThrow(/twice/u);
    expect(() => make({ links: ["ftp://x"] })).toThrow(/http\(s\) URL/u);
    expect(() =>
      make({ links: [], linkLabels: { "https://x.test/": "x" } }),
    ).toThrow(/not one of its links/u);
  });

  it("round-trips through the file, and refuses one that does not read", () => {
    const one = answerEscalation(asked(), "承認する", 200);
    expect(escalationFrom(JSON.parse(JSON.stringify(one)), "e")).toEqual(one);
    expect(() => escalationFrom({ ...one, taskId: 0 }, "e")).toThrow(
      /belongs to no task/u,
    );
    expect(() => escalationFrom({ ...one, question: undefined }, "e")).toThrow(
      /no question/u,
    );
  });

  it("reads #12, 12, E12 and esc=12 as ids", () => {
    for (const text of ["#12", "12", "E12", "esc=12"])
      expect(parseEscalationId(text)).toBe(12);
    expect(parseEscalationId("x12")).toBeUndefined();
    expect(parseEscalationId("0")).toBeUndefined();
  });
});
