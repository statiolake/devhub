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
      event_prompt = "/make-progress {EVENT_JSON}"
      init_prompt = "/make-progress {EVENT_JSON}"
      # events = ["*", "!agent.permission_requested"]   # 受け取るイベントの絞り込み
      # [[orchestrator.timers]]
      # name = "sweep"
      # interval = "30m"

  \`{EVENT}\` は人間向けの文章、\`{EVENT_JSON}\` は同じ内容の JSON。両方入れてもよい
  (\`"/make-progress {EVENT}\\n\\n{EVENT_JSON}"\`)。設定の反映は
  \`devhub --tell orchestrator restart\` で。

## 2. DevHub が make-progress に渡すもの

- **1 回の配信 = 1 メッセージ**。ユーザーからのメッセージとして届く。
  複数のイベントがまとめて (coalesce されて) 1 通で届くことがある。
- \`{EVENT}\`: \`[event: <type>] ...\` で始まる短い説明と、見るべきコマンド。
- \`{EVENT_JSON}\`: イベントの**配列**。各要素は \`type\` を持ち、残りは type ごとの
  フィールド (agent id、escalation id、URL など)。分岐は \`type\` で行う。
- オーケストレーターが応答中 (ターン中) のイベントは**保持され、ターン終了後に
  順番どおり**届く。ポーズ中 (ボードのスイッチ / \`orchestrator pause\`) は全て
  保持され、resume で順に届く。終了時に保持中のものは失われるが、次の起動の
  \`init\` で状態を取り直せばよい。
- \`[orchestrator] events\` で種類を絞れる (\`github.*\`、\`!type\` で除外)。

イベントの種類 (カテゴリ別)。**正確な一覧とフィールドは
\`devhub --tell orchestrator events\` と DevHub の docs/orchestrator.md が正**。
実物を見てから playbook を書くこと。

| カテゴリ | type | 意味 |
| --- | --- | --- |
| 起動 | \`init\` | オーケストレーターが起動 / 再起動した。整合性チェックの合図 |
| ボード | \`escalation_answered\` | 人がエスカレーションに回答した (対応中へ) |
| ボード | \`unaccounted\` | エージェントが 不明 に入った |
| GitHub | \`github.assigned\`, \`github.lane_changed\` | Issue の割り当て、Project のレーン移動 |
| GitHub | \`github.pr_opened\` / \`pr_ready\` / \`pr_approved\` / \`pr_changes_requested\` | PR の作成、ready、承認、変更要求 |
| GitHub | \`github.pr_review_comment\` / \`pr_review_requested\` / \`pr_reply\` | レビューコメント、レビュー依頼、返信 |
| GitHub | \`github.pr_checks\` / \`pr_merged\` / \`pr_closed\` | CI 結果、マージ、クローズ |
| ワークスペース | \`workspace.issue_assigned\`, \`workspace.pr_linked\` など | Issue の割り当て、PR の紐付け |
| エージェント | \`agent.turn_ended\` | ターンが終わった (次の指示が要るか) |
| エージェント | \`agent.asked\` | 質問 (AskUserQuestion) を出した |
| エージェント | \`agent.permission_requested\` | 権限確認 (FYI。承認できるのは人だけ) |
| エージェント | \`agent.failed\`, \`agent.exited\` | 失敗した / 終了した |
| タイマー | \`timer.elapsed\` | \`[[orchestrator.timers]]\` の定期タイマー |
| カスタム | \`custom.*\` | \`orchestrator emit\` でスクリプトや他ツールが送るもの |

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
    devhub --tell notify "A が権限確認で止まっています"

イベント関連 (\`devhub --tell orchestrator events\` で最近のイベントの実物、
\`orchestrator emit\` で custom イベント、\`orchestrator timer\` で一回きりの
タイマー) は、使える形を \`devhub --tell help\` で確認してから使う。

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

1. **ディスパッチャ**: \`{EVENT_JSON}\` の各要素を \`type\` で分岐 (配列を順に処理)。
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
    引数は DevHub のイベント ({EVENT_JSON} の配列)。各要素を type で処理する。
    自分では調査・実装しない。エージェントに任せ、人には要るときだけ聞く。

    ## init
    board / agents / 監視 Project を見て整合性を取る。対応中は回答を伝え直す。
    不明 のエージェントに次の作業を渡す。

    ## escalation_answered
    escalation show で回答を読む → 紐付くエージェントに agent send で伝える
    → 使い切ったら escalation close。決定を decisions.md に追記。

    ## unaccounted / agent.turn_ended
    agent read --since で差分を読む → 次の作業を send / エスカレーション / stop。

    ## agent.asked
    decisions.md で決まっていれば agent answer、でなければエスカレーション。

    ## github.lane_changed (例: Todo → In Progress)
    issue assign で担当エージェントを立てる (meta issue=N, parent=自分)。

    ## github.pr_changes_requested / github.pr_review_comment
    その PR のエージェントに対応を依頼。いなければ agent resume か issue assign。

    ## github.pr_merged
    エージェントを stop、ワークスペースを閉じる。

    ## timer.elapsed
    棚卸し: 対応中が放置されていないか、不明 が空か、止まった CI はないか。

    ## 最後に必ず
    board を確認し、不明 を空に。関係エージェントが全員「進行中 / 待ち /
    エスカレーション中 / 終了」のどれかであること。
`;
}
