/* eslint-disable no-irregular-whitespace --
 * These screens carry the spacing Codex actually draws, no-break spaces
 * included. They are transcripts: their value is being byte-for-byte what the
 * detector is handed at runtime, so tidying them would make the tests describe
 * a screen that never appears.
 */

/**
 * Real Codex screens, captured from a running codex-cli 0.151.0.
 *
 * The same `capture-pane -p -J` output and `#{pane_title}` that `captureAgent`
 * hands the detector, with the host, the paths, the project and the model
 * generalised and nothing else touched.
 *
 * Read the titles first, because they are the whole reason the old rules were
 * wrong. Codex takes its terminal's title over only once it has started: until
 * then the title is whatever the person's shell last set — here a hostname —
 * and the manifest read *any* non-empty title as an idle Agent. So every
 * screen below that Codex draws before it is ready was reported as a free
 * prompt, including the two that are questions.
 */

export interface CodexScreen {
	readonly oscTitle: string;
	readonly screen: string;
}

/** Still starting: the composer is drawn, but the model is still loading. */
export const CODEX_STARTUP: CodexScreen = {
	oscTitle: "example-host",
	screen: `╭────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.151.0)                     │
│                                                │
│ model:     loading   /model to change          │
│ directory: ~/example/work │
╰────────────────────────────────────────────────╯
 
 
› Ask Codex to do anything
 
  ? for shortcuts`,
};

/** A numbered menu whose first option runs an installer. Never type here. */
export const CODEX_UPDATE_PROMPT: CodexScreen = {
	oscTitle: "example-host",
	screen: `
  ✨ Update available! 0.151.0 -> 0.152.0

  Release notes: https://github.com/openai/codex/releases/latest

› 1. Update now (runs \`sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'\`)
  2. Skip
  3. Skip until next version

  Press enter to continue`,
};

/** The trust question, asked before Codex will work in a directory. */
export const CODEX_TRUST_PROMPT: CodexScreen = {
	oscTitle: "example-host",
	screen: `> You are in ~/example/untrusted

  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt
  injection. Trusting the directory allows project-local config, hooks, and exec policies to load.

› 1. Yes, continue
  2. No, quit

  Press enter to continue`,
};

/** Ready and waiting for a person: composer empty, model resolved. */
export const CODEX_IDLE: CodexScreen = {
	oscTitle: "example-project",
	screen: `╭─────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ ✨ Update available! 0.151.0 -> 0.152.0                                                             │
│ Run sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh' to update. │
│                                                                                                     │
│ See full release notes:                                                                             │
│ https://github.com/openai/codex/releases/latest                                                     │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────╯

╭────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.151.0)                     │
│                                                │
│ model:     gpt-5.6-luna max   /model to change │
│ directory: ~/example/work │
╰────────────────────────────────────────────────╯

  Tip: New Use /fast to enable our fastest inference with increased plan usage.

⚠ The example MCP server requires OAuth reauthentication. Run \`codex mcp login example\`.

⚠ The example MCP server requires OAuth reauthentication. Run \`codex mcp login example\`.

⚠ The example MCP server requires OAuth reauthentication. Run \`codex mcp login example\`.

⚠ MCP startup incomplete (failed: example)
 
 
› Ask Codex to do anything
 
  gpt-5.6-luna max · ~/example/work`,
};

/** Mid-turn — and note the composer is still drawn beneath the spinner. */
export const CODEX_WORKING: CodexScreen = {
	oscTitle: "⠋ example-project",
	screen: `╭─────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ ✨ Update available! 0.151.0 -> 0.152.0                                                             │
│ Run sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh' to update. │
│                                                                                                     │
│ See full release notes:                                                                             │
│ https://github.com/openai/codex/releases/latest                                                     │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────╯

╭────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.151.0)                     │
│                                                │
│ model:     gpt-5.6-luna max   /model to change │
│ directory: ~/example/work │
╰────────────────────────────────────────────────╯

  Tip: New Use /fast to enable our fastest inference with increased plan usage.

⚠ The example MCP server requires OAuth reauthentication. Run \`codex mcp login example\`.

⚠ The example MCP server requires OAuth reauthentication. Run \`codex mcp login example\`.

⚠ The example MCP server requires OAuth reauthentication. Run \`codex mcp login example\`.

⚠ MCP startup incomplete (failed: example)


› Reply with exactly the word BANANA and nothing else.

 
• Working (0s • esc to interrupt)
 
 
› Ask Codex to do anything
 
  gpt-5.6-luna max · ~/example/work`,
};
