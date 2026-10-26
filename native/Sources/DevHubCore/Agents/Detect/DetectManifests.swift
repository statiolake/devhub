// Port of apps/desktop/src/main/agent/detect/manifests.ts.
//
// The screen manifests DevHub ships, for the Agent kinds it knows.
//
// Carried (through the TS port) from the herdr project
// (https://github.com/herdrdev/herdr), files `src/detect/manifests/claude.toml`
// (version 2026.08.13.1), `src/detect/manifests/codex.toml` (version
// 2026.08.09.1) and `src/detect/manifests/cursor.toml` (version 2026.08.03.1),
// licensed under the Apache License, Version 2.0. See
// `distribution/THIRD-PARTY-NOTICES.txt` in the repository.
//
// They are code rather than TOML on purpose: herdr updates its manifests from
// a server at runtime; DevHub does not, so a rule that names a region the
// engine does not have fails to compile. The rule ids, priorities, regions and
// patterns are herdr's (and DevHub's additions are marked), unchanged.

import Foundation

private func pattern(_ source: String, i: Bool = false, s: Bool = false) -> ScreenPattern {
    ScreenPattern(source, caseInsensitive: i, dotAll: s)
}

public enum DetectManifests {
    /// Claude Code.
    ///
    /// Read top-down: the title spinner beats everything, the blocked forms
    /// beat the idle prompt box, and the legacy catch-all sits far below all of
    /// them so that prompt-like text in the scrollback can never outrank live
    /// chrome.
    public static let claude = Manifest(id: "claude", version: "2026.08.13.1", rules: [
        Rule(
            id: "osc_title_working", state: .working, priority: 1100, region: .oscTitle,
            visibleWorking: true,
            // Braille covers <= 2.1.227; half-circles are the 2.1.228 busy spinner.
            regex: [pattern("^[⠀-⣿◐-◓] ")]
        ),
        // The footer that offers to interrupt — the durable "it is busy".
        //
        // Added by DevHub, not carried from herdr. Current Claude Code versions
        // put a static marker in the title in every state, so the title rule
        // cannot fire; while a turn is running the footer offers `esc to
        // interrupt`. It outranks `live_prompt_box` because the prompt box is
        // drawn and typeable *while* the Agent works, stays below the blocked
        // rules, and reads everything below the prompt box rather than the last
        // few lines, because background agents are listed underneath the
        // footer with no bound on how many.
        Rule(
            id: "screen_working_footer", state: .working, priority: 960, region: .afterLastHorizontalRule,
            visibleWorking: true,
            contains: ["esc to interrupt"],
            not: [Gate(contains: ["do you want to"])]
        ),
        Rule(
            id: "btw_overlay_working", state: .working, priority: 975, region: .bottomNonEmptyLines(5),
            visibleWorking: true,
            lineRegex: [pattern(#"^\s*/btw(?:\s|$)"#), pattern(#"esc to close\s*$"#, i: true)]
        ),
        Rule(
            id: "transcript_viewer", state: .unknown, priority: 1000, region: .bottomNonEmptyLines(3),
            skipStateUpdate: true,
            contains: ["showing detailed transcript"],
            any: [
                Gate(contains: ["ctrl+o", "to toggle"]),
                Gate(contains: ["ctrl+e", "show all"]),
                Gate(contains: ["ctrl+e", "collapse"]),
                Gate(contains: ["↑↓ scroll"]),
                Gate(contains: ["? for shortcuts"]),
            ]
        ),
        Rule(
            id: "live_blocked_form", state: .blocked, priority: 980, region: .afterLastHorizontalRule,
            visibleBlocker: true,
            contains: ["esc to cancel"],
            any: [
                Gate(contains: ["enter to confirm"]),
                Gate(contains: ["enter to select"], any: [
                    Gate(contains: ["tab/arrow keys to navigate"]),
                    Gate(contains: ["arrow keys to navigate"]),
                    Gate(contains: ["arrows to navigate"]),
                    Gate(contains: ["↑/↓ to navigate"]),
                    Gate(contains: ["↑↓ to navigate"]),
                ]),
            ]
        ),
        Rule(
            id: "dynamic_workflow_prompt", state: .blocked, priority: 980, region: .wholeRecent,
            visibleBlocker: true,
            contains: ["run a dynamic workflow?", "esc to cancel"]
        ),
        Rule(
            id: "live_prompt_box", state: .idle, priority: 950, region: .promptBoxBody,
            visibleIdle: true,
            lineRegex: [pattern(#"^\s*❯"#)],
            not: [
                // The box is drawn and typeable while the Agent works, so its
                // presence is no longer evidence of anything on its own.
                Gate(contains: ["esc to interrupt"]),
                Gate(contains: ["enter to select"]),
                Gate(contains: ["esc to cancel"]),
                Gate(contains: ["tab/arrow keys"]),
                Gate(contains: ["arrow keys to navigate"]),
                Gate(contains: ["↑/↓ to navigate"]),
            ]
        ),
        Rule(
            id: "model_picker_menu", state: .unknown, priority: 900, region: .wholeRecent,
            skipStateUpdate: true,
            contains: ["select model", "enter to set as default", "esc to cancel"],
            not: [Gate(contains: ["do you want to proceed?"]), Gate(contains: ["enter to select"])]
        ),
        Rule(
            id: "bash_permission_prompt", state: .blocked, priority: 850, region: .wholeRecent,
            visibleBlocker: true,
            contains: ["do you want to proceed?"],
            all: [Gate(any: [
                Gate(lineRegex: [pattern(#"^\s*❯?\s*yes\b"#, i: true)]),
                Gate(lineRegex: [pattern(#"^\s*1\.\s*yes\b"#, i: true)]),
                Gate(lineRegex: [pattern(#"^\s*2\.\s*no\b"#, i: true)]),
            ])],
            any: [
                Gate(contains: ["bash command"]),
                Gate(contains: ["bash("]),
                Gate(contains: ["contains expansion"]),
                Gate(contains: ["tab to amend"]),
                Gate(contains: ["ctrl+e to explain"]),
            ]
        ),
        Rule(
            id: "generic_permission_prompt", state: .blocked, priority: 840, region: .afterLastHorizontalRule,
            visibleBlocker: true,
            contains: ["do you want to proceed?", "esc to cancel"],
            all: [Gate(any: [
                Gate(lineRegex: [pattern(#"^\s*❯?\s*1\.\s*yes\b"#, i: true)]),
                Gate(lineRegex: [pattern(#"^\s*2\.\s*yes\b"#, i: true)]),
                Gate(lineRegex: [pattern(#"^\s*2\.\s*no\b"#, i: true)]),
                Gate(lineRegex: [pattern(#"^\s*3\.\s*no\b"#, i: true)]),
            ])]
        ),
        // A numbered question, whatever it is asking about.
        //
        // Added by DevHub. A current Claude Code asks for a network request
        // "Do you want to allow this connection?" over a numbered list and
        // offers no "esc to cancel" line at all. What is common to all of them
        // is the shape: a question, and directly under it a numbered list whose
        // first option is yes. That is live chrome — below the last rule the
        // screen drew — so it is declared visible, and it outranks the working
        // footer because a turn that has paused for an answer is not running.
        Rule(
            id: "numbered_permission_prompt", state: .blocked, priority: 990, region: .afterLastHorizontalRule,
            visibleBlocker: true,
            contains: ["do you want to"],
            all: [Gate(any: [
                Gate(lineRegex: [pattern(#"^\s*❯?\s*1\.\s*yes\b"#, i: true)]),
                Gate(lineRegex: [pattern(#"^\s*❯?\s*[0-9]\.\s*no\b"#, i: true)]),
            ])]
        ),
        Rule(
            id: "legacy_no_prompt_blocker", state: .blocked, priority: 300, region: .wholeRecent,
            any: [
                Gate(contains: ["do you want to"], any: [Gate(contains: ["yes"]), Gate(contains: ["❯"])]),
                Gate(contains: ["would you like to"], any: [Gate(contains: ["yes"]), Gate(contains: ["❯"])]),
                Gate(contains: ["waiting for permission"]),
                Gate(contains: ["do you want to allow this connection?"]),
                Gate(contains: ["tab to amend"]),
                Gate(contains: ["ctrl+e to explain"]),
                Gate(contains: ["do you want to proceed?", "esc to cancel"]),
                Gate(contains: ["review your answers"]),
                Gate(contains: ["skip interview and plan immediately"]),
            ],
            not: [Gate(lineRegex: [pattern(#"^\s*❯\s*$"#)])]
        ),
        // herdr's `osc_title_idle` — an idle claim on a title beginning `✳ ` —
        // is deliberately not here. That marker now sits in the title in *every*
        // state, so the rule matched always and decided every screen no other
        // rule recognised. Idle is the actionable state — what the injection
        // queue waits for before it types — so idle is claimed only from the
        // live prompt box, and a screen the rules do not describe reads
        // `unknown`.
        Rule(
            id: "osc_progress_idle", state: .idle, priority: 250, region: .oscProgress,
            regex: [pattern("^4;0")]
        ),
    ])

    /// Codex.
    public static let codex = Manifest(id: "codex", version: "2026.08.09.1", rules: [
        Rule(
            id: "osc_title_blocked", state: .blocked, priority: 1100, region: .oscTitle,
            visibleBlocker: true,
            contains: ["action required"]
        ),
        Rule(
            id: "osc_title_working", state: .working, priority: 1050, region: .oscTitle,
            visibleWorking: true,
            regex: [pattern("(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)")]
        ),
        Rule(
            id: "transcript_viewer", state: .unknown, priority: 1000, region: .afterLastPromptMarker,
            skipStateUpdate: true,
            contains: ["↑/↓ to scroll", "pgup/pgdn to", "home/end to jump", "q to quit"],
            any: [Gate(contains: ["esc to edit prev"]), Gate(contains: ["esc/← to edit prev"])]
        ),
        Rule(
            id: "trust_directory", state: .blocked, priority: 950, region: .topNonEmptyLines(20),
            visibleBlocker: true,
            all: [
                Gate(regex: [pattern(#"^> You are in [^\r\n]+(?:\r?\n|$)"#)]),
                Gate(regex: [pattern(#"Do\s+you\s+trust\s+the\s+contents\s+of\s+this\s+directory\?"#, s: true)]),
            ]
        ),
        Rule(
            id: "live_strong_blocker", state: .blocked, priority: 900, region: .afterLastPromptMarker,
            visibleBlocker: true,
            any: [
                Gate(contains: ["press enter to confirm or esc to cancel"]),
                Gate(contains: ["enter to submit answer"]),
                Gate(contains: ["enter to submit all"]),
                Gate(contains: ["allow command?"]),
            ]
        ),
        Rule(
            id: "weak_blocker", state: .blocked, priority: 600, region: .wholeRecent,
            any: [
                Gate(contains: ["[y/n]"]),
                Gate(contains: ["yes (y)"]),
                Gate(contains: ["do you want to"], any: [Gate(contains: ["yes"]), Gate(contains: ["❯"])]),
                Gate(contains: ["would you like to"], any: [Gate(contains: ["yes"]), Gate(contains: ["❯"])]),
            ]
        ),
        Rule(
            id: "screen_working_fallback", state: .working, priority: 500, region: .bottomNonEmptyLines(3),
            visibleWorking: true,
            lineRegex: [pattern(#"^[•◦]\s+Working \([^)]*esc to interrupt\)(?: · .*)?$"#)],
            not: [Gate(contains: ["■ conversation interrupted"])]
        ),
        // A numbered menu waiting for a choice, whatever it is asking.
        //
        // Added by DevHub. Codex asks more than one question this way before it
        // is ready — whether to install an update (whose first option runs
        // `curl … | sh`), whether the directory is trusted — so a screen like
        // this is the last place anything should be typed. Recognised by its
        // shape: a numbered list, and a line telling the person to press Return.
        Rule(
            id: "numbered_choice_prompt", state: .blocked, priority: 700, region: .wholeRecent,
            visibleBlocker: true,
            contains: ["press enter to continue"],
            all: [Gate(any: [
                Gate(lineRegex: [pattern(#"^\s*›\s*[0-9]+\.\s"#)]),
                Gate(lineRegex: [pattern(#"^\s*[0-9]+\.\s"#)]),
            ])]
        ),
        // Idle, read off the screen — and only when Codex is really ready.
        //
        // Replaces herdr's `osc_title_idle`, which claimed idle for *any*
        // non-empty title that was not a spinner — every startup screen, and
        // both of the questions above. Idle is claimed from the composer, with
        // a turn still running, a model still loading and a question still
        // waiting ruled out. When a person has typed something themselves the
        // placeholder is gone and this does not match: DevHub must not type
        // over their draft.
        Rule(
            id: "live_composer_idle", state: .idle, priority: 400, region: .wholeRecent,
            visibleIdle: true,
            lineRegex: [pattern(#"^\s*›\s+Ask Codex to do anything\s*$"#)],
            not: [
                Gate(contains: ["esc to interrupt"]),
                Gate(regex: [pattern(#"\bmodel:\s+loading\b"#)]),
                Gate(contains: ["press enter to continue"]),
            ]
        ),
    ])

    /// Cursor Agent (`cursor-agent`), herdr's `cursor.toml` 2026.08.03.1, rules
    /// unchanged.
    ///
    /// **This one has not been checked against a screen** (running
    /// `cursor-agent` needs a Cursor subscription). **There is deliberately no
    /// idle rule**: herdr's manifest has none either, and `idle` is the single
    /// state the injection queue sends on, so a manifest that cannot say the
    /// word cannot cause DevHub to type into a Cursor pane, whatever the screen
    /// turns out to look like.
    public static let cursor = Manifest(id: "cursor", version: "2026.08.03.1", rules: [
        Rule(
            id: "write_file_approval", state: .blocked, priority: 320, region: .bottomNonEmptyLines(8),
            visibleBlocker: true,
            contains: ["write to this file?", "proceed (y)"],
            any: [
                Gate(contains: ["reject & propose changes"]),
                Gate(contains: ["esc or n or p"]),
                Gate(contains: ["add write("]),
            ]
        ),
        Rule(
            id: "approval_prompt", state: .blocked, priority: 300, region: .wholeRecent,
            visibleBlocker: true,
            any: [
                Gate(contains: ["waiting for approval", "run this command?"], any: [
                    Gate(contains: ["run (once) (y)"]),
                    Gate(contains: ["skip (esc or n)"]),
                ]),
                Gate(contains: ["(y) (enter)"]),
                Gate(lineRegex: [pattern(#"^\s*allow .*\(y\)"#, i: true)]),
                Gate(contains: ["keep (n)"]),
                Gate(contains: ["skip (esc or n)"]),
                Gate(lineRegex: [pattern(#"^\s*(?:→\s*)?run .*\(y\)"#, i: true)]),
            ]
        ),
        Rule(
            id: "stop_hint_working", state: .working, priority: 100, region: .bottomNonEmptyLines(6),
            visibleWorking: true,
            contains: ["ctrl+c to stop"]
        ),
        Rule(
            id: "background_task_status_working", state: .working, priority: 95, region: .bottomNonEmptyLines(5),
            visibleWorking: true,
            lineRegex: [pattern(#"\b[1-9][0-9]*\s+background\s+tasks?\b"#, i: true)]
        ),
        Rule(
            id: "spinner_working", state: .working, priority: 90, region: .bottomNonEmptyLines(8),
            visibleWorking: true,
            lineRegex: [pattern(#"^\s*(?:⬡|⬢|[⠀-⣿]+)\s+\p{Alphabetic}+[A-Za-z0-9_]*ing\b"#)]
        ),
    ])

    /// The manifest for a profile kind, or nothing. Nothing is the answer for
    /// `custom`, and it is a permanent one: its status stays `unknown`.
    public static func manifest(for kind: String) -> Manifest? {
        switch kind {
        case "claude": return claude
        case "codex": return codex
        case "cursor": return cursor
        default: return nil
        }
    }
}
