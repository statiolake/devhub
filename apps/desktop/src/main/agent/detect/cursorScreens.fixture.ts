/**
 * Screens for the Cursor manifest — and an honest note about where they came
 * from, because it is not where the Claude and Codex fixtures came from.
 *
 * Those two are transcripts: `capture-pane -p -J` output from a real CLI, kept
 * byte-for-byte so the tests describe a screen that actually appeared. These
 * are not, with one exception noted below. Running `cursor-agent` past its
 * login needs a Cursor subscription, which this project does not have, so the
 * blocked and working screens here are *constructed* from the text herdr's
 * `cursor.toml` matches on — they are the rules restated as screens.
 *
 * That makes them worth much less than a capture, and it is important to be
 * clear about which question they can answer. They cannot tell us the rules are
 * right about Cursor; only a capture does that. What they do pin is everything
 * that is true regardless of what Cursor draws:
 *
 * - the rules were transcribed from TOML to TypeScript without a typo, which is
 *   the one failure this port could introduce on its own;
 * - the manifest cannot say `idle` — not for these screens, not for a blank
 *   one, not for anything (see `cursorScreens.test.ts`), which is the property
 *   that keeps an unverified manifest from being dangerous rather than merely
 *   unhelpful;
 * - an unrecognised screen reads `unknown`, so drift costs a `?` and never a
 *   keystroke.
 *
 * If somebody with a subscription reads this: please replace these with real
 * captures and delete this paragraph.
 */

export interface CursorScreen {
	readonly oscTitle: string;
	readonly screen: string;
}

/**
 * The one screen here that is real.
 *
 * Captured from `cursor-agent` v2026.08.25 in tmux, with the hostname
 * generalised and nothing else touched. It is the splash shown before the CLI
 * has confirmed who you are, which is reachable without a subscription — and
 * it is the reason this fixture file can say anything at all about startup.
 *
 * Two things it settles. The title is `example-host`: the shell's, not
 * Cursor's, exactly as with Codex, so nothing in this manifest may be keyed on
 * the title. And no rule matches it, so a Cursor that is not ready reads
 * `unknown` rather than a free prompt.
 */
export const CURSOR_LOGIN_SPLASH: CursorScreen = {
	oscTitle: "example-host",
	screen: `



                                     Cursor Agent
                                     v2026.08.25-3e8eec8
                                     Press any key to log in...


`,
};

/** Constructed: a command waiting to be approved. herdr's `approval_prompt`. */
export const CURSOR_COMMAND_APPROVAL: CursorScreen = {
	oscTitle: "example-host",
	screen: `  I'll check the test suite first.

  Run this command?

    pnpm run test

  → Run (once) (y)
    Run and don't ask again (a)
    Skip (esc or n)`,
};

/** Constructed: a file write waiting to be approved. `write_file_approval`. */
export const CURSOR_WRITE_APPROVAL: CursorScreen = {
	oscTitle: "example-host",
	screen: `  Write to this file?

    src/example.ts

    Proceed (y)
    Reject & propose changes (esc or n or p)`,
};

/** Constructed: a turn running, told by the spinner. `spinner_working`. */
export const CURSOR_WORKING_SPINNER: CursorScreen = {
	oscTitle: "example-host",
	screen: `  Reading the workspace.

  ⬢ Thinking`,
};

/** Constructed: a turn running, told by the interrupt hint. `stop_hint_working`. */
export const CURSOR_WORKING_STOP_HINT: CursorScreen = {
	oscTitle: "example-host",
	screen: `  Editing src/example.ts

  ctrl+c to stop`,
};

/** Constructed: work continuing in the background. `background_task_status_working`. */
export const CURSOR_WORKING_BACKGROUND: CursorScreen = {
	oscTitle: "example-host",
	screen: `  Started the dev server.

  2 background tasks`,
};

/**
 * Constructed: a prompt that looks free.
 *
 * There is no rule for this and there must not be one — this is what a Cursor
 * pane waiting for a person plausibly looks like, and the manifest is required
 * to answer `unknown` rather than `idle`. The test that reads this screen is
 * the one that would fail if somebody later added an idle rule from memory.
 */
export const CURSOR_LOOKS_FREE: CursorScreen = {
	oscTitle: "example-host",
	screen: `  Done. The tests pass.

  >
  ? for shortcuts`,
};
