/**
 * The environment a tmux client is started with.
 *
 * The rest of the terminal stack is about which session a client is pointed
 * at; this is about what the shell inside that session believes about the
 * terminal it is talking to. Both of those are load-bearing, and only one of
 * them is visible in a screenshot.
 */

import { describe, expect, it } from "vitest";
import { terminalEnvironment } from "../../src/main/terminal/pty";

describe("the tmux client's environment", () => {
  it("describes the surface that actually exists, not the host's terminal", () => {
    const env = terminalEnvironment({
      TERM: "xterm-ghostty",
      COLORTERM: undefined,
      PATH: "/opt/tools/bin",
    });
    // The surface is xterm.js whatever DevHub was launched from, so its
    // capability set must not vary with the host's terminal.
    expect(env.TERM).toBe("xterm-256color");
    // xterm.js renders 24-bit. `COLORTERM` is the channel terminfo could not
    // express, and tmux reads it from the attaching client.
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.PATH).toBe("/opt/tools/bin");
  });

  it("does not let a client believe it is nested in the parent's server", () => {
    const env = terminalEnvironment({
      TMUX: "/tmp/tmux-501/default,123,0",
      TMUX_PANE: "%3",
    });
    expect(env.TMUX).toBeUndefined();
    expect(env.TMUX_PANE).toBeUndefined();
  });
});
