/**
 * An escalation's brief: what makes one judgeable by somebody who sees it
 * for the first time — the person, who reads the board and not the
 * orchestrator's chat.
 *
 * The body is free Markdown with a few named sections
 * (`docs/orchestrator.md`, "Writing an escalation"). Two of them are
 * required of every escalation — each is one question, read cold — and the command line refuses one without them
 * (`tell/service.ts`), so the rule is kept rather than only stated:
 *
 * - **決めてほしいこと** — the one decision or confirmation asked for, and
 *   its options. The board's card shows its first line.
 * - **人に聞く理由** — why the orchestrator does not decide it itself:
 *   what about it cannot be undone, is destructive or reaches others, or why
 *   it is the person's own. A choice that can be corrected later is the
 *   orchestrator's to make (the charter's 7), so an empty or generic reason
 *   (「念のため」, 「判断が必要」) is refused too (`genericReason`).
 *
 * Its reader may know nothing of the task, its history or where it stands,
 * and answers from it alone: the background restated, the options with
 * what each leads to, the recommendation. What the command line cannot
 * tell for sure it warns of and lets through (`briefWarnings`): no
 * 背景 or 推奨 section, and words that point outside the brief
 * (前回, 先ほど, 上記のタスク, as discussed) as if the reader had been there.
 *
 * A **review** (`escalation new --review`, known only here, never stored:
 * the escalation is an ordinary question, 「この成果物で完了としてよいか」)
 * asks the person to look at a deliverable before its task is done. Its
 * reason may simply name the review (成果物のレビュー), and it is warned of
 * when it carries no evidence: no `--attach`, no picture or code block in
 * the body, no 実行結果 section (`REVIEW_EVIDENCE_HEADINGS`).
 *
 * And nothing is referred to by number alone: a `#12`, `PR 1234` or
 * `Issue 56` in the body needs its URL there or in `--link`, and the title
 * names what is decided in words, never by number.
 *
 * Pure: no DOM, no Node. Read by the command line (to refuse) and the board
 * (to show the decision on the card).
 */

/** The decision's heading, and what else is read as it. */
export const DECISION_HEADINGS: readonly string[] = [
  "決めてほしいこと",
  "確認してほしいこと",
  "判断してほしいこと",
  "Decision needed",
];

/** Why the orchestrator holds it: the heading, and what else is read as it. */
export const REASON_HEADINGS: readonly string[] = [
  "人に聞く理由",
  "自分で決めない理由",
  "Why I'm asking",
];

/** The background's heading, and what else is read as it. */
export const BACKGROUND_HEADINGS: readonly string[] = ["背景", "Background"];

/** The recommendation's heading, and what else is read as it. */
export const RECOMMENDATION_HEADINGS: readonly string[] = [
  "推奨",
  "おすすめ",
  "Recommendation",
];

/** A review's evidence: a section of results, under one of these. */
export const REVIEW_EVIDENCE_HEADINGS: readonly string[] = [
  "実行結果",
  "テスト結果",
  "出力",
  "動作確認",
  "Evidence",
  "Results",
];

/** The options a review gets when it is given none. */
export const REVIEW_OPTIONS: readonly string[] = ["完了", "直してほしい"];

/** A reason that names the review: what a review's 人に聞く理由 may say. */
const NAMES_REVIEW = /レビュー|成果物|review|deliverable/iu;

/**
 * Words that point at something outside the brief — an earlier question,
 * the task's state, a talk — as if its reader had been there. 上記 alone is
 * left alone: 「上記の案 A」 points inside.
 */
const OUTSIDE_REFERENCES =
  /前回|先ほど|先程|さっき|例の件|上記の?(?:タスク|件|エスカレーション|質問)|(?:以前|前|過去)の(?:質問|エスカレーション|回答)|この前の|\bas (?:discussed|mentioned) (?:before|earlier|previously)\b|\b(?:previous|earlier|last) (?:escalation|question)\b/giu;

/**
 * Reasons that name nothing: what is left of the section, its punctuation,
 * list marks and polite endings taken off, being one of these (or almost
 * nothing) says why the person is asked no better than no section does.
 */
const GENERIC_REASONS: readonly string[] = [
  "念のため",
  "念のため確認",
  "確認のため",
  "確認したい",
  "確認してほしい",
  "判断が必要",
  "人の判断が必要",
  "人に決めてほしい",
  "決めてほしい",
  "決められない",
  "自分では決められない",
  "自分で決められない",
  "わからない",
  "分からない",
  "不明",
  "迷った",
  "迷っている",
  "重要",
  "大事",
  "なし",
  "特になし",
  "justincase",
  "tobesafe",
  "important",
  "notsure",
  "none",
  "na",
  "tbd",
];

/** The text with fences, inline code and math blanked, offsets kept. */
function withoutCode(markdown: string): string {
  const blank = (match: string) => match.replace(/[^\n]/gu, " ");
  return markdown
    .replace(
      /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gmu,
      blank,
    )
    .replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu, blank)
    .replace(/\$\$[\s\S]*?\$\$/gu, blank);
}

function normalized(heading: string): string {
  return heading
    .replace(/[*_`]/gu, "")
    .replace(/[\s:：]+$/u, "")
    .trim()
    .toLowerCase();
}

/**
 * The text under the first heading that starts with one of `names` (any
 * level), up to the next heading of the same level or above; `undefined`
 * when there is no such heading. Headings inside code do not count.
 */
export function sectionText(
  markdown: string,
  names: readonly string[],
): string | undefined {
  const lines = markdown.split("\n");
  const plain = withoutCode(markdown).split("\n");
  const wanted = names.map(normalized);
  for (let index = 0; index < plain.length; index += 1) {
    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(plain[index]!);
    if (heading === null) continue;
    const title = normalized(heading[2]!);
    if (!wanted.some((name) => title.startsWith(name))) continue;
    const level = heading[1]!.length;
    const body: string[] = [];
    for (let next = index + 1; next < plain.length; next += 1) {
      const deeper = /^ {0,3}(#{1,6})\s/u.exec(plain[next]!);
      if (deeper !== null && deeper[1]!.length <= level) break;
      body.push(lines[next]!);
    }
    return body.join("\n").trim();
  }
  return undefined;
}

/** The decision asked for, its first line of prose: what the card shows. */
export function decisionOf(markdown: string): string | undefined {
  const section = sectionText(markdown, DECISION_HEADINGS);
  if (section === undefined) return undefined;
  const line = withoutCode(section)
    .split("\n")
    .map((one) => one.replace(/^\s*(?:[-*>]|\d+\.)\s+/u, "").trim())
    .find((one) => one.length > 0 && !one.startsWith("|"));
  return line === undefined ? undefined : line.replace(/[*_`]/gu, "");
}

/**
 * Whether a 人に聞く理由 says nothing about why the person is asked: empty,
 * a few characters, or a stock phrase (`GENERIC_REASONS`).
 */
export function genericReason(reason: string): boolean {
  const core = reason
    .replace(/^\s*(?:[-*>]|\d+\.)\s+/gmu, "")
    .replace(/[*_`~]/gu, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
  const plain = core.replace(
    /(?:です|でした|ので|から|だから|します|しました|だ)+$/u,
    "",
  );
  return (
    [...plain].length < 4 ||
    GENERIC_REASONS.includes(core) ||
    GENERIC_REASONS.includes(plain)
  );
}

/** A reference by number: `#12`, `PR 1234`, `PR #1234`, `Issue 56`. */
interface NumberReference {
  readonly text: string;
  readonly number: string;
  /** `#12` alone may be a task, an escalation, a PR or an Issue. */
  readonly hashOnly: boolean;
}

function numberReferences(text: string): NumberReference[] {
  const plain = withoutCode(text)
    // A URL or a link's target is a full reference, not a bare one.
    .replace(/\]\([^)\s]*\)/gu, "]")
    .replace(/<?\b(?:https?|devhub):[^\s>)]+>?/gu, " ")
    .replace(/&#\d+;/gu, " ");
  const found: NumberReference[] = [];
  for (const match of plain.matchAll(
    /\b(PR|Pull Request|pull request|Issue|issue|プルリク(?:エスト)?)\s*#?\s*(\d+)\b|(?<![\w/&#])#(\d+)\b/gu,
  )) {
    found.push(
      match[3] === undefined
        ? { text: match[0].trim(), number: match[2]!, hashOnly: false }
        : { text: match[0], number: match[3], hashOnly: true },
    );
  }
  return found;
}

/**
 * The references by number in `text` that nothing in `urls` (the links,
 * and the URLs the body itself carries) points at: each needs its full URL.
 */
export function bareReferences(
  text: string,
  urls: readonly string[],
): readonly string[] {
  const bare = numberReferences(text).filter(({ number, hashOnly }) => {
    const github = new RegExp(`/(?:pull|issues)/${number}(?!\\d)`, "u");
    const escalation = new RegExp(
      `^devhub:(?:escalation|task)/${number}$`,
      "u",
    );
    return !urls.some(
      (url) => github.test(url) || (hashOnly && escalation.test(url)),
    );
  });
  return [...new Set(bare.map((one) => one.text))];
}

/** The URLs a body carries: raw, in `<…>`, or as a link's target. */
export function urlsIn(markdown: string): readonly string[] {
  return [...markdown.matchAll(/\b(?:https?|devhub):[^\s<>)\]]+/gu)].map(
    (match) => match[0],
  );
}

/** What a 人に聞く理由 must name, said in every refusal about it. */
const REASON_HINT =
  "name what about this cannot be undone, destroys or reaches others (deleting data or a branch, a force-push or rewritten history, a merge or release others get, a message sent to someone, money spent), or why it is the person's own (only they know it, only they may). A choice that can be corrected later (a design, an implementation, a name, the order of work) is yours: decide it on the person's past decisions, note it in the task's memo, and show the result in the review that ends the task (--review; its reason may just say 成果物のレビュー).";

/**
 * What may keep the escalation from standing on its own and the command
 * line cannot tell for sure: said after it is raised, not refused.
 */
export function briefWarnings(request: BriefRequest): readonly string[] {
  const warnings: string[] = [];
  if (sectionText(request.body, BACKGROUND_HEADINGS) === undefined)
    warnings.push(
      "no '## 背景' section: the person may know nothing of this task, its history or where it stands. Restate what is needed to decide in the escalation itself.",
    );
  if (sectionText(request.body, RECOMMENDATION_HEADINGS) === undefined)
    warnings.push(
      "no '## 推奨' section: say which option you recommend, and why.",
    );
  const outside = [
    ...new Set(
      [
        ...withoutCode(`${request.title ?? ""}\n${request.body}`).matchAll(
          OUTSIDE_REFERENCES,
        ),
      ].map((match) => match[0]),
    ),
  ];
  if (outside.length > 0)
    warnings.push(
      `${outside.map((one) => `「${one}」`).join(", ")} points outside this escalation: the person sees it alone, with no earlier question or task state. Say here what it was (escalation new again, or withdraw this one, to fix it).`,
    );
  if (request.review === true && !hasEvidence(request))
    warnings.push(
      "a review with no evidence: attach screenshots (--attach), or show what was run and what it printed (a ``` block, or a '## 実行結果' section: test results, output excerpts), so the person can judge the deliverable from here alone.",
    );
  return warnings;
}

/** Whether a review shows what was made: a picture, code or results. */
function hasEvidence(request: BriefRequest): boolean {
  return (
    (request.attachments ?? 0) > 0 ||
    /^ {0,3}(?:`{3,}|~{3,})/mu.test(request.body) ||
    /!\[[^\]]*\]\([^)]+\)/u.test(withoutCode(request.body)) ||
    sectionText(request.body, REVIEW_EVIDENCE_HEADINGS) !== undefined
  );
}

export interface BriefRequest {
  readonly title?: string;
  readonly body: string;
  readonly links: readonly string[];
  /** `--review`: the person is asked to review a deliverable. */
  readonly review?: boolean;
  /** How many pictures `--attach` gives. */
  readonly attachments?: number;
}

/**
 * What keeps the escalation from standing on its own, each said with how
 * to fix it; empty when nothing does.
 */
export function briefProblems(request: BriefRequest): readonly string[] {
  const problems: string[] = [];
  if (request.title !== undefined) {
    const numbered = numberReferences(request.title);
    if (numbered.length > 0)
      problems.push(
        `the title refers to ${numbered.map((one) => one.text).join(", ")} by number. Say in words what is to be decided, for someone who has never heard of it (not 「PR 1234 をマージしてよいか」 but 「決済リトライのタイムアウト延長 (30s→60s) をマージしてよいか」); the PR or Issue goes in --link.`,
      );
  }
  if (sectionText(request.body, DECISION_HEADINGS) === undefined)
    problems.push(
      "the body has no '## 決めてほしいこと' section: the one decision or confirmation asked of the person, as a question, with its options.",
    );
  const reason = sectionText(request.body, REASON_HEADINGS);
  if (reason === undefined)
    problems.push(`the body has no '## 人に聞く理由' section: ${REASON_HINT}`);
  else if (
    genericReason(reason) &&
    !(request.review === true && NAMES_REVIEW.test(reason))
  )
    problems.push(
      `the '## 人に聞く理由' section says nothing about why the person is asked (${JSON.stringify(reason.slice(0, 60))}): ${REASON_HINT}`,
    );
  const bare = bareReferences(request.body, [
    ...request.links,
    ...urlsIn(request.body),
  ]);
  if (bare.length > 0)
    problems.push(
      `the body refers to ${bare.join(", ")} by number alone. Give each its full URL (--link, or [what it is](https://github.com/…/pull/1234) in the body) and say in a line what it is.`,
    );
  return problems;
}
