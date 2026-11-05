/**
 * `/devhub-orchestrator`: the skill DevHub gives the orchestrator agent only —
 * how to interview the person and write *their* event handler skill
 * (`/make-progress`, or whatever they call it) into the orchestrator's root,
 * which `[orchestrator] event_prompt` then invokes for every event.
 *
 * DevHub supplies the mechanism and no rules (`docs/orchestrator.md`); this
 * skill is the briefing for writing the rules: what an event delivery
 * carries, what the lanes mean, how to escalate, how to keep things moving.
 * The skill it produces is the person's own file; this one is DevHub's and is
 * rewritten on every start, beside `/devhub` (`agent/devhubSkill.ts`):
 *
 * - Claude: a second `--add-dir=<root>` on the orchestrator agent's argv.
 * - Codex (GUI): one more paragraph in the thread's `developerInstructions`.
 *
 * DevHub's own charter (`orchestratorCharter.ts`) goes with it, by the same
 * doors: what the orchestrator is for, the router rule, the invariant and
 * DevHub's conventions are stated there, not here; this skill is the guide
 * to designing the person's make-progress.
 *
 * Ordinary agents get neither: the agent wiring asks the controller, per
 * agent, whether this is the orchestrator (`orchestratorSkill` in
 * `shell/agentWiring.ts`). `devhub --tell skill --orchestrator` prints it for
 * an orchestrator DevHub did not start (Claude Desktop).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile } from "../../model/domain.js";
import { devhubSkillPaths } from "../agent/devhubSkill.js";
import { ORCHESTRATOR_CHARTER } from "./orchestratorCharter.js";

export const ORCHESTRATOR_SKILL_NAME = "devhub-orchestrator";

export interface OrchestratorSkill {
	/** The directory handed to Claude's `--add-dir`. */
	readonly root: string;
	/** The SKILL.md itself, for Codex's instructions and the person to read. */
	readonly skillFile: string;
}

export function orchestratorSkillPaths(
	userDataPath: string,
): OrchestratorSkill {
	const root = join(userDataPath, "devhub", "orchestrator-skill");
	return {
		root,
		skillFile: join(
			root,
			".claude",
			"skills",
			ORCHESTRATOR_SKILL_NAME,
			"SKILL.md",
		),
	};
}

/** Write the skill. Called on every start: the launcher path in it moves with the app. */
export function writeOrchestratorSkill(
	skill: OrchestratorSkill,
	cli: string,
): void {
	mkdirSync(join(skill.root, ".claude", "skills", ORCHESTRATOR_SKILL_NAME), {
		recursive: true,
		mode: 0o700,
	});
	writeFileSync(skill.skillFile, orchestratorSkillText(cli), { mode: 0o600 });
}

/**
 * `devhub --tell skill --orchestrator`: the SKILL.md `writeOrchestratorSkill`
 * writes under `userDataPath`, the launcher it names, and where it is.
 */
export function orchestratorSkillAnswer(userDataPath: string): {
	readonly text: string;
	readonly cli: string;
	readonly skillFile: string;
} {
	const { cli } = devhubSkillPaths(userDataPath);
	const skill = orchestratorSkillPaths(userDataPath);
	return {
		text: orchestratorSkillText(cli),
		cli,
		skillFile: skill.skillFile,
	};
}

/**
 * Whether `agentId` is to be launched with the orchestrator's skill: it is
 * the agent the Orchestrator row is assigned to, or it is a new agent in the
 * workspace `orchestrator start` is making its agent in (`starting`, with the
 * agents that were there before) — launched before the row is assigned to it.
 * Every other agent is ordinary, and is not.
 */
export function isOrchestratorAgent(
	agentId: string,
	state: {
		readonly assigned: string | undefined;
		readonly starting:
			| { readonly workspaceId: string; readonly before: ReadonlySet<string> }
			| undefined;
		readonly agentsIn: (workspaceId: string) => readonly string[];
	},
): boolean {
	if (state.assigned === agentId) return true;
	const starting = state.starting;
	if (starting === undefined || starting.before.has(agentId)) return false;
	return state.agentsIn(starting.workspaceId).includes(agentId);
}

const APPEND_SYSTEM_PROMPT = "--append-system-prompt";

/**
 * The orchestrator's Claude argv: one more `--add-dir`, and DevHub's charter
 * (`ORCHESTRATOR_CHARTER`) appended to the system prompt — after the
 * profile's own `--append-system-prompt`, which Claude would otherwise drop
 * (it keeps only the last). Other kinds are left alone; idempotent.
 */
export function withOrchestratorSkill<
	T extends Pick<AgentProfile, "kind" | "args">,
>(profile: T, skill: OrchestratorSkill | undefined): T {
	if (skill === undefined || profile.kind !== "claude") return profile;
	const flag = `--add-dir=${skill.root}`;
	if (profile.args.includes(flag)) return profile;
	const kept: string[] = [];
	let appended: string | undefined;
	for (let at = 0; at < profile.args.length; at++) {
		const arg = profile.args[at] ?? "";
		if (arg === APPEND_SYSTEM_PROMPT && at + 1 < profile.args.length) {
			appended = profile.args[at + 1];
			at++;
		} else if (arg.startsWith(`${APPEND_SYSTEM_PROMPT}=`))
			appended = arg.slice(APPEND_SYSTEM_PROMPT.length + 1);
		else kept.push(arg);
	}
	return {
		...profile,
		args: [
			...kept,
			flag,
			APPEND_SYSTEM_PROMPT,
			[appended, ORCHESTRATOR_CHARTER]
				.filter((one) => one !== undefined && one.length > 0)
				.join("\n\n"),
		],
	};
}

export function codexOrchestratorInstructions(
	skill: OrchestratorSkill,
): string {
	return `${ORCHESTRATOR_CHARTER}\n\n${[
		`Orchestrator skill: you are DevHub's orchestrator. When the user's message starts with /${ORCHESTRATOR_SKILL_NAME} or $${ORCHESTRATOR_SKILL_NAME},`,
		"or asks to set up, write or change the orchestrator's event-handling skill (make-progress),",
		`read ${skill.skillFile} and follow it.`,
	].join(" ")}`;
}

export function orchestratorSkillText(cli: string): string {
	return `---
name: ${ORCHESTRATOR_SKILL_NAME}
description: DevHub のオーケストレーター専用。イベントごとに DevHub から呼ばれる「ユーザー自身のイベント処理スキル」(/make-progress など) を、ユーザーへのヒアリングを通じて設計・作成・改訂する。DevHub が渡すイベントの中身、ボードのレーン (要回答 / 対応中 / 待機中) の意味、エスカレーションの原則、使える CLI、ヒアリングの進め方をまとめてある (DevHub の憲章 — 役割、手を動かさないこと、ルーターの規則、不変条件、約束事 — は起動時に別に渡されている)。「make-progress を作って」「オーケストレーターのスキルを設定して」「イベントの扱いを変えたい」と言われたとき、または /${ORCHESTRATOR_SKILL_NAME} で使う。
---

# /${ORCHESTRATOR_SKILL_NAME} - make-progress を作るためのスキル

あなたは DevHub のオーケストレーター (Orchestrator 行のエージェント) です。
DevHub は**仕組み** (ボード、エスカレーション、イベント) と、起動時に渡す
**DevHub の憲章** (役割、手を動かさないこと、各行をサブエージェントに渡して戻るルーターの規則、
不変条件、DevHub の約束事) を提供します。それ以外の**チームのやり方**はユーザーのものです。
make-progress には憲章と同じことを書き直さず、チーム固有のこと (レーンの意味、レビューと完了、
自律の範囲、誰に何を頼むか) を書きます。それを書くのが、イベントごとに呼ばれる
ユーザー自身のスキル (以下 make-progress。名前はユーザーが決める) です。

このスキルの仕事は次の 3 つです。

1. ユーザーにヒアリングし、そのチームのやり方に合った make-progress を設計する。
2. それをオーケストレーターの root に書く (ユーザーの持ち物として、編集できる形で)。
3. \`event_prompt\` / \`init_prompt\` の設定行をユーザーに伝える。

CLI は \`"${cli}"\` です (以下 \`devhub\`。必ずこのフルパスをダブルクォートで)。
CLI 全般は /devhub スキルと \`devhub --tell help\` を参照。

## 1. どこに何を書くか

- root は \`devhub --tell orchestrator status\` (または \`[orchestrator] root\`、
  既定 \`~/orchestrator\`) で確認する。
- Claude: \`<root>/.claude/skills/<name>/SKILL.md\` (frontmatter の \`name\` と
  \`description\` を付ける)。
- Codex: 同じ SKILL.md を置き、\`<root>/AGENTS.md\` に (あれば追記で)
  「メッセージが /<name> か $<name> で始まったら
  .claude/skills/<name>/SKILL.md を読んで従う」と書く。
- 過去の判断の記録 (例 \`<root>/decisions.md\`) など、スキルが参照する
  ファイルも root に置く。
- **settings.toml は書かない** (ユーザーのファイル。dotfiles 管理のことも多い)。
  次の行を提示して、自分で入れてもらうか Settings ▸ General ▸ Orchestrator で
  設定してもらう:

      [orchestrator]
      event_prompt = "/make-progress {EVENT}"
      # init_prompt = "/make-progress {EVENT}"   # 省略時は event_prompt に init が入る
      # events = ["*", "!timer.*"]                # 受け取るイベントの絞り込み (既定は全部)
      # delivery_interval = "5m"                  # 束ねた配信の最短間隔 (人の言葉はすぐ)
      # reminder_interval = "1h"                  # 解消しない unsettled を言い直す間隔
      # [orchestrator.github]
      # projects = ["my-org/7"]                  # lane を読む Project (OWNER/NUMBER)。母集団は決めない
      # interval = "90s"                          # 基本間隔 (最短 30s。ここから遅くなるだけ)
      # [[orchestrator.timers]]
      # name = "sweep"
      # interval = "30m"

  \`{EVENT}\` はイベントの行 (下の形式)。\`{EVENT_JSON}\` は同じ内容の JSON 配列で、
  テンプレートに書いたときだけ作られる (スクリプト向けの逃げ道。普段は不要)。
  設定の反映は \`devhub --tell orchestrator restart\` で。

## 2. DevHub が make-progress に渡すもの

- **人の言葉はそのまま、すぐ届く。** エスカレーションへの回答 (\`escalation_answered\`) と、
  人がエスカレーションのエージェントに会話欄で直接送ったメッセージ (\`escalation.human_direct\`) は、
  待たずに (ターン中でも)、それぞれ **1 通のユーザーメッセージ** として届く。1 行目に
  DevHub がどのエスカレーションかを書き (\`esc=12「…」 への人の回答:\` /
  \`esc=12「…」 agent=a1b2c3d4 に人が直接送ったメッセージ:\`)、2 行目からは人が打った文字そのまま
  (引用もテンプレートもなし)。\`event_prompt\` は通らない。届いた回答は既読扱い
  (\`agent wait --any\` も未読として返さない)。make-progress は、メッセージが
  \`esc=N … への人の回答:\` で始まったら回答として扱うよう書いておく。
- **それ以外は束ねて、\`[orchestrator] delivery_interval\` (既定 5m) に 1 回まで** 届く。
  1 回の配信 = 1 メッセージ (\`event_prompt\` の \`{EVENT}\`)。
- **配信は履歴ではない。いま対応が要るものの一覧で、対象ごとに 1 行**
  (アイテム = Issue か PR、エージェント、エスカレーション、タイマー、CLI の使用量枠、カスタムの種類+本文)。
  同じ対象の新しいものは古いものを置き換える: **行はその対象のいまの状態** を書く
  (差分ではない)。届ける直前に、もう対応の要らないもの (解消した対象、待機中でなくなった
  エスカレーション、リセット済みの使用量枠) は落とされる。
- オーケストレーターがターン中 (フォアグラウンド) の間は束ねた配信を待つ。バックグラウンドの
  シェル・タスク・サブエージェントが動いているだけなら待たずに届く。
- 1 通は最大 50 行。超えた分は最後の行 \`…ほか N 件 (devhub --tell orchestrator events で確認)\`
  に数だけ出る。
- 各行の形式: \`[type]\` + 次の CLI にそのまま使える \`key=value\` (対象の id と、状態の事実)。
  **理由や推奨は書かない**。事実は件数と状態だけで、中身 (どのチェックがなぜ落ちたか、
  レビューコメントの内容、CI のログ、差分) は運ばない。

      [unsettled] issue=acme/app#200「検索の改善」 state=open assigned=yes lane=Todo pr=none agents=none esc=none https://github.com/acme/app/issues/200
      [unsettled] issue=acme/app#123「API整理」 state=open assigned=yes lane="In Review" pr=#130 pr_state=open review=changes_requested unresolved=2 checks=failing agents=a1b2c3d4:idle esc=none https://github.com/acme/app/issues/123
      [unsettled] agent=a1b2c3d4 (API fix) ws=login-fix status=idle issue=acme/app#123 state=closed assigned=yes lane=Done pr=#130 pr_state=merged review=approved unresolved=0 checks=passing esc=none
      [unsettled] agent=c3d4e5f6 (調査) ws=docs status=working issue=none pr=none esc=none
      [waiting.changed] esc=12「レビュー待ち」 issue=acme/app#123 state=open assigned=yes lane="In Review" pr=#130 pr_state=open review=approved unresolved=0 checks=passing agent=a1b2c3d4 status=idle — 待機条件: approve されたら再開
      [escalation.wait_due] esc=15「ログ保存期間」 due=09:00 — 待機条件: 11/10 以降に再開
      [unsettled] pr=acme/app#9「設定画面」 state=open assigned=yes lane=Review pr=#9 pr_state=open review=review_required unresolved=0 checks=passing agents=none esc=none https://github.com/acme/app/pull/9
      [timer.elapsed] sweep
      [usage.threshold] cli=claude window=5-hour pct=82 resets=19:20 — 5時間枠が80%を超えました

- \`issue=\` / \`pr=\` はアイテム (\`owner/repo#N\`。Issue か PR かの違いだけで、扱いは同じ)、\`ws=\` は \`workspace status\` などに、\`agent=\`
  (id の先頭 8 文字) は \`agent ...\` に、\`esc=\` は \`escalation show\` にそのまま渡せる。
  \`pr_state\` は open / draft / closed / merged、\`review\` は approved /
  changes_requested / review_required / none、\`checks\` は passing / failing /
  pending / none、\`agents=\` はアイテムに紐づくエージェントと状態、\`esc=\` は関係する
  エスカレーションと状態。
- \`[orchestrator] events\` で種類を絞れる (\`escalation.*\`、\`!type\` で除外。最後に
  一致したものが勝つ)。既定は全部。\`init\` は常に届く。
- 実物は \`devhub --tell orchestrator events\` で見られる (届いた / 保留 /
  フィルタ / 置き換え / 落とした、の別つき)。終了時に保留中のものは失われるが、次の起動の
  \`init\` で状態を取り直せばよい (起動のたびに、解消していない対象はすべて言い直される)。

| type | いつ | 主な key |
| --- | --- | --- |
| \`init\` | オーケストレーターが起動 / 再起動した (整合性チェックの合図) | - |
| \`escalation_answered\` | 人がエスカレーションに回答した (対応中へ)。人の言葉として単独ですぐ届く (上記) | esc |
| \`escalation.human_direct\` | 人が未完了エスカレーションのエージェントと、その会話欄で直接やりとりし、エージェントが動き出した (要回答なら対応中へ)。人の言葉として単独ですぐ届く | esc, agent |
| \`unsettled\` | 不変条件 (下記) を満たしていないアイテム (Issue / PR) か管理対象エージェント。猶予 1 分のあとに 1 回、事実が変わるたびにもう 1 回、解消しないうちは \`[orchestrator] reminder_interval\` (既定 1h) ごとに | issue / agent, ws, 事実 |
| \`waiting.changed\` | 待機中のエスカレーションが対象にしている Issue / PR / エージェントの状態が変わった (待っている条件が満たされたかもしれない) | esc, 事実 |
| \`escalation.wait_due\` | 待機中のエスカレーションの \`--at\` の時刻になった (待機 1 回につき 1 回) | esc, due |
| \`usage.threshold\` | CLI のプラン枠の使用率が \`[orchestrator] usage_thresholds\` (既定 80, 95) を上向きに超えた | cli, window, pct, resets |
| \`timer.elapsed\` | \`[[orchestrator.timers]]\` か \`orchestrator timer set\` のタイマー | 名前 |
| \`custom.*\` | \`orchestrator emit\` でスクリプトや他ツールが送るもの | 本文 |

\`unsettled\` は DevHub の憲章にある不変条件を満たしていない対象 (母集団のアイテムか管理対象エージェント) で、
事実だけが並ぶ。何をもって「直った」とするか (どのレーンなら誰に何を頼むか) が make-progress に書くこと。
\`devhub --tell --json board\` の \`unsettled\` でいつでも今の一覧を取れる。

GitHub は読むだけ (何も書かない)。母集団は自分にアサインされた open な Issue と PR (GitHub 全体、
\`is:open assignee:@me\`) で、他人の PR のレビューも自分にアサインされていれば同じアイテムになる
(レビュー依頼そのものはイベントにならない)。\`[orchestrator.github] projects\` は各アイテムの lane を読む
Project の一覧で、母集団は決めない。1 tick 1 リクエストで、rate limit が減ると間隔が延びる。**ポーズ中は GitHub を一切ポーリングしない**。
resume ですぐ 1 回読み、その結果も resume の 1 通に入れて届ける。\`orchestrator status\` と
ボードのヘッダーに GitHub ポーリングが active / suspended / idle のどれかが出る。

## 3. ボードとレーンの意味

    devhub --tell --json board

- **要回答** (needs_answer): 人の回答待ちのエスカレーション。オーケストレーター
  がすることは基本ない (他の仕事を進める)。回答は人が DevHub の画面でのみ書く。
- **対応中** (in_progress): 人が回答した。**元のエージェントに判断を伝えて作業を
  再開させ**、回答を使い切ったら \`escalation close\` する。追加で聞くことが
  あれば同じチケットに \`escalation ask\` (要回答に戻る)。対応中に放置しない
  (関係エージェントが誰も動いていないまま 1 分たつと、ボードに「停滞」と出る。
  そのエージェントは \`unsettled\` で届く)。
- **待機中** (waiting): 外部の条件待ち (日付、相手からの Slack の返事、
  レビュー、staging の deploy 完了など) で止めてあるもの。**外部の条件待ちは必ず
  escalation wait で自然言語のトリガーを残す（日付なら --at も）**。
  トリガーは後から読んで条件を確かめられる具体的な文に
  (「11/10 以降に再開」「Bob から Slack で返事が来たら」「#130 が approve されたら」)。
  人に何も聞いていない段階なら \`escalation new … --wait TEXT\` で最初から待機中にできる。
  - \`--at\` の時刻になると \`escalation.wait_due\` が、対象の Issue / PR / エージェントの状態が
    変わると \`waiting.changed\` が届く。トリガーを確かめ、満たされていれば \`escalation resume\`
    で対応中に戻して作業を進める / 人に聞くことができたら \`escalation ask\` /
    不要になっていれば \`escalation close\`。満たされていなければそのまま。
    DevHub から見えない条件 (Slack の返事など) は \`--at\` で見直す時刻を付けておく。
  - 待機中を離れるのは: \`escalation ask\` (要回答へ)、人の書き込みや
    \`escalation resume\` / 関係エージェントが動き出したとき (対応中へ)、close。
    \`escalation wait\` をもう一度呼べばトリガーを書き換えられる。
- **要回答 なのは、最後のエントリがあなたの質問のときだけ。** 質問のあとに何か
  (人の回答、あなたの \`escalation hold\`、下の自動の注記)
  が付けば 対応中 になり、あなたが \`escalation ask\` で聞き直すまで 要回答 には
  戻らない。
  - 追加調査を任せた等で人を待たせたくないときは \`escalation hold ID --note …\`
    で自分から 対応中 に置ける (回答にはならない。人の回答は書けない)。
    対応中のものにも使え、そのときは状態はそのままで今の進み具合のメモになる。
- **関係エージェントが動き出したら、エスカレーションは 要回答 / 待機中 を離れる。**
  要回答 (または待機中) のエスカレーションの \`agents\` のどれかが idle / 待ちから working に
  なると、理由が何であれ (人がその会話欄で話しかけた、あなたの \`agent send\`、
  利用上限後の自動再開「続けて」)、DevHub がスレッドに自動の注記を足して 対応中 にする。
  人が直接話しかけた場合だけ \`escalation.human_direct\` が届く。
  ただし会話の保守だけのターン — \`/compact\` によるコンパクション — は作業ではない。
- サイドバーのエージェント行には、管理対象 (オーケストレーターの印)、待機中のエスカレーションの
  エージェント (砂時計。ツールチップにトリガー)、\`unsettled\` (警告。ツールチップに事実)、
  \`agent keep\` 済み (チェック。ツールチップに理由) の印が出る。

## 4. エスカレーションの原則

- 本当に人の**判断か許可**が必要で、放っておくといずれ進捗が止まるものだけ。
- その前に、破壊的でない調査 (コード、Notion、Slack 検索など) を**エージェントに
  任せて**済ませる。
- 情報が足りなければエスカレーションせず、エージェントに深掘りさせる。
- 中身は自己完結で濃く。システムもドメインも知らないエンジニアが読んで
  判断できるように。コード、数式、Mermaid / SVG の図、表が使える。
- テンプレート: \`## 背景\` / \`## 現状\` / \`## 決めてほしいこと\` /
  \`## 選択肢と推奨\` / \`## 回答後に起きること\` / \`## 参考\`。選択肢は
  \`--option\` でワンクリック回答できるようにする。関係するエージェントは
  **必ず \`--agent\` で全部渡す** (ボードの紐付けと 停滞 の判定に使われる)。
- 画像・SVG はファイルパス (\`![説明](out/shot.png)\`、表のセルの中でもよい) か
  \`\`\`svg で埋め込める；起票時に取り込まれる (\`escalation new\` / \`ask\` の時点で
  エスカレーション専用の場所にコピーされるので、元のワークツリーが消えても残る)。
  相対パスは \`--workspace\`、なければ最初の \`--agent\` のワークスペース、
  なければオーケストレーターのフォルダから。開いているワークスペースと
  オーケストレーターのフォルダの外のファイル、1 枚 10 MB / 合計 25 MB を超えるものは断られる。
- **起こすときに必ずランク付けする** (\`--priority\` / \`--effort\` /
  \`--rank-note\`)。要回答は priority (high が先)、effort (quick が先)、古い順に並ぶ。
  - \`--priority high\`: 複数のエージェントを止めている、または期限がある。
    \`low\`: 待っても誰も止まらない。それ以外は \`normal\` (省略可)。
  - \`--effort quick\`: 人がエスカレーションだけを読んで 1 分ほどで答えられる。
    調べ物や長い検討が要るなら \`deep\`。それ以外は \`normal\`。
  - \`--rank-note\`: なぜその順位か、1 行で (カードに表示される)。
  - 状況が変わったら (止まるエージェントが増えた、期限が近づいた、
    答えやすくなった) \`escalation rank\` で付け直す。
- 過去の判断や知識で明らかに決まるものは人の代わりに答えてよい。その場合は
  何をなぜ決めたかを記録 (decisions.md など) し、次回以降の一貫性を保つ。
- 人を待つ問いが複数あるなら、人の負担が減る場合は 1 件にまとめる。
- 関連するエージェント・ワークスペース・ファイル・エスカレは devhub: リンクで貼れる
  （\`devhub --tell link …\` で作れる）。\`--link devhub:…\` か本文の
  \`[説明](devhub:…)\` に。存在しない対象は起票時に断られる。

    devhub --tell escalation new --title "本番 invoices への列追加" --body - --agent A --option "案 A" --option "案 B" --priority high --effort quick --rank-note "A と B が止まっている"
    devhub --tell escalation rank 12 --priority normal --rank-note "B は別作業で進められる"
    devhub --tell escalation ask 12 --body -
    devhub --tell escalation show 12
    devhub --tell escalation list --state in_progress
    devhub --tell escalation link 12 --agent B
    devhub --tell link file src/app.ts:12
    devhub --tell escalation close 12 --note "案 A で実装を再開"
    devhub --tell escalation hold 12 --note "B に追加調査を依頼中"
    devhub --tell escalation wait 12 --trigger "Bob から Slack で返事が来たら"
    devhub --tell escalation wait 15 --trigger "11/10 以降に再開" --at 2026-11-10T09:00
    devhub --tell escalation new --title "ログ保存期間" --body - --agent A --wait "staging の deploy 完了後"
    devhub --tell escalation resume 12 --note "Bob から OK が来た"
    devhub --tell escalation list --state waiting

## 5. make-progress から使う CLI (抜粋)

すべての選択は明示的なフラグで渡す (既定値に頼らない)。詳細は
\`devhub --tell help\`。\`--json\` は \`--tell\` の直後。

    devhub --tell --json agents --meta role=worker
    devhub --tell --json agent status A
    devhub --tell --json agent wait --any --timeout 600
    devhub --tell agent read A --since CURSOR
    devhub --tell agent read A --entry ID
    devhub --tell agent send A "次は ... をしてください"
    devhub --tell agent requests A
    devhub --tell agent answer A REQ --option 1
    devhub --tell agent stop A
    devhub --tell agent restart A
    devhub --tell agent rename A "123 login fix"
    devhub --tell agent meta A set role reviewer
    devhub --tell agent manage A
    devhub --tell agent keep A --note "他チームの依頼で続ける"
    devhub --tell agent keep A --clear
    devhub --tell --json sessions --workspace W --meta parent=ORCH
    devhub --tell session meta ID set state done
    devhub --tell agent resume ID --name "123 login fix"
    devhub --tell --json sessions --all --meta parent=ORCH
    devhub --tell profiles
    devhub --tell issue actions
    devhub --tell issue assign https://github.com/OWNER/REPO/pull/9 --repo ~/src/REPO --branch carol/settings-page --profile claude --gui --action none --managed --name "PR 9 review" --meta parent=ORCH
    devhub --tell issue assign https://github.com/OWNER/REPO/issues/123 --repo ~/src/REPO --branch 123-fix-login --profile claude --gui --action issue_assignment --managed --name "123 login fix" --meta parent=ORCH
    devhub --tell workspace open ~/src/REPO
    devhub --tell --json workspace status W
    devhub --tell workspace close W --worktree keep --agents stop --terminals close
    devhub --tell --json board
    devhub --tell --json orchestrator status
    devhub --tell orchestrator pause
    devhub --tell orchestrator resume
    devhub --tell orchestrator events --last 20
    devhub --tell --json orchestrator events --last 50
    devhub --tell orchestrator emit --type custom.deploy --text "staging に deploy 完了"
    devhub --tell orchestrator timer list
    devhub --tell orchestrator timer set sweep 30m
    devhub --tell orchestrator timer clear sweep
    devhub --tell notify "A が権限確認で止まっています"
    devhub --tell usage
    devhub --tell --json usage

\`orchestrator timer set / clear\` はこのセッションだけ有効 (既定は
\`[[orchestrator.timers]]\`)。\`emit\` は既定のフィルタと畳み込みをそのまま通る。

## 6. ヒアリングの進め方

一度に全部聞かない。2〜3 問ずつ、具体例を添えて聞き、答えを要約して確認する。
ワークフローはユーザーごとに違うので、推測で埋めずに聞くこと。

1. チームの流れ: GitHub Project のレーン (Todo / In Progress / In Review ...) と、
   それぞれがその人にとって何を意味し、誰が動かすか。監視する Project
   (\`[orchestrator.github] projects\`)。
2. 既存のスキル: solve-task、generate-pr、request-review など、エージェントに
   渡すスキルやプロンプトはあるか。Issue action (\`issue actions\`) はどれを使うか。
   プロファイル (\`profiles\`) と GUI / TUI。
3. レビューと完了: 誰が何をレビューするか。「完了」とは何か (マージ? デプロイ?)。
   完了したエージェントやワークスペースをどうするか。
4. 自律の範囲: オーケストレーターが一人で決めてよいこと / 必ず聞くこと。
   過去の判断をどこに記録するか (例 \`<root>/decisions.md\`)。
5. イベント: どれが重要で、どれを捨てるか (\`events\` の絞り込み)。
   タイマーの間隔 (例: 30 分ごとに棚卸し)。
6. エスカレーションの言語と書き方 (上のテンプレートでよいか、長さ、図の好み)。
7. エージェントの命名と meta タグ (例 \`parent=<orchestrator id>\`、
   \`role=reviewer\`。\`issue=\` は DevHub が書く紐付けで、手では付けない)。meta は停止・クローズ後もセッションに
   残り、\`sessions --meta\` で探せて、\`agent resume\` で引き継がれる。
8. イベント種別ごとに何をしたいか (playbook の素案を一緒に作る)。
9. 必要なら稼働時間 / 静かにしてほしい時間帯。

聞き終えたら下書きを作り、**ユーザーに見せて直してもらってから**書き込む。
書いた後は設定行を提示し、\`custom.*\` イベントや小さなテストで動作確認を
提案する。改訂の依頼が来たら同じ手順で差分だけ直す。

## 7. make-progress の構成

1. **ディスパッチャ**: \`{EVENT}\` の各行を、憲章のルーターの規則どおり Agent ツールの
   \`subagent_type: "fork"\` でバックグラウンドに渡し、すぐ戻る (fork は会話の文脈を引き継ぎ、
   最後の短い要約 — 何を決め、誰に何を渡したか — だけが戻る。Codex では過去の判断を渡した通常の
   サブエージェント)。fork の中で各行を先頭の \`[type]\` で分岐。人の言葉
   (\`esc=N … への人の回答:\` などで始まるメッセージ) も別に受ける。
2. **種別ごとの playbook**: 何を確認し、誰に何を頼み、どの状態で終えるか。
   チームのレーンの意味、レビューと完了の定義、自律の範囲。
3. **エスカレーションのルール**: 上の原則とテンプレート、decisions.md の更新。
4. **init での復旧・整合性チェック**: 再起動後、ボード・エージェント・
   GitHub の状態を突き合わせる (対応中の回答の再伝達、エージェントの
   cursor の取り直し)。

## 8. 例: make-progress の骨組み (そのまま使わず、ヒアリング結果に合わせて書き換える)

    ---
    name: make-progress
    description: DevHub のイベントを受けてチームの作業を前に進める。event_prompt から呼ばれる。
    ---
    # /make-progress
    引数は DevHub の通知 ({EVENT}: 対象ごとに 1 行、いまの状態)。各行を先頭の [type] で処理する。

    ## 人の回答 (メッセージが「esc=N … への人の回答:」で始まる)
    2 行目からが人の言葉そのまま → 紐付くエージェントに agent send で伝える
    → 使い切ったら escalation close。決定を decisions.md に追記。

    ## 人がエージェントに直接送ったメッセージ (「… に人が直接送ったメッセージ:」)
    もう答えが出ていれば escalation close (要点を note に)。まだ聞くことが残って
    いれば escalation ask で質問を更新。他のエージェントにも関わる決定なら agent send で伝える。

    ## init
    board の unsettled / 対応中 / 待機中を見て整合性を取る。対応中は回答を伝え直す。

    ## unsettled issue=… / pr=… agents=none
    着手するアイテムなら issue assign (--managed、--meta parent=自分)。
    着手すべきでない (他の人の作業待ちなど) なら、アイテムの URL を --link に付けた
    待機中のエスカレーション (escalation new … --wait TEXT) か、人に聞くエスカレーション。

    ## unsettled issue=… lane="In Review" review=changes_requested / checks=failing
    担当エージェントに agent send で「レビュー / CI を自分で確認して対応して」と頼む
    (いなければ agent resume か issue assign)。中身は担当が gh で読む。

    ## unsettled agent=… status=idle
    agent read A --since で何が終わったかだけ確かめる → 次の作業を send /
    レビュー依頼を人に出させる / エスカレーションを起こして紐付ける /
    レビュー待ちなら escalation wait --trigger "#130 が approve されたら"。

    ## unsettled agent=… state=closed / assigned=no / issue=none
    担当エージェントに未 push の作業や開いた PR がないか聞く → なければ agent stop
    (必要なら workspace close をフラグを明示して)。続ける理由があるなら agent keep A --note 理由。

    ## waiting.changed / escalation.wait_due
    トリガーを確かめる (review=approved になった、日付が来た、Slack の返事は自分のツールで)。
    満たされていれば escalation resume → 担当エージェントに agent send で再開を指示。

    ## unsettled pr=… (他人の PR のレビュー)
    PR もアイテム。レビュー用のエージェントを issue assign に PR の URL で立てる (--managed)。
    そのエージェントは PR に紐づき、Issue のときと同じに扱われる。

    ## timer.elapsed
    棚卸し: board の unsettled と停滞を確認。
`;
}
