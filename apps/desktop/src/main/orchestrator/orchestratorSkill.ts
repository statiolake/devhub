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
description: DevHub のオーケストレーター専用。イベントごとに DevHub から呼ばれる「ユーザー自身のイベント処理スキル」(/make-progress など) を、ユーザーへのヒアリングを通じて設計・作成・改訂する。DevHub が渡すイベントの中身、ボードのレーン (要回答 / 対応中 / 待機中) の意味、エスカレーションの原則、なるべく停めない心構え、使える CLI をまとめてある。「make-progress を作って」「オーケストレーターのスキルを設定して」「イベントの扱いを変えたい」と言われたとき、または /${ORCHESTRATOR_SKILL_NAME} で使う。
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
  ターン中・ポーズ中にたまったイベントは、次の配信で**まとめて 1 通**で届く。
- **配信は履歴ではない。いま対応が要るものの一覧で、対象ごとに 1 行**
  (PR / Issue、エージェント、Workspace、エスカレーション、タイマー、CLI の使用量枠、カスタムの種類+本文)。
  同じ対象の新しいイベントはその行に畳まれる: レビューコメントは件数を合算、
  レーンは最初の from → 最後の to (戻って同じなら行ごと消える)、CI やレビューは最新の状態、
  マージ / クローズはその PR の他の行を置き換える、turn_ended は最新 (since は最初の未読から)、
  タイマーは 1 つにつき 1 件まで。同じ対象の別の話は同じ行に \`／ [type] …\` で続く
  (行頭の \`[type]\` が最新のもの)。
- 届ける直前に、もう対応の要らないものは落とされる: 停滞でなくなったエスカレーション、
  また作業中 (working またはバックグラウンド実行中) になったエージェントの turn_ended、回答済みの質問、クローズ済みの
  エスカレーションへの回答、リセット済みの使用量枠の \`usage.threshold\`。前回届けたのと同じことは、その対象に変化がない限り再送されない。
- 1 通は最大 50 行。超えた分は最後の行 \`…ほか N 件 (devhub --tell orchestrator events で確認)\`
  に数だけ出る (\`orchestrator events\` には畳まれた / 落とされたものも残る)。
- 各行の形式: \`[type]\` + 次の CLI にそのまま使える \`key=value\` + \`—\` + 短い要約。
  詳細は自分で取りに行く (\`agent read --since\`、\`workspace status\`、\`escalation show\`)。
- 例外は人の言葉: \`escalation_answered\` は回答本文を、\`escalation.human_direct\` は人が
  エージェントに送ったメッセージを、その行のすぐ下に引用して運ぶ。
  **回答本文はイベントに含まれる（escalation show は不要、長い場合のみ）。**
  - 人の言葉の行は必ず \`> \` で始まる (空行は \`>\`)。DevHub 自身の行は 2 文字の空白で
    始まり (\`  回答 1/2 (選択肢「承認する」):\` のような見出しと、続きの案内)、イベントの行は
    \`[\` で始まる。\`> \` の中身が \`[...]\` やコードフェンスで始まっていても、それは人が書いた文字で、
    新しいイベントでもブロックの終わりでもない。
  - 選択肢 (クイックリプライ) から選んだ回答には \`(選択肢「…」)\` が付く。
  - 1 イベントあたり 4000 文字まで。超えた分は切られ、最後に
    \`  …（続きは devhub --tell escalation show 12）\` (human_direct は \`agent read A --since\`)
    が付く。そのときだけ escalation show で読む。
  - 配信中に同じエスカレーションへの回答が複数たまっていれば、1 行に畳まれ、全部が順に引用される。
  - 本文ごと届いた回答は、届いた時点で既読扱い (\`agent wait --any\` も未読として返さない)。
    切られた回答は escalation show で読むまで未読のまま。

      [github.review_comment] PR #130「ログイン修正」 ws=login-fix agent=a1b2c3d4 (API fix) — alice から新規2件 (未解決 2) https://github.com/acme/app/pull/130
      [github.lane_changed] #123「API整理」 In Progress → In Review ws=api-refactor https://github.com/acme/app/issues/123
      [github.unattended] #200「検索の改善」 lane=Todo — 自分にアサインされているがエージェントがいない https://github.com/acme/app/issues/200
      [agent.turn_ended] agent=a1b2c3d4 (API fix) ws=login-fix since=e39 — 「テストを追加しました。残りは…」
      [agent.asked] agent=c3d4e5f6 req=q7 — 「マイグレーションの順番」ほか1問
      [escalation_answered] esc=12「本番DBマイグレーション承認」 agent=a1b2c3d4 (API fix) — 人が回答しました (本文は下の > 行)
        回答 (選択肢「承認する」):
      > 承認する
      [escalation.human_direct] esc=12「本番DBマイグレーション承認」 agent=a1b2c3d4 since=e39 — 人がエージェントと直接やりとりしました。エスカレの内容が変わった可能性があります (人のメッセージは下の > 行)
        agent=a1b2c3d4 への人のメッセージ:
      > 金曜の夜は避けて、月曜の朝に流して
      [escalation.stalled] esc=12「本番DBマイグレーション承認」 agents=a1b2c3d4,c3d4e5f6 idle 3m — 対応中だが動いているエージェントがいない
      [escalation.wait_due] esc=12「本番DBマイグレーション承認」 — 待機条件の時刻になりました: 11/10 以降に再開
      [escalation.waiting_reminder] 待機中 2 件 — esc=12「本番DBマイグレーション承認」: Bob から Slack で返事が来たら / esc=15「ログ保存期間」: 11/10 以降 (あと 3日)
      [timer.elapsed] sweep
      [usage.threshold] cli=claude window=5-hour pct=82 resets=19:20 — 5時間枠が80%を超えました

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
| ボード | \`escalation_answered\` | 人がエスカレーションに回答した (対応中へ)。回答本文 (選んだ選択肢も) が行の下に \`> \` で引用される。4000 文字を超えた分だけ escalation show で読む。届いた時点で既読 | esc, agent, 回答本文 |
| ボード | \`escalation.wait_due\` | 待機中のエスカレーションの \`--at\` の時刻になった (待機 1 回につき 1 回。届く前に待機中でなくなっていれば落とされる) | esc |
| ボード | \`escalation.waiting_reminder\` | \`[orchestrator] wait_reminder_interval\` (既定 1h) ごとに、待機中の全エスカレーションとトリガーを 1 行で。待機中がなければ来ない。たまっても最新の 1 件だけ | esc (行内に複数) |
| ボード | \`escalation.human_direct\` | 人が未完了エスカレーションのエージェントと、その会話欄で直接やりとりし、エージェントが動き出した (要回答なら対応中へ)。人のメッセージが行の下に \`> \` で引用される | esc, agent, since, メッセージ |
| ボード | \`escalation.stalled\` | 対応中のエスカレーションの関係エージェントが 1 分以上誰も動いていない (全員 idle / 待ち / 停止 / 消えた、または紐付けなし: \`agents=none\`)。1 回の停滞につき 1 回。未読の回答があるうちは来ず、回答 (\`escalation_answered\`) が届いた時点 (本文が切られていたときは \`escalation show\` で読んだ時点) から数え始める | esc, agents |
| GitHub | \`github.assigned\` | 自分にアサインされた | ws, agent, URL |
| GitHub | \`github.lane_changed\` | 自分の Issue / PR の Project レーンが動いた (from → to) | ws, URL |
| GitHub | \`github.unattended\` | 自分にアサインされた open な Issue に、紐づく DevHub エージェントも、それを待つ待機中のエスカレーションもない (状態で判定。下記) | lane, URL |
| GitHub | \`github.pr_opened\` | 自分の Issue に紐づく PR、または自分の PR ができた | ws, agent, URL |
| GitHub | \`github.pr_ready\` | PR が draft から ready になった | ws, agent, URL |
| GitHub | \`github.pr_approved\` / \`github.changes_requested\` | 自分の PR が他の人に承認された / 変更を要求された | ws, agent, URL |
| GitHub | \`github.review_comment\` | 自分の PR に他の人の新しいレビューコメント / スレッド (件数は他の人の分だけ) | ws, agent, URL |
| GitHub | \`github.review_requested\` | 他人の PR で自分にレビュー依頼 | URL |
| GitHub | \`github.reply\` | 自分がレビューした PR に作者が返信 / コミット (自分の push は除く) | URL |
| GitHub | \`github.checks\` | 自分の PR の CI が終わった (成功 / 失敗) | ws, agent, URL |
| GitHub | \`github.pr_merged\` / \`github.pr_closed\` | PR がマージ / マージされずにクローズ | ws, agent, URL |
| ワークスペース | \`workspace.issue_assigned\` | DevHub の Issue アサインでワークスペースとエージェントができた | ws, agent, URL |
| ワークスペース | \`workspace.pr_linked\` | ワークスペースのブランチに PR ができた | ws, agent, URL |
| ワークスペース | \`workspace.opened\` / \`workspace.closed\` / \`workspace.branch_changed\` | 開いた / 閉じた / ブランチが変わった (既定では来ない) | ws |
| エージェント | \`agent.turn_ended\` | 本当に終わった: idle になり、裏のバックグラウンドシェル / タスク / サブエージェントも残っていない (最後の発言の抜粋) | agent, ws, since |
| エージェント | \`agent.asked\` | 質問 (AskUserQuestion) を出した (見出し) | agent, req |
| エージェント | \`agent.permission_requested\` | 権限確認 (FYI。承認できるのは人だけ。既定では来ない) | agent, req |
| エージェント | \`agent.started\` / \`agent.exited\` / \`agent.failed\` | 起動 (既定では来ない) / 終了 / 失敗 (理由つき) | agent, ws |
| 使用量 | \`usage.threshold\` | CLI のプラン枠 (5 時間 / 7 日など) の使用率が \`[orchestrator] usage_thresholds\` (既定 80, 95) を上向きに超えた。枠ごと・しきい値ごとに 1 周期 1 回。届く前に枠がリセットされていれば落とされる | cli, window, pct, resets |
| タイマー | \`timer.elapsed\` | \`[[orchestrator.timers]]\` か \`orchestrator timer set\` のタイマー | 名前 |
| カスタム | \`custom.*\` | \`orchestrator emit\` でスクリプトや他ツールが送るもの | 本文 |

GitHub は \`[orchestrator.github] projects\` の Project のうち自分に関係するもの
(アサイン / 作者 / レビュー依頼) と、自分の Issue に紐づく PR だけを読む
(DevHub は読むだけで、カードは動かさない)。**自分 (viewer) のレビュー・コメント・push は
イベントにならない** (エージェントも同じ GitHub アカウントで書くので、自分の返信がこだましない):
件数は他の人の分だけで、新しいのが自分の分だけなら何も来ない。1 tick 1 リクエストで、
rate limit が減ると間隔が延び、少なくなると reset まで止まる。
**ポーズ中は GitHub を一切ポーリングしない** (API を消費しない。最後の状態は保持)。
resume ですぐ 1 回読み、ポーズ中の正味の変化 (途中の行き来は消える) を resume の
1 通に入れて届ける。最後の状態は \`orchestrator-github.json\` にも保存され、
DevHub の再起動後や同じプロファイルで新しく起動したオーケストレーターも、その差分から
始まる。Project の設定や GitHub のログインが変わったとき、または 7 日より古いときは
最初の 1 回がベースライン (何も言わない)。\`orchestrator status\` と ボードのヘッダーに
GitHub ポーリングが active / suspended / idle のどれかが出る。

\`github.unattended\` は差分ではなく **状態** で出る: 毎回の poll (最初のベースラインも
含む) と、ワークスペース / エージェントが変わるたびに、Project 上の Issue のうち
「自分にアサイン・open・紐づく生きたエージェントなし」のものを 1 件ずつ言う。
レーンは判定に使わない (\`lane=\` は参考情報)。**紐づく** とは、開いている
ワークスペースのブランチがその Issue を指し (\`123-fix-login\`、Issue アサインが作る
ブランチ)、そこに停止中でないエージェントがいること、またはエージェントの meta
\`issue=\` がその Issue (URL か、同じリポジトリの番号 \`123\` / \`#123\`) を指すこと。
**待機中のエスカレーションが対象にしている Issue は来ない** (既知の条件を待って
対応中だから。\`orchestrator events\` の末尾に \`waiting in esc=12\` と出る)。
対象にしている、とは: リンクにその Issue の URL がある (または、その Issue の
ワークスペースやエージェントへの \`devhub:\` リンク)、\`workspaceId\` のワークスペースの
ブランチがその Issue を指す、関係エージェントの誰かが上の規則でその Issue に紐づく
(停止中でもよい)、のどれか。要回答 / 対応中のエスカレーションでは外れない。
待機中でなくなった (resume / ask / 回答 / close) ときにまだエージェントがいなければ、
すぐにまた来る。
同じ Issue は「放置されている間」に 1 回だけ。エージェント (か待機中のエスカレーション)
が付いて、また外れたらもう一度来る。届く前にエージェントが付いた / 待機中の
エスカレーションができた / クローズされた ものは落とされる。
起動直後の \`init\` のあとに、取りこぼしたアサインも含めて今の一覧が届く。
いつでも \`devhub --tell --json board\` の \`unattendedIssues\` で今の一覧を取れる
(\`orchestrator status\` には Project ごとの 件数 / 自分にアサイン / 放置 が出る。
なぜ何も来なかったかは \`orchestrator events\` の末尾)。

## 3. ボードとレーンの意味

    devhub --tell --json board

- **要回答** (needs_answer): 人の回答待ちのエスカレーション。オーケストレーター
  がすることは基本ない (他の仕事を進める)。回答は人が DevHub の画面でのみ書く。
- **対応中** (in_progress): 人が回答した。オーケストレーターは
  \`escalation show\` で回答を読み、**元のエージェントに判断を伝えて作業を
  再開させ**、回答を使い切ったら \`escalation close\` する。追加で聞くことが
  あれば同じチケットに \`escalation ask\` (要回答に戻る)。対応中に放置しない。
  - 対応中なのに関係エージェントが誰も動いていない (idle / 待ち / 停止 / 消えた、
    紐付けなし) まま 1 分たつと \`escalation.stalled\` が届く (ボードには「停滞」)。
    **escalation.stalled を受けたら、回答内容を担当エージェントに伝える／作業を再開させる／必要なら escalation ask で要回答に戻す／不要なら close**。
    \`agents=none\` なら \`escalation link ID --agent A\` で担当を紐付ける。
    関係エージェントが動き出すか、新しいエントリが付くと、次の停滞でまた届く。
- **待機中** (waiting): 外部の条件待ち (日付、相手からの Slack の返事、
  staging の deploy 完了など) で止めてあるもの。**外部の条件待ちは必ず escalation wait で自然言語のトリガーを残す（日付なら --at も）**。
  トリガーは後から読んで条件を確かめられる具体的な文に
  (「11/10 以降に再開」「Bob から Slack で返事が来たら」「staging の deploy 完了後」)。
  人に何も聞いていない段階なら \`escalation new … --wait TEXT\` で最初から待機中にできる。
  - \`--at\` の時刻になると \`escalation.wait_due\` が届く。
  - \`escalation.waiting_reminder\` (既定 1 時間おき) が届いたら、各トリガーを確認し
    (Slack などは自分のツールで見に行く)、満たされていれば \`escalation resume\`
    で対応中に戻して作業を進める / 人に聞くことができたら \`escalation ask\` /
    不要になっていれば \`escalation close\`。満たされていなければそのまま。
  - 待機中を離れるのは: \`escalation ask\` (要回答へ)、人の書き込みや
    \`escalation resume\` / 関係エージェントが動き出したとき (対応中へ)、close。
    \`escalation wait\` をもう一度呼べばトリガーを書き換えられる。
- **要回答 なのは、最後のエントリがあなたの質問のときだけ。** 質問のあとに何か
  (人の回答、あなたの \`escalation hold\`、下の自動の注記)
  が付けば 対応中 になり、あなたが \`escalation ask\` で聞き直すまで 要回答 には
  戻らない。
  - 追加調査を任せた等で人を待たせたくないときは \`escalation hold ID --note …\`
    で自分から 対応中 に置ける (回答にはならない。人の回答は書けない)。
- **関係エージェントが動き出したら、エスカレーションは 要回答 / 待機中 を離れる。**
  要回答 (または待機中) のエスカレーションの \`agents\` のどれかが idle / 待ちから working に
  なると、理由が何であれ (人がその会話欄で話しかけた、あなたの \`agent send\`、
  イベントの注入、利用上限後の自動再開「続けて」)、DevHub がスレッドに自動の
  注記を足して 対応中 にする。
  あなたが \`escalation ask\` で聞き直す (要回答に戻る) か close するまで対応中の
  まま。人が直接話しかけた場合だけ \`escalation.human_direct\` が届く
  (それ以外はあなたが起こしたか、\`agent.turn_ended\` で分かるので届かない)。
  ただし会話の保守だけのターン — \`/compact\` によるコンパクション (DevHub が
  キャッシュ切れ前に自動で送るもの、人が打ったもの) — は作業ではない。
  要回答のまま、注記も \`agent.turn_ended\` も届かず、停滞 も解けない。
- **idle のエージェントを放置しない。** ターンが終わったら (\`agent.turn_ended\`)
  必ず次のどれか: 次の作業を渡す / エスカレーションを起こして紐付ける /
  終わっていれば stop (必要ならワークスペースを閉じる)。

## 4. エスカレーションの原則

- 本当に人の**判断か許可**が必要で、放っておくといずれ進捗が止まるものだけ。
- その前に、破壊的でない調査 (コード、Notion、Slack 検索など) を**エージェントに
  任せて**済ませる。オーケストレーター自身は調査も実作業もしない。指揮だけ。
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
- 使用率が高いときは新しいエージェントを増やさない・重い作業はリセット後に回す・
  \`devhub --tell usage\` で確認 (\`usage.threshold\` が合図。\`init\` のときにも一度見る)。

## 6. make-progress から使う CLI (抜粋)

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
    devhub --tell agent meta A set issue 123
    devhub --tell --json sessions --workspace W --meta parent=ORCH
    devhub --tell session meta ID set state done
    devhub --tell agent resume ID --name "123 login fix"
    devhub --tell --json sessions --all --meta parent=ORCH
    devhub --tell profiles
    devhub --tell issue actions
    devhub --tell issue assign https://github.com/OWNER/REPO/issues/123 --repo ~/src/REPO --branch 123-fix-login --profile claude --gui --action issue_assignment --send --name "123 login fix" --meta parent=ORCH --meta issue=123
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
   \`issue=123\`、\`role=reviewer\`)。meta は停止・クローズ後もセッションに
   残り、\`sessions --meta\` で探せて、\`agent resume\` で引き継がれる。
8. イベント種別ごとに何をしたいか (playbook の素案を一緒に作る)。
9. 必要なら稼働時間 / 静かにしてほしい時間帯。

聞き終えたら下書きを作り、**ユーザーに見せて直してもらってから**書き込む。
書いた後は設定行を提示し、\`custom.*\` イベントや小さなテストで動作確認を
提案する。改訂の依頼が来たら同じ手順で差分だけ直す。

## 8. make-progress の構成

1. **ディスパッチャ**: \`{EVENT}\` の各行を先頭の \`[type]\` で分岐 (上から順に処理)。
2. **イベント種別ごとの playbook**: 何を確認し、誰に何を送り、どの状態で
   終えるか。
3. **放置しないルール**: 処理の最後に \`board\` を見て、停滞 のエスカレーションと idle のまま理由のないエージェントをなくす。
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
    引数は DevHub のイベント ({EVENT}: いま対応が要るもの、対象ごとに 1 行)。各行を先頭の [type] で処理し、
    行内の「／ [type] …」も同じ対象の続きとして読む。
    自分では調査・実装しない。エージェントに任せ、人には要るときだけ聞く。

    ## init
    board / agents / 監視 Project を見て整合性を取る。対応中は回答を伝え直す。
    idle のまま理由のないエージェントに次の作業を渡す。

    ## escalation_answered
    回答本文はイベントに含まれる（escalation show は不要、長い場合のみ）。
    行の下の > 行が人の回答 → 紐付くエージェントに agent send で伝える
    → 使い切ったら escalation close。決定を decisions.md に追記。

    ## escalation.human_direct
    人が言ったことは行の下の > 行にある (続きがあれば agent read A --since <since=>)。
    もう答えが出ていれば escalation close (要点を note に)。まだ聞くことが残って
    いれば escalation ask で質問を更新 (要回答に戻る)。他のエージェントにも
    関わる決定なら agent send で伝える。決定は decisions.md に追記。

    ## escalation.wait_due / escalation.waiting_reminder
    各トリガーを確かめる (日付は今日と比べる、Slack の返事は自分のツールで見る)。
    満たされていれば escalation resume → 担当エージェントに agent send で再開を指示。
    人に聞くことができたら escalation ask、不要なら escalation close。まだならそのまま。

    ## escalation.stalled
    回答はもう届いている (必要なら escalation show で読み直す) → 担当エージェントに agent send で伝えて作業を再開させる。
    agents=none なら escalation link ID --agent A で紐付ける。まだ人に聞くことがあれば
    escalation ask (要回答に戻る)、もう要らなければ escalation close。

    ## agent.turn_ended
    (バックグラウンドのシェル / タスク / サブエージェントが全部終わって idle になったときだけ来る)
    agent read A --since <since=> で差分を読む → 次の作業を send / エスカレーション / stop。

    ## agent.asked
    decisions.md で決まっていれば agent answer A <req=>、でなければエスカレーション。

    ## github.lane_changed (例: Todo → In Progress)
    issue assign で担当エージェントを立てる (meta issue=N, parent=自分)。

    ## github.unattended
    github.unattended を受けたら Issue をアサインするか（issue assign）、エスカレする。
    issue assign には meta issue=N, parent=自分 を付ける (付けると紐づいたと分かる)。
    着手すべきでない (他の人の作業待ちなど) ならエスカレーションで人に聞く。
    既知の条件待ちなら、その Issue の URL を --link に付けた待機中のエスカレーション
    (escalation new … --wait TEXT、または escalation wait) にする。待機中の間は来ない。

    ## github.changes_requested / github.review_comment
    その PR のエージェントに対応を依頼。いなければ agent resume か issue assign。

    ## github.checks (失敗)
    その PR のエージェントに CI ログを見て直すよう依頼。

    ## github.review_requested
    レビュー用のエージェントを立てる (issue assign に PR の URL)。

    ## github.pr_merged
    エージェントを stop、ワークスペースを閉じる。

    ## timer.elapsed
    棚卸し: 対応中が停滞していないか、idle で放置されたエージェントはいないか、止まった CI はないか。

    ## 最後に必ず
    board を確認し、停滞をなくす。関係エージェントが全員「進行中 / 待ち /
    エスカレーション中 / 終了」のどれかであること。
`;
}
