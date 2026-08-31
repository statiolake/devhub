/**
 * The screen-rule engine that reads an Agent's status off its own pane.
 *
 * Ported from the herdr project (https://github.com/herdrdev/herdr), files
 * `src/detect/mod.rs` and `src/detect/manifest.rs`, which are licensed under
 * the Apache License, Version 2.0. The rule model — screen regions, prioritised
 * rules, nested all/any/not gates, and the `visible_*` / `skip_state_update`
 * metadata — is herdr's design, carried over unchanged in shape. See
 * `distribution/THIRD-PARTY-NOTICES.txt`. herdr ships no NOTICE file, so there
 * is none to reproduce.
 *
 * What is not ported: herdr's manifest downloader, its per-agent process
 * identification (DevHub already knows which command it launched), its
 * explain/diagnostic projection, and the twenty manifests DevHub has no profile
 * for. What remains is the engine and the two manifests DevHub ships.
 *
 * The engine is deliberately pure: screen text in, a reading out. Nothing here
 * captures a pane, times anything, or remembers a previous answer — that is
 * `detector.ts`, so that a reading can be tested against a transcript with no
 * tmux anywhere near it.
 */

/**
 * What a rule can say about the screen.
 *
 * These are herdr's four states. DevHub's own `AgentStatus` has an `error` that
 * has no rule: no screen says "this went wrong", only DevHub's own runtime
 * does, so the mapping is made where the two meet and not here.
 */
export type ScreenState = "idle" | "working" | "blocked" | "unknown";

/** What the detector reads: the pane, plus the two OSC strings it carries. */
export interface DetectionInput {
	readonly screen: string;
	readonly oscTitle: string;
	readonly oscProgress: string;
}

/**
 * A test over one region's text.
 *
 * `contains` is case-insensitive and every needle must be present; `regex` must
 * match somewhere in the region; `line_regex` must match some single line.
 * Nested `all`/`any`/`not` are herdr's, with herdr's emptiness rule: an empty
 * `all` or `not` passes, an empty `any` is not a constraint at all.
 */
export interface Gate {
	readonly contains?: readonly string[];
	readonly regex?: readonly RegExp[];
	readonly lineRegex?: readonly RegExp[];
	readonly all?: readonly Gate[];
	readonly any?: readonly Gate[];
	readonly not?: readonly Gate[];
}

export interface Rule extends Gate {
	readonly id: string;
	readonly state: ScreenState;
	readonly priority: number;
	readonly region: RegionSpec;
	/** This screen visibly shows live idle chrome. */
	readonly visibleIdle?: boolean;
	/** This screen visibly shows chrome that is waiting on a person. */
	readonly visibleBlocker?: boolean;
	/** This screen visibly shows live working chrome. */
	readonly visibleWorking?: boolean;
	/**
	 * The screen is an Agent-owned viewer showing history rather than the live
	 * prompt. The reading is not news about what the Agent is doing, so the
	 * caller keeps the status it already had.
	 */
	readonly skipStateUpdate?: boolean;
}

export interface Manifest {
	readonly id: string;
	readonly version: string;
	readonly rules: readonly Rule[];
}

export interface Reading {
	readonly state: ScreenState;
	readonly skipStateUpdate: boolean;
	readonly visibleIdle: boolean;
	readonly visibleBlocker: boolean;
	readonly visibleWorking: boolean;
	/** Which rule decided, for a test to name and a log line to carry. */
	readonly matchedRuleId: string | undefined;
}

export const UNREAD: Reading = {
	state: "unknown",
	skipStateUpdate: false,
	visibleIdle: false,
	visibleBlocker: false,
	visibleWorking: false,
	matchedRuleId: undefined,
};

// --- Regions ---------------------------------------------------------------

/**
 * Which part of the screen a rule reads.
 *
 * Only the regions the two shipped manifests use are here. herdr has more, and
 * adding one is adding a case below — but an unused region is a case nothing
 * exercises, and this file would rather have a manifest fail to load than carry
 * five regions no rule reads.
 */
export type RegionSpec =
	| "whole_recent"
	| "osc_title"
	| "osc_progress"
	| "prompt_box_body"
	| "after_last_horizontal_rule"
	| "after_last_prompt_marker"
	| { readonly kind: "bottom_non_empty_lines"; readonly count: number }
	| { readonly kind: "top_non_empty_lines"; readonly count: number };

export function bottomNonEmptyLines(count: number): RegionSpec {
	return { kind: "bottom_non_empty_lines", count };
}

export function topNonEmptyLines(count: number): RegionSpec {
	return { kind: "top_non_empty_lines", count };
}

export function region(input: DetectionInput, spec: RegionSpec): string {
	// The OSC regions come from their own fields. A terminal's title is not
	// part of its screen, and a rule that reads one must not accidentally match
	// the other.
	if (spec === "osc_title") return input.oscTitle;
	if (spec === "osc_progress") return input.oscProgress;
	const content = input.screen;
	if (spec === "whole_recent") return content;
	if (spec === "prompt_box_body") return promptBoxBody(content);
	if (spec === "after_last_horizontal_rule") {
		return afterLastHorizontalRule(content);
	}
	if (spec === "after_last_prompt_marker")
		return afterLastPromptMarker(content);
	const lines = content.split("\n");
	if (spec.kind === "bottom_non_empty_lines") {
		return sliceLines(
			lines,
			lastNonEmptyStart(lines, spec.count),
			lines.length,
		);
	}
	return sliceLines(lines, 0, firstNonEmptyEnd(lines, spec.count));
}

function sliceLines(
	lines: readonly string[],
	start: number,
	end: number,
): string {
	if (start >= end) return "";
	return lines.slice(start, end).join("\n");
}

function lastNonEmptyStart(lines: readonly string[], count: number): number {
	let seen = 0;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (lines[index]?.trim().length === 0) continue;
		seen += 1;
		if (seen === count) return index;
	}
	return seen === 0 ? lines.length : 0;
}

function firstNonEmptyEnd(lines: readonly string[], count: number): number {
	let seen = 0;
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index]?.trim().length === 0) continue;
		seen += 1;
		if (seen === count) return index + 1;
	}
	return seen === 0 ? 0 : lines.length;
}

/**
 * A run of box-drawing horizontals, which is how both CLIs draw a border.
 *
 * herdr's rule exactly: a line that is nothing but the rule character, or one
 * that starts with at least three of them.
 */
function isHorizontalRule(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.length === 0) return false;
	let count = 0;
	while (trimmed[count] === "─") count += 1;
	if (count === 0) return false;
	return trimmed.slice(count).trimStart().length === 0 || count >= 3;
}

function afterLastHorizontalRule(content: string): string {
	const lines = content.split("\n");
	let after = 0;
	for (let index = 0; index < lines.length; index += 1) {
		if (isHorizontalRule(lines[index] ?? "")) after = index + 1;
	}
	return sliceLines(lines, after, lines.length);
}

/**
 * The inside of the prompt box: between the last two horizontal rules.
 *
 * Claude Code draws its input box as two borders with the prompt between them,
 * so the *second* rule counting back from the bottom is the box's top edge.
 */
function promptBoxBody(content: string): string {
	const lines = content.split("\n");
	let borders = 0;
	let top = -1;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (!isHorizontalRule(lines[index] ?? "")) continue;
		borders += 1;
		if (borders === 2) {
			top = index;
			break;
		}
	}
	if (top < 0) return "";
	let end = lines.length;
	for (let index = top + 1; index < lines.length; index += 1) {
		if (isHorizontalRule(lines[index] ?? "")) {
			end = index;
			break;
		}
	}
	return sliceLines(lines, top + 1, end);
}

/** Codex's prompt line, and everything printed after it. */
function afterLastPromptMarker(content: string): string {
	const lines = content.split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index] ?? "";
		if (line === "›" || line.startsWith("› ")) {
			return sliceLines(lines, index + 1, lines.length);
		}
	}
	return content;
}

// --- Matching --------------------------------------------------------------

export function gateMatches(gate: Gate, text: string, lower: string): boolean {
	if (gate.contains?.some((needle) => !lower.includes(needle))) return false;
	if (gate.regex?.some((pattern) => !matches(pattern, text))) return false;
	if (
		gate.lineRegex?.some(
			(pattern) => !text.split("\n").some((line) => matches(pattern, line)),
		)
	) {
		return false;
	}
	if (gate.all?.some((nested) => !gateMatches(nested, text, lower))) {
		return false;
	}
	if (
		gate.any !== undefined &&
		gate.any.length > 0 &&
		!gate.any.some((nested) => gateMatches(nested, text, lower))
	) {
		return false;
	}
	if (gate.not?.some((nested) => gateMatches(nested, text, lower))) {
		return false;
	}
	return true;
}

/**
 * A regular expression used as a predicate.
 *
 * `lastIndex` is reset because a manifest pattern is reused across every
 * reading, and a sticky or global one would otherwise answer differently the
 * second time it was asked about the same text.
 */
function matches(pattern: RegExp, text: string): boolean {
	pattern.lastIndex = 0;
	return pattern.test(text);
}

/**
 * Read one screen.
 *
 * Every rule is evaluated and the highest priority that matched wins; ties go
 * to the earlier rule, which is herdr's order and is why a manifest's rules are
 * written most-specific first. No rule matching is not a failure — it is
 * `unknown`, which is the honest answer for a screen the manifest does not
 * describe.
 */
export function read(manifest: Manifest, input: DetectionInput): Reading {
	let winner: Rule | undefined;
	for (const rule of manifest.rules) {
		const text = region(input, rule.region);
		if (!gateMatches(rule, text, text.toLowerCase())) continue;
		if (winner !== undefined && winner.priority >= rule.priority) continue;
		winner = rule;
	}
	if (winner === undefined) return UNREAD;
	return {
		state: winner.state,
		skipStateUpdate: winner.skipStateUpdate === true,
		// The `visible_*` flags only mean anything when the rule's own state
		// agrees with them, which is herdr's rule and keeps a mislabelled
		// manifest from claiming a blocker on an idle screen.
		visibleIdle: winner.visibleIdle === true && winner.state === "idle",
		visibleBlocker:
			winner.visibleBlocker === true && winner.state === "blocked",
		visibleWorking:
			winner.visibleWorking === true && winner.state === "working",
		matchedRuleId: winner.id,
	};
}
