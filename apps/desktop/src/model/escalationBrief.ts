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
 * - **人に聞く理由** — why the orchestrator does not decide it itself.
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

export interface BriefRequest {
  readonly title?: string;
  readonly body: string;
  readonly links: readonly string[];
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
  if (sectionText(request.body, REASON_HEADINGS) === undefined)
    problems.push(
      "the body has no '## 人に聞く理由' section: why you hold this for the person instead of deciding it yourself.",
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
