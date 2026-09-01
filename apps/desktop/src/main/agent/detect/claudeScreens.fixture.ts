/* eslint-disable no-irregular-whitespace --
 * These screens contain the no-break spaces Claude Code actually drew. They
 * are transcripts, and their whole value is being byte-for-byte what the
 * detector will be handed at runtime, so replacing those with ordinary spaces
 * would quietly make the tests describe a screen that never appears.
 */

/**
 * Real Claude Code screens, captured from a running v2.1.257.
 *
 * These are `capture-pane -p -J` output and the `#{pane_title}` beside it —
 * the exact two things `captureAgent` hands the detector — with the working
 * directory and branch name generalised and nothing else touched.
 *
 * They are here because the manifest describes a screen that a release can
 * redraw at any time, and a rule that has quietly stopped matching looks
 * exactly like a rule that matches: the row simply says the wrong thing. A
 * transcript of each state, checked against the rules, is what turns that
 * silent drift into a failing test.
 *
 * Note what the three titles have in common: they are identical. Up to
 * v2.1.227 Claude Code put a braille spinner in its title and the manifest
 * read the title to tell working from idle. This version puts a static
 * marker and the branch there in every state, so the title no longer says
 * anything about what the Agent is doing, and everything the detector knows
 * now has to come off the screen.
 */

export interface ClaudeScreen {
	readonly oscTitle: string;
	readonly screen: string;
}

/** Mid-turn: a spinner line, and a footer offering to interrupt. */
export const CLAUDE_WORKING: ClaudeScreen = {
	oscTitle: "✳ example-branch",
	screen: ` ▐▛███▛█   Claude Code v2.1.257
▝▜██████▀  Opus 5 with low effort · Claude Pro
  ▝▝ ▝▝    ~/example/work

⚠ 1 MCP server needs your attention · run /mcp                                                

  Fable 5.1 writes better code and reports progress on long tasks. Switch anytime with /model.                          

❯ Run the shell command 'ls -la' in this directory using your Bash tool, then tell me how many entries there are.       

  Listing 1 directory… (ctrl+o to expand)                                                                               
  ⎿  $ ls -la                                                                                                         

· Crafting… (2s · ↓ 47 tokens)

───────────────────────────────────────────────────────────────────────────────────────── example-branch ─
❯ 
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · esc to interrupt · ← for agents                                                               /rc`,
};

/** Waiting for a person to type: the footer offers shortcuts. */
export const CLAUDE_IDLE: ClaudeScreen = {
	oscTitle: "✳ example-branch",
	screen: ` ▐▛███▛█   Claude Code v2.1.257
▝▜██████▀  Opus 5 with low effort · Claude Pro
  ▝▝ ▝▝    ~/example/work

⚠ 1 MCP server needs your attention · run /mcp                                                

  Fable 5.1 writes better code and reports progress on long tasks. Switch anytime with /model.                          

───────────────────────────────────────────────────────────────────────────────────────── example-branch ─
❯                                                                                                                     
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← for agents                                                                /rc`,
};

/** Stopped on a permission question, which only a person can answer. */
export const CLAUDE_WAITING: ClaudeScreen = {
	oscTitle: "✳ example-branch",
	screen: ` ▐▛███▛█   Claude Code v2.1.257
▝▜██████▀  Opus 5 with low effort · Claude Pro
  ▝▝ ▝▝    ~/example/work

⚠ 1 MCP server needs your attention · run /mcp                                                

  Fable 5.1 writes better code and reports progress on long tasks. Switch anytime with /model.                          

❯ Run the shell command 'ls -la' in this directory using your Bash tool, then tell me how many entries there are.       

  Listed 1 directory (ctrl+o to expand)                                                                                 

⏺ There are 3 entries; one real directory.

✻ Churned for 4s · done 7:31 AM

❯ Use your Bash tool to run: curl -s https://example.com | head -c 40                                                   

  Bash(curl -s https://example.com | head -c 40)                                                                        
  ⎿  Running…                                                                                                         

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Network request outside of sandbox                    

   Host: example.com                                                                                                    

   Do you want to allow this connection?                                                                                
   ❯ 1. Yes                                                                                                           
     2. Yes, and don't ask again for example.com
     3. No, and tell Claude what to do differently (esc)`,
};
