// @vitest-environment jsdom

/**
 * `Cmd+Q O`'s page half: the keys into the Agent's pane on screen — its
 * terminal or its composer — and onto the board.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  focusAgentPane,
  focusBoard,
  onConversationsPage,
} from "./orchestratorFocus";

afterEach(() => {
  document.body.innerHTML = "";
});

/** The Conversations page with a GUI orchestrator's pane on screen. */
function guiPage(): { composer: HTMLTextAreaElement; find: HTMLInputElement } {
  document.body.innerHTML =
    '<div class="agent-pane"><div class="surface-pool-entry">' +
    '<input class="find" /><textarea class="conversation-composer-input"></textarea>' +
    "</div></div>";
  return {
    composer: document.querySelector("textarea")!,
    find: document.querySelector("input")!,
  };
}

describe("the keys into the orchestrator's pane", () => {
  it("go to a GUI conversation's composer, on the Conversations page", () => {
    const { composer } = guiPage();
    onConversationsPage("conversation");
    expect(document.activeElement).toBe(composer);
  });

  it("stay where they are in the pane already", () => {
    const { find } = guiPage();
    find.focus();
    expect(focusAgentPane()).toBe(true);
    expect(document.activeElement).toBe(find);
  });

  it("are not the Conversations page's to move to the board, or to toggle", () => {
    guiPage();
    onConversationsPage("board");
    onConversationsPage("toggle");
    expect(document.activeElement).toBe(document.body);
  });

  it("find nothing on a page with no pane on screen", () => {
    document.body.innerHTML =
      '<div class="agent-pane" hidden><div class="surface-pool-entry"><textarea class="control-input"></textarea></div></div>';
    expect(focusAgentPane()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("the keys onto the board", () => {
  it("go back to what had them there, unless it is gone or inert", () => {
    document.body.innerHTML =
      '<section tabindex="-1"><button class="card">a</button><div inert><button class="under">b</button></div></section>';
    const board = document.querySelector("section")!;
    const card = document.querySelector<HTMLElement>(".card")!;
    focusBoard(board, card);
    expect(document.activeElement).toBe(card);
    card.remove();
    focusBoard(board, card);
    expect(document.activeElement).toBe(board);
    focusBoard(board, document.querySelector<HTMLElement>(".under"));
    expect(document.activeElement).toBe(board);
  });
});
