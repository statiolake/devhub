/**
 * "Continue in terminal", until there is a terminal to continue in.
 *
 * The way out of a GUI Agent is to start a terminal Agent on the same session
 * and stop this one (design §6.4, the `continue_agent_in_terminal` intent).
 * That intent does not exist yet. The button is on the header anyway, so the
 * way out is where it will be. Pressing it is refused with the reason, through
 * the page's one failure path, rather than doing nothing — a button that does
 * nothing leaves no way to tell a missing feature from a broken one.
 */

import { UserFacingFailure } from "../failure";

export const CONTINUE_IN_TERMINAL_REFUSAL =
  "Continuing a GUI Agent in a terminal is not available yet.";

export function refuseContinueInTerminal(): Promise<never> {
  return Promise.reject(new UserFacingFailure(CONTINUE_IN_TERMINAL_REFUSAL));
}
