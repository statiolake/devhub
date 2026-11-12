import { describe, expect, it } from "vitest";
import {
  bareReferences,
  briefProblems,
  briefWarnings,
  decisionOf,
  genericReason,
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

  it("refuses a reason that names nothing, and says what it must name", () => {
    for (const reason of [
      "",
      "?",
      "念のため。",
      "- 念のためです",
      "**人の判断が必要**だから",
      "確認のため",
      "Just in case.",
      "TBD",
    ])
      expect({ reason, generic: genericReason(reason) }).toEqual({
        reason,
        generic: true,
      });
    for (const reason of [
      "本番の挙動が変わるので、決めるのは人。",
      "マージすると他の人のブランチに届き、簡単には戻せない。",
      "`git push --force` で履歴を書き換える",
      "Deletes the staging database.",
    ])
      expect({ reason, generic: genericReason(reason) }).toEqual({
        reason,
        generic: false,
      });
    const [problem] = briefProblems({
      body: "## 決めてほしいこと\nどうするか\n\n## 人に聞く理由\n念のため",
      links: [],
    });
    expect(problem).toMatch(/says nothing about why the person is asked/u);
    // The hint: what to name, and that a reversible choice is not asked.
    expect(problem).toMatch(/cannot be undone[\s\S]*corrected later/u);
    expect(
      briefProblems({ body: "## 決めてほしいこと\nどう?", links: [] })[0],
    ).toMatch(/no '## 人に聞く理由'[\s\S]*cannot be undone/u);
  });

  it("warns of what may lean on context the reader does not have", () => {
    // The full brief: nothing to warn of.
    expect(
      briefWarnings({
        body: `${BODY}\n## 推奨\n承認する。上記の案 A が安全。`,
        links: [],
      }),
    ).toEqual([]);
    const warnings = briefWarnings({
      title: "前回の件の続き",
      body: "## 決めてほしいこと\n上記タスクで話した案でよいか\n\n## 人に聞く理由\n本番に届く\n\n`前回` (コードの中は数えない)",
      links: [],
    });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/no '## 背景'/u);
    expect(warnings[1]).toMatch(/no '## 推奨'/u);
    expect(warnings[2]).toMatch(
      /^「前回」, 「上記タスク」 points outside this escalation/u,
    );
    expect(
      briefWarnings({
        body: "## 背景\nAs discussed earlier, x.\n## 推奨\ny",
        links: [],
      }),
    ).toEqual([expect.stringMatching(/「As discussed earlier」/u)]);
  });

  it("takes a review's reason that names the review, and warns of a review with no evidence", () => {
    const review = (reason: string, more = "") =>
      `## 背景\n検索画面を作った。\n\n## 決めてほしいこと\nこの成果物で完了としてよいか\n\n## 人に聞く理由\n${reason}\n\n## 推奨\n完了${more}`;
    // A reason that only names the review is enough for a review, not for a question.
    expect(
      briefProblems({ body: review("レビュー"), links: [], review: true }),
    ).toEqual([]);
    expect(
      briefProblems({
        body: review("確認してほしい"),
        links: [],
        review: true,
      }),
    ).toHaveLength(1);
    expect(
      briefProblems({
        body: review("成果物のレビューを確認してほしい"),
        links: [],
        review: true,
      }),
    ).toEqual([]);
    expect(briefProblems({ body: review("レビュー"), links: [] })).toEqual([]);
    expect(
      briefProblems({ body: review("確認のため"), links: [] }),
    ).toHaveLength(1);
    // No evidence: warned of, for a review only.
    const bare = { body: review("成果物のレビュー"), links: [] };
    expect(briefWarnings(bare)).toEqual([]);
    expect(briefWarnings({ ...bare, review: true })).toEqual([
      expect.stringMatching(/^a review with no evidence/u),
    ]);
    for (const evidence of [
      { attachments: 1 },
      { body: review("成果物のレビュー", "\n\n```text\n12 passed\n```") },
      { body: review("成果物のレビュー", "\n\n## 実行結果\n12 passed") },
      { body: review("成果物のレビュー", "\n\n![画面](out/shot.png)") },
    ])
      expect(briefWarnings({ ...bare, review: true, ...evidence })).toEqual([]);
  });
});
