/**
 * `Cmd+Q O` on the Orchestrator row, this page's half of it: the keys to the
 * board or to the orchestrator agent's pane, as main says
 * (`AppController.swapOrchestratorFocus`).
 *
 * Main moves the keyboard between views; which element of a page has it is
 * the page's to say. The board is always the Agents page's. The agent's pane
 * is that page's too for a TUI orchestrator (its terminal), and the
 * Conversations page's for a GUI one (its composer). With a TUI orchestrator
 * both halves are one page, so main cannot know which of them has the keys
 * and asks for the other one (`toggle`) — answered by the board
 * (`OrchestratorBoard`), which knows whether its Terminal tab is shown.
 */

import { useEffect } from "react";
import type { OrchestratorFocusHalfWire } from "../../ipc/contract";
import { devhub } from "./client";

/** What takes the keys in an Agent's pane: its terminal, or its composer. */
const PANE_INPUT =
  "textarea.control-input, textarea.conversation-composer-input";

/**
 * The keys into the Agent's pane on screen in this page — its terminal, or
 * its conversation's composer — unless they are in it already (on its find
 * bar, say). Whether there is one here to take them.
 */
export function focusAgentPane(root: ParentNode = document): boolean {
  const entry = root.querySelector<HTMLElement>(
    ".agent-pane:not([hidden]) > .surface-pool-entry:not([hidden])",
  );
  if (entry === null) return false;
  const active = document.activeElement;
  if (active !== null && active !== document.body && entry.contains(active))
    return true;
  const input = entry.querySelector<HTMLElement>(PANE_INPUT);
  if (input === null) return false;
  input.focus({ preventScroll: true });
  return document.activeElement === input;
}

/**
 * The keys onto the board: back on what had them in it last (a card, the
 * request composer), else on the board itself, where Enter opens the card
 * on top.
 */
export function focusBoard(board: HTMLElement, last: HTMLElement | null): void {
  if (
    last !== null &&
    last !== board &&
    last.isConnected &&
    board.contains(last) &&
    last.closest("[inert]") === null
  ) {
    last.focus({ preventScroll: true });
    if (document.activeElement === last) return;
  }
  board.focus({ preventScroll: true });
}

/** Main's word for this page, while `listener` is mounted. */
export function useOrchestratorFocus(
  listener: ((half: OrchestratorFocusHalfWire) => void) | undefined,
): void {
  useEffect(() => {
    if (listener === undefined) return undefined;
    const subscribe = devhub().onFocusOrchestratorHalf;
    if (typeof subscribe !== "function") return undefined;
    return subscribe(listener);
  }, [listener]);
}

/**
 * The Conversations page: a GUI orchestrator's pane is here, the board is
 * not, so only `conversation` is this page's.
 */
export function onConversationsPage(half: OrchestratorFocusHalfWire): void {
  if (half === "conversation") focusAgentPane();
}
