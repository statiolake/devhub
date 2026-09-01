/**
 * The screen manifests DevHub ships, for the two Agent kinds it knows.
 *
 * Carried from the herdr project (https://github.com/herdrdev/herdr), files
 * `src/detect/manifests/claude.toml` (version 2026.08.13.1) and
 * `src/detect/manifests/codex.toml` (version 2026.08.09.1), licensed under the
 * Apache License, Version 2.0. See `distribution/THIRD-PARTY-NOTICES.txt`.
 *
 * They are TypeScript rather than TOML on purpose. herdr's manifests are data
 * because herdr updates them from a server at runtime; DevHub does not, so a
 * parser, a schema validator and a version negotiation would all exist to read
 * a file that ships in the same commit as the code that reads it. Written here,
 * a rule that names a region the engine does not have fails to compile.
 *
 * The rule ids, priorities, regions and patterns are herdr's, unchanged. Where
 * a comment appears in the TOML it is reproduced beside the rule it explained.
 */

import {
	bottomNonEmptyLines,
	topNonEmptyLines,
	type Manifest,
} from "./rules.js";

/**
 * Claude Code.
 *
 * Read top-down: the title spinner beats everything, the blocked forms beat
 * the idle prompt box, and the legacy catch-all sits far below all of them so
 * that prompt-like text in the scrollback can never outrank live chrome.
 */
export const CLAUDE: Manifest = {
	id: "claude",
	version: "2026.08.13.1",
	rules: [
		{
			id: "osc_title_working",
			state: "working",
			priority: 1100,
			region: "osc_title",
			visibleWorking: true,
			// Braille covers <= 2.1.227; half-circles are the 2.1.228 busy spinner.
			regex: [/^[⠀-⣿◐-◓] /u],
		},
		{
			/**
			 * The footer that offers to interrupt — the durable "it is busy".
			 *
			 * Added by DevHub, not carried from herdr. Up to v2.1.227 Claude
			 * Code spun a braille wheel in its title and `osc_title_working`
			 * above was the whole of how working was told from idle. Current
			 * versions put a static marker and the branch in the title in every
			 * state, so that rule cannot fire and nothing else said "working" —
			 * the row read idle for the entire length of a turn.
			 *
			 * The screen still says it, in the one place that has stayed put
			 * across the redesigns: while a turn is running the footer offers
			 * `esc to interrupt`, and when it is over it offers shortcuts
			 * instead. That is chrome about the live turn rather than text that
			 * scrolled by, which is what makes it safe to read.
			 *
			 * It outranks `live_prompt_box` because the prompt box is now drawn
			 * and typeable *while* the Agent works — a person can queue their
			 * next message — so "there is a prompt box" stopped meaning idle.
			 * It stays below the blocked rules, and refuses outright on a
			 * screen that is asking a question, because a turn that has paused
			 * for a person is not a turn that is running.
			 */
			id: "screen_working_footer",
			state: "working",
			priority: 960,
			region: bottomNonEmptyLines(5),
			visibleWorking: true,
			contains: ["esc to interrupt"],
			not: [{ contains: ["do you want to"] }],
		},
		{
			id: "btw_overlay_working",
			state: "working",
			priority: 975,
			region: bottomNonEmptyLines(5),
			visibleWorking: true,
			lineRegex: [/^\s*\/btw(?:\s|$)/u, /esc to close\s*$/iu],
		},
		{
			id: "transcript_viewer",
			state: "unknown",
			priority: 1000,
			region: bottomNonEmptyLines(3),
			skipStateUpdate: true,
			contains: ["showing detailed transcript"],
			any: [
				{ contains: ["ctrl+o", "to toggle"] },
				{ contains: ["ctrl+e", "show all"] },
				{ contains: ["ctrl+e", "collapse"] },
				{ contains: ["↑↓ scroll"] },
				{ contains: ["? for shortcuts"] },
			],
		},
		{
			id: "live_blocked_form",
			state: "blocked",
			priority: 980,
			region: "after_last_horizontal_rule",
			visibleBlocker: true,
			contains: ["esc to cancel"],
			any: [
				{ contains: ["enter to confirm"] },
				{
					contains: ["enter to select"],
					any: [
						{ contains: ["tab/arrow keys to navigate"] },
						{ contains: ["arrow keys to navigate"] },
						{ contains: ["arrows to navigate"] },
						{ contains: ["↑/↓ to navigate"] },
						{ contains: ["↑↓ to navigate"] },
					],
				},
			],
		},
		{
			id: "dynamic_workflow_prompt",
			state: "blocked",
			priority: 980,
			region: "whole_recent",
			visibleBlocker: true,
			contains: ["run a dynamic workflow?", "esc to cancel"],
		},
		{
			id: "live_prompt_box",
			state: "idle",
			priority: 950,
			region: "prompt_box_body",
			visibleIdle: true,
			lineRegex: [/^\s*❯/u],
			not: [
				// The box is drawn and typeable while the Agent works, so its
				// presence is no longer evidence of anything on its own.
				{ contains: ["esc to interrupt"] },
				{ contains: ["enter to select"] },
				{ contains: ["esc to cancel"] },
				{ contains: ["tab/arrow keys"] },
				{ contains: ["arrow keys to navigate"] },
				{ contains: ["↑/↓ to navigate"] },
			],
		},
		{
			id: "model_picker_menu",
			state: "unknown",
			priority: 900,
			region: "whole_recent",
			skipStateUpdate: true,
			contains: ["select model", "enter to set as default", "esc to cancel"],
			not: [
				{ contains: ["do you want to proceed?"] },
				{ contains: ["enter to select"] },
			],
		},
		{
			id: "bash_permission_prompt",
			state: "blocked",
			priority: 850,
			region: "whole_recent",
			visibleBlocker: true,
			contains: ["do you want to proceed?"],
			any: [
				{ contains: ["bash command"] },
				{ contains: ["bash("] },
				{ contains: ["contains expansion"] },
				{ contains: ["tab to amend"] },
				{ contains: ["ctrl+e to explain"] },
			],
			all: [
				{
					any: [
						{ lineRegex: [/^\s*❯?\s*yes\b/iu] },
						{ lineRegex: [/^\s*1\.\s*yes\b/iu] },
						{ lineRegex: [/^\s*2\.\s*no\b/iu] },
					],
				},
			],
		},
		{
			id: "generic_permission_prompt",
			state: "blocked",
			priority: 840,
			region: "after_last_horizontal_rule",
			visibleBlocker: true,
			contains: ["do you want to proceed?", "esc to cancel"],
			all: [
				{
					any: [
						{ lineRegex: [/^\s*❯?\s*1\.\s*yes\b/iu] },
						{ lineRegex: [/^\s*2\.\s*yes\b/iu] },
						{ lineRegex: [/^\s*2\.\s*no\b/iu] },
						{ lineRegex: [/^\s*3\.\s*no\b/iu] },
					],
				},
			],
		},
		{
			/**
			 * A numbered question, whatever it is asking about.
			 *
			 * Added by DevHub. The two rules above were written for the one
			 * wording they knew — "Do you want to proceed?" with "esc to
			 * cancel" — and a current Claude Code asks in that shape for a
			 * command but in others elsewhere: a network request asks "Do you
			 * want to allow this connection?" over a numbered list and offers
			 * no "esc to cancel" line at all. Those screens fell through to
			 * `legacy_no_prompt_blocker`, which does say blocked, but carries
			 * no `visibleBlocker` — so the row waited out the full debounce
			 * before admitting that an Agent had stopped for a person, and
			 * nothing downstream could tell a live question from a sentence in
			 * the scrollback that happened to read like one.
			 *
			 * What is actually common to all of them is the shape rather than
			 * the wording: a question, and directly under it a numbered list
			 * whose first option is yes. That is live chrome — it is below the
			 * last rule the screen drew — so it is declared visible, and it
			 * outranks the working footer because a turn that has paused for an
			 * answer is not a turn that is running.
			 */
			id: "numbered_permission_prompt",
			state: "blocked",
			priority: 990,
			region: "after_last_horizontal_rule",
			visibleBlocker: true,
			contains: ["do you want to"],
			all: [
				{
					any: [
						{ lineRegex: [/^\s*❯?\s*1\.\s*yes\b/iu] },
						{ lineRegex: [/^\s*❯?\s*\d\.\s*no\b/iu] },
					],
				},
			],
		},
		{
			id: "legacy_no_prompt_blocker",
			state: "blocked",
			priority: 300,
			region: "whole_recent",
			any: [
				{
					contains: ["do you want to"],
					any: [{ contains: ["yes"] }, { contains: ["❯"] }],
				},
				{
					contains: ["would you like to"],
					any: [{ contains: ["yes"] }, { contains: ["❯"] }],
				},
				{ contains: ["waiting for permission"] },
				{ contains: ["do you want to allow this connection?"] },
				{ contains: ["tab to amend"] },
				{ contains: ["ctrl+e to explain"] },
				{ contains: ["do you want to proceed?", "esc to cancel"] },
				{ contains: ["review your answers"] },
				{ contains: ["skip interview and plan immediately"] },
			],
			not: [{ lineRegex: [/^\s*❯\s*$/u] }],
		},
		/*
		 * herdr's `osc_title_idle` — an idle claim on a title beginning `✳ ` —
		 * is deliberately not here.
		 *
		 * That marker used to mean idle because the title carried a spinner
		 * while working. It now sits in the title in *every* state, so the rule
		 * matched always and, being the lowest-priority thing in the manifest,
		 * it decided every screen no other rule recognised. A stale manifest
		 * therefore did not degrade to "I cannot tell" — it reported, with no
		 * hedge, that the Agent was done and waiting for you.
		 *
		 * That is the worst direction to fail in. Idle is the actionable state:
		 * it is what the row invites you to act on and what the injection queue
		 * waits for before it sends an Agent its next instruction. A wrong
		 * `working` costs a moment of patience; a wrong `idle` types into a
		 * running turn. So idle is claimed only from the live prompt box, which
		 * is positive evidence on the screen, and a screen the rules do not
		 * describe now reads `unknown` — which the sidebar draws as `?` and the
		 * queue refuses to send on.
		 */
		{
			id: "osc_progress_idle",
			state: "idle",
			priority: 250,
			region: "osc_progress",
			regex: [/^4;0/u],
		},
	],
};

/** Codex. */
export const CODEX: Manifest = {
	id: "codex",
	version: "2026.08.09.1",
	rules: [
		{
			id: "osc_title_blocked",
			state: "blocked",
			priority: 1100,
			region: "osc_title",
			visibleBlocker: true,
			contains: ["action required"],
		},
		{
			id: "osc_title_working",
			state: "working",
			priority: 1050,
			region: "osc_title",
			visibleWorking: true,
			regex: [/(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)/u],
		},
		{
			id: "transcript_viewer",
			state: "unknown",
			priority: 1000,
			region: "after_last_prompt_marker",
			skipStateUpdate: true,
			contains: [
				"↑/↓ to scroll",
				"pgup/pgdn to",
				"home/end to jump",
				"q to quit",
			],
			any: [
				{ contains: ["esc to edit prev"] },
				{ contains: ["esc/← to edit prev"] },
			],
		},
		{
			id: "trust_directory",
			state: "blocked",
			priority: 950,
			region: topNonEmptyLines(20),
			visibleBlocker: true,
			all: [
				{ regex: [/^> You are in [^\r\n]+(?:\r?\n|$)/u] },
				{
					regex: [
						/Do\s+you\s+trust\s+the\s+contents\s+of\s+this\s+directory\?/su,
					],
				},
			],
		},
		{
			id: "live_strong_blocker",
			state: "blocked",
			priority: 900,
			region: "after_last_prompt_marker",
			visibleBlocker: true,
			any: [
				{ contains: ["press enter to confirm or esc to cancel"] },
				{ contains: ["enter to submit answer"] },
				{ contains: ["enter to submit all"] },
				{ contains: ["allow command?"] },
			],
		},
		{
			id: "weak_blocker",
			state: "blocked",
			priority: 600,
			region: "whole_recent",
			any: [
				{ contains: ["[y/n]"] },
				{ contains: ["yes (y)"] },
				{
					contains: ["do you want to"],
					any: [{ contains: ["yes"] }, { contains: ["❯"] }],
				},
				{
					contains: ["would you like to"],
					any: [{ contains: ["yes"] }, { contains: ["❯"] }],
				},
			],
		},
		{
			id: "screen_working_fallback",
			state: "working",
			priority: 500,
			region: bottomNonEmptyLines(3),
			visibleWorking: true,
			lineRegex: [/^[•◦]\s+Working \([^)]*esc to interrupt\)(?: · .*)?$/u],
			not: [{ contains: ["■ conversation interrupted"] }],
		},
		{
			id: "osc_title_idle",
			state: "idle",
			priority: 100,
			region: "osc_title",
			visibleIdle: true,
			regex: [/\S/u],
			not: [
				{ regex: [/(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)/u] },
				{ contains: ["action required"] },
			],
		},
	],
};

/**
 * The manifest for a profile kind, or nothing.
 *
 * Nothing is the answer for `custom`, and it is a permanent one: a profile that
 * names a command and no known screen has no detector, its status stays
 * `unknown`, and the row says so with the `?` mark. That is the whole of the
 * "attach anything" feature — no manifest, no guessing.
 */
export function manifestFor(kind: string): Manifest | undefined {
	if (kind === "claude") return CLAUDE;
	if (kind === "codex") return CODEX;
	return undefined;
}
