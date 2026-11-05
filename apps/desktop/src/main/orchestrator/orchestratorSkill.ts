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
 * Ordinary agents get neither: the agent wiring asks the controller, per
 * agent, whether this is the orchestrator (`orchestratorSkill` in
 * `shell/agentWiring.ts`). `devhub --tell skill --orchestrator` prints it for
 * an orchestrator DevHub did not start (Claude Desktop).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile } from "../../model/domain.js";
import { devhubSkillPaths } from "../agent/devhubSkill.js";

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

/** The orchestrator's Claude argv: one more `--add-dir`. Other kinds are left alone. */
export function withOrchestratorSkill<
	T extends Pick<AgentProfile, "kind" | "args">,
>(profile: T, skill: OrchestratorSkill | undefined): T {
	if (skill === undefined || profile.kind !== "claude") return profile;
	const flag = `--add-dir=${skill.root}`;
	if (profile.args.includes(flag)) return profile;
	return { ...profile, args: [...profile.args, flag] };
}

export function codexOrchestratorInstructions(
	skill: OrchestratorSkill,
): string {
	return [
		`Orchestrator skill: you are DevHub's orchestrator. When the user's message starts with /${ORCHESTRATOR_SKILL_NAME} or $${ORCHESTRATOR_SKILL_NAME},`,
		"or asks to set up, write or change the orchestrator's event-handling skill (make-progress),",
		`read ${skill.skillFile} and follow it.`,
	].join(" ");
}

export function orchestratorSkillText(cli: string): string {
	return `---
name: ${ORCHESTRATOR_SKILL_NAME}
description: DevHub のオーケストレーター専用。イベントごとに DevHub から呼ばれる「ユーザー自身のイベント処理スキル」(/make-progress など) を、ユーザーへのヒアリングを通じて設計・作成・改訂する。DevHub が渡すイベントの中身、ボードのレーン (要回答 / 対応中 / 不明) の意味、エスカレーションの原則、なるべく停めない心構え、使える CLI をまとめてある。「make-progress を作って」「オーケストレーターのスキルを設定して」「イベントの扱いを変えたい」と言われたとき、または /${ORCHESTRATOR_SKILL_NAME} で使う。
---

# /${ORCHESTRATOR_SKILL_NAME} - make-progress を作るためのスキル

あなたは DevHub のオーケストレーター (Orchestrator 行のエージェント) です。
DevHub は**仕組み** (ボード、エスカレーション、イベント) だけを提供し、
**何をするか**はユーザーのものです。それを書くのが、イベントごとに呼ばれる
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
      # events = ["*", "!agent.permission_requested"]   # 受け取るイベントの絞り込み
      # [orchestrator.github]
      # projects = ["my-org/7"]                  # 監視する Project (OWNER/NUMBER)
      # interval = "90s"                          # 基本間隔 (最短 30s。ここから遅くなるだけ)
      # [[orchestrator.timers]]
      # name = "sweep"
      # interval = "30m"

  \`{EVENT}\` はイベントの行 (下の形式)。\`{EVENT_JSON}\` は同じ内容の JSON 配列で、
  テンプレートに書いたときだけ作られる (スクリプト向けの逃げ道。普段は不要)。
  設定の反映は \`devhub --tell orchestrator restart\` で。

## 2. DevHub が make-progress に渡すもの

- **1 回の配信 = 1 メッセージ**。ユーザーからのメッセージとして届く。
  ターン中・ポーズ中にたまったイベントは、次の配信で**まとめて 1 通**
  (1 イベント 1 行) で届く。順番は発生順。
- まとめるとき同じものは畳まれる: 同じ PR のレビューコメントは件数付きの 1 行、
  同じエージェントの turn_ended は最新だけ (since は最初の未読から)、
  タイマーは 1 つにつき 1 件まで。
- 各行の形式: \`[type]\` + 次の CLI にそのまま使える \`key=value\` + \`—\` + 短い要約。
  詳細は自分で取りに行く (\`agent read --since\`、\`workspace status\`、\`escalation show\`)。

      [github.review_comment] PR #130「ログイン修正」 ws=login-fix agent=a1b2c3d4 (API fix) — alice から新規2件 (未解決 2) https://github.com/acme/app/pull/130
      [github.lane_changed] #123「API整理」 In Progress → In Review ws=api-refactor https://github.com/acme/app/issues/123
      [agent.turn_ended] agent=a1b2c3d4 (API fix) ws=login-fix since=e39 — 「テストを追加しました。残りは…」
      [agent.asked] agent=c3d4e5f6 req=q7 — 「マイグレーションの順番」ほか1問
      [escalation_answered] esc=12「本番DBマイグレーション承認」 — 人が回答しました (escalation show で読む)
      [unaccounted] agent=e5f6a7b8 (調査) ws=docs idle 12m
      [timer.elapsed] sweep

- \`ws=\` は \`workspace status\` などに、\`agent=\` (id の先頭 8 文字) は \`agent ...\` に、
  \`since=\` は \`agent read A --since\` に、\`req=\` は \`agent answer A REQ\` に、
  \`esc=\` は \`escalation show\` にそのまま渡せる。
- \`[orchestrator] events\` で種類を絞れる (\`github.*\`、\`!type\` で除外。最後に
  一致したものが勝つ)。既定は雑音 (\`agent.started\`、\`workspace.opened\` /
  \`workspace.closed\` / \`workspace.branch_changed\`、\`agent.permission_requested\`) を除いた全部。
  \`init\` は常に届く。オーケストレーター自身についてのイベントは来ない。
- 実物は \`devhub --tell orchestrator events\` で見られる (届いた / 保留 /
  フィルタ / 畳まれた、の別つき)。終了時に保留中のものは失われるが、次の起動の
  \`init\` で状態を取り直せばよい。

| カテゴリ | type | いつ | 主な key |
| --- | --- | --- | --- |
| 起動 | \`init\` | オーケストレーターが起動 / 再起動した (整合性チェックの合図) | - |
| ボード | \`escalation_answered\` | 人がエスカレーションに回答した (対応中へ) | esc, agent |
| ボード | \`unaccounted\` | エージェントが 不明 に入った | agent, ws |
| GitHub | \`github.assigned\` / \`github.unassigned\` | 自分へのアサインが付いた / 外れた | ws, agent, URL |
| GitHub | \`github.lane_changed\` | 自分の Issue / PR の Project レーンが動いた (from → to) | ws, URL |
| GitHub | \`github.pr_opened\` | 自分の Issue に紐づく PR、または自分の PR ができた | ws, agent, URL |
| GitHub | \`github.pr_ready\` | PR が draft から ready になった | ws, agent, URL |
| GitHub | \`github.pr_approved\` / \`github.changes_requested\` | 自分の PR が承認された / 変更を要求された | ws, agent, URL |
| GitHub | \`github.review_comment\` | 自分の PR に新しいレビューコメント / スレッド (件数) | ws, agent, URL |
| GitHub | \`github.review_requested\` | 他人の PR で自分にレビュー依頼 | URL |
| GitHub | \`github.reply\` | 自分がレビューした PR に作者が返信 / コミット | URL |
| GitHub | \`github.checks\` | 自分の PR の CI が終わった (成功 / 失敗) | ws, agent, URL |
| GitHub | \`github.pr_merged\` / \`github.pr_closed\` | PR がマージ / マージされずにクローズ | ws, agent, URL |
| ワークスペース | \`workspace.issue_assigned\` | DevHub の Issue アサインでワークスペースとエージェントができた | ws, agent, URL |
| ワークスペース | \`workspace.pr_linked\` | ワークスペースのブランチに PR ができた | ws, agent, URL |
| ワークスペース | \`workspace.opened\` / \`workspace.closed\` / \`workspace.branch_changed\` | 開いた / 閉じた / ブランチが変わった (既定では来ない) | ws |
| エージェント | \`agent.turn_ended\` | ターンが終わった (最後の発言の抜粋) | agent, ws, since |
| エージェント | \`agent.asked\` | 質問 (AskUserQuestion) を出した (見出し) | agent, req |
| エージェント | \`agent.permission_requested\` | 権限確認 (FYI。承認できるのは人だけ。既定では来ない) | agent, req |
| エージェント | \`agent.started\` / \`agent.exited\` / \`agent.failed\` | 起動 (既定では来ない) / 終了 / 失敗 (理由つき) | agent, ws |
| タイマー | \`timer.elapsed\` | \`[[orchestrator.timers]]\` か \`orchestrator timer set\` のタイマー | 名前 |
| カスタム | \`custom.*\` | \`orchestrator emit\` でスクリプトや他ツールが送るもの | 本文 |

GitHub は \`[orchestrator.github] projects\` の Project のうち自分に関係するもの
(アサイン / 作者 / レビュー依頼) と、自分の Issue に紐づく PR だけを読む
(DevHub は読むだけで、カードは動かさない)。1 tick 1 リクエストで、
rate limit が減ると間隔が延び、少なくなると reset まで止まる。

## 3. ボードとレーンの意味

    devhub --tell --json board

- **要回答** (needs_answer): 人の回答待ちのエスカレーション。オーケストレーター
  がすることは基本ない (他の仕事を進める)。回答は人が DevHub の画面でのみ書く。
- **対応中** (in_progress): 人が回答した。オーケストレーターは
  \`escalation show\` で回答を読み、**元のエージェントに判断を伝えて作業を
  再開させ**、回答を使い切ったら \`escalation close\` する。追加で聞くことが
  あれば同じチケットに \`escalation ask\` (要回答に戻る)。対応中に放置しない。
- **不明** (unaccounted): 1 分以上 idle で、どの未完了エスカレーションにも
  名前がないエージェント。**常に空にしておく**。入ったら必ず次のどれか:
  次の作業を渡す / エスカレーションを起こして紐付ける / 終わっていれば
  stop (必要ならワークスペースを閉じる)。

## 4. エスカレーションの原則

- 本当に人の**判断か許可**が必要で、放っておくといずれ進捗が止まるものだけ。
- その前に、破壊的でない調査 (コード、Notion、Slack 検索など) を**エージェントに
  任せて**済ませる。オーケストレーター自身は調査も実作業もしない。指揮だけ。
- 情報が足りなければエスカレーションせず、エージェントに深掘りさせる。
- 中身は自己完結で濃く。システムもドメインも知らないエンジニアが読んで
  判断できるように。コード、数式、Mermaid / SVG の図、表が使える。
- テンプレート: \`## 背景\` / \`## 現状\` / \`## 決めてほしいこと\` /
  \`## 選択肢と推奨\` / \`## 回答後に起きること\` / \`## 参考\`。選択肢は
  \`--option\` でワンクリック回答できるようにする。
- 過去の判断や知識で明らかに決まるものは人の代わりに答えてよい。その場合は
  何をなぜ決めたかを記録 (decisions.md など) し、次回以降の一貫性を保つ。
- 人を待つ問いが複数あるなら、人の負担が減る場合は 1 件にまとめる。

    devhub --tell escalation new --title "本番 invoices への列追加" --body - --agent A --option "案 A" --option "案 B"
    devhub --tell escalation ask 12 --body -
    devhub --tell escalation show 12
    devhub --tell escalation list --state in_progress
    devhub --tell escalation link 12 --agent B
    devhub --tell escalation close 12 --note "案 A で実装を再開"

## 5. なるべく停めないための心構え

- 理由なくエージェントを idle にしない。各イベントの処理の最後に、関係する
  全エージェントが「進行中 / 既知の外部要因待ち (CI、レビューなど) /
  エスカレーション中 / 終了」のどれかになっていること。
- エスカレーション待ちの間も、他の仕事は並行して進める。
- ビジーポーリングしない。イベントとタイマーに任せ、1 回の処理は短く終える。
- トークンを節約する。全文を読み直さず \`agent read A --since CURSOR\` で差分だけ。
  cursor は覚えておく (エージェントの meta や root のメモに)。
- 権限確認 (permission prompt) を承認できるのは人だけ。止まっているなら
  \`notify\` かエスカレーションで知らせ、決して自分で回避しない。
  \`agent answer\` は質問 (AskUserQuestion) にだけ使う。
- 人の画面を奪わない。\`--tell\` は画面を動かさない。\`focus\` は頼まれたときだけ。

## 6. make-progress から使う CLI (抜粋)

すべての選択は明示的なフラグで渡す (既定値に頼らない)。詳細は
\`devhub --tell help\`。\`--json\` は \`--tell\` の直後。

    devhub --tell --json agents --meta role=worker
    devhub --tell --json agent status A
    devhub --tell --json agent wait --any --timeout 600
    devhub --tell agent read A --since CURSOR
    devhub --tell agent send A "次は ... をしてください"
    devhub --tell agent requests A
    devhub --tell agent answer A REQ --option 1
    devhub --tell agent stop A
    devhub --tell agent restart A
    devhub --tell agent rename A "123 login fix"
    devhub --tell agent meta A set issue 123
    devhub --tell sessions --workspace W
    devhub --tell agent resume ID --name "123 login fix"
    devhub --tell profiles
    devhub --tell issue actions
    devhub --tell issue assign https://github.com/OWNER/REPO/issues/123 --repo ~/src/REPO --branch 123-fix-login --profile claude --gui --action issue_assignment --send --meta parent=ORCH --meta issue=123
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

\`orchestrator timer set / clear\` はこのセッションだけ有効 (既定は
\`[[orchestrator.timers]]\`)。\`emit\` は既定のフィルタと畳み込みをそのまま通る。

## 7. ヒアリングの進め方

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
   \`issue=123\`、\`role=reviewer\`)。
8. イベント種別ごとに何をしたいか (playbook の素案を一緒に作る)。
9. 必要なら稼働時間 / 静かにしてほしい時間帯。

聞き終えたら下書きを作り、**ユーザーに見せて直してもらってから**書き込む。
書いた後は設定行を提示し、\`custom.*\` イベントや小さなテストで動作確認を
提案する。改訂の依頼が来たら同じ手順で差分だけ直す。

## 8. make-progress の構成

1. **ディスパッチャ**: \`{EVENT}\` の各行を先頭の \`[type]\` で分岐 (上から順に処理)。
2. **イベント種別ごとの playbook**: 何を確認し、誰に何を送り、どの状態で
   終えるか。
3. **不明レーンのルール**: 処理の最後に \`board\` を見て 不明 を空にする。
4. **エスカレーションのルール**: 上の原則とテンプレート、自律の範囲、
   decisions.md の更新。
5. **init での復旧・整合性チェック**: 再起動後、ボード・エージェント・
   GitHub の状態を突き合わせる (対応中の回答の再伝達、エージェントの
   cursor の取り直し、Project のレーンと実態のずれ)。

## 9. 例: make-progress の骨組み (そのまま使わず、ヒアリング結果に合わせて書き換える)

    ---
    name: make-progress
    description: DevHub のイベントを受けてチームの作業を前に進める。event_prompt から呼ばれる。
    ---
    # /make-progress
    引数は DevHub のイベント ({EVENT}: 1 行 1 イベント)。各行を先頭の [type] で処理する。
    自分では調査・実装しない。エージェントに任せ、人には要るときだけ聞く。

    ## init
    board / agents / 監視 Project を見て整合性を取る。対応中は回答を伝え直す。
    不明 のエージェントに次の作業を渡す。

    ## escalation_answered
    escalation show で回答を読む → 紐付くエージェントに agent send で伝える
    → 使い切ったら escalation close。決定を decisions.md に追記。

    ## unaccounted / agent.turn_ended
    agent read A --since <since=> で差分を読む → 次の作業を send / エスカレーション / stop。

    ## agent.asked
    decisions.md で決まっていれば agent answer A <req=>、でなければエスカレーション。

    ## github.lane_changed (例: Todo → In Progress)
    issue assign で担当エージェントを立てる (meta issue=N, parent=自分)。

    ## github.changes_requested / github.review_comment
    その PR のエージェントに対応を依頼。いなければ agent resume か issue assign。

    ## github.checks (失敗)
    その PR のエージェントに CI ログを見て直すよう依頼。

    ## github.review_requested
    レビュー用のエージェントを立てる (issue assign に PR の URL)。

    ## github.pr_merged
    エージェントを stop、ワークスペースを閉じる。

    ## timer.elapsed
    棚卸し: 対応中が放置されていないか、不明 が空か、止まった CI はないか。

    ## 最後に必ず
    board を確認し、不明 を空に。関係エージェントが全員「進行中 / 待ち /
    エスカレーション中 / 終了」のどれかであること。
`;
}
