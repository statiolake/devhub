import { describe, expect, it } from "vitest";
import {
  bareReferences,
  briefProblems,
  decisionOf,
  sectionText,
  urlsIn,
} from "./escalationBrief.js";

const BODY = `## 背景
決済のリトライが 30 秒で切れている。

## 決めてほしいこと
**タイムアウトを 60 秒に延ばす修正をマージしてよいか**

- 承認する
- 見送る

### 補足
細かい話。

## 人に聞く理由
本番の挙動が変わるので、決めるのは人。

\`\`\`md
## 決めてほしいこと (コードの中は数えない)
\`\`\`
`;

describe("an escalation's brief", () => {
  it("reads a section under its heading, up to the next one at its level", () => {
    expect(sectionText(BODY, ["決めてほしいこと"])).toBe(
      "**タイムアウトを 60 秒に延ばす修正をマージしてよいか**\n\n- 承認する\n- 見送る\n\n### 補足\n細かい話。",
    );
    expect(sectionText(BODY, ["Decision needed"])).toBeUndefined();
    expect(
      sectionText("```\n## 決めてほしいこと\nx\n```", ["決めてほしいこと"]),
    ).toBeUndefined();
    expect(
      sectionText("# Decision needed:\nShip it?", ["Decision needed"]),
    ).toBe("Ship it?");
  });

  it("shows the decision's first line, without emphasis", () => {
    expect(decisionOf(BODY)).toBe(
      "タイムアウトを 60 秒に延ばす修正をマージしてよいか",
    );
    expect(decisionOf("no sections")).toBeUndefined();
  });

  it("finds references by number that no URL points at", () => {
    const text =
      "PR 1234 と PR #55、Issue 7、#12、`#99`、[PR 8](https://github.com/a/b/pull/8)、https://x.test/#3";
    expect(bareReferences(text, urlsIn(text))).toEqual([
      "PR 1234",
      "PR #55",
      "Issue 7",
      "#12",
    ]);
    expect(
      bareReferences(text, [
        ...urlsIn(text),
        "https://github.com/a/b/pull/1234",
        "https://github.com/a/b/pull/55",
        "https://github.com/a/b/issues/7",
        "devhub:escalation/12",
      ]),
    ).toEqual([]);
    // An escalation's devhub: link answers for #12, never for PR 12.
    expect(bareReferences("PR 12", ["devhub:escalation/12"])).toEqual([
      "PR 12",
    ]);
  });

  it("says what keeps one from standing on its own", () => {
    expect(
      briefProblems({
        title: "ログインの修正を出すか",
        body: BODY,
        links: [],
      }),
    ).toEqual([]);
    const problems = briefProblems({
      title: "PR 1234 をマージしてよいか",
      body: "いいですか?",
      links: [],
    });
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/title refers to PR 1234/u);
    // A follow-up is a question of its own: both sections, again.
    expect(briefProblems({ body: "どう?", links: [] })).toHaveLength(2);
  });
});
