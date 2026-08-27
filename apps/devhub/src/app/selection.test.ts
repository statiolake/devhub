import { describe, expect, it, afterEach } from "vitest";
import { installSelectionGuard, isSelectable } from "./selection";

function element(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("shell selection guard", () => {
  it("refuses a selection raised on the chrome", () => {
    const stop = installSelectionGuard(document);
    const row = element(
      '<button class="sidebar-row"><span class="row-label">devhub</span></button>',
    );
    const event = new Event("selectstart", {
      bubbles: true,
      cancelable: true,
    });
    row.querySelector(".row-label")?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    stop();
  });

  it("allows a selection raised on text that exists to be copied", () => {
    const stop = installSelectionGuard(document);
    const detail = element(
      '<p class="failure-detail">port 55971 is in use</p>',
    );
    const event = new Event("selectstart", {
      bubbles: true,
      cancelable: true,
    });
    detail.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    stop();
  });

  it("stops refusing once it is removed", () => {
    installSelectionGuard(document)();
    const row = element('<button class="sidebar-row">devhub</button>');
    const event = new Event("selectstart", {
      bubbles: true,
      cancelable: true,
    });
    row.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("resolves the region from a text node, which is what a drag targets", () => {
    const detail = element(
      '<p class="failure-detail">port 55971 is in use</p>',
    );
    expect(isSelectable(detail.firstChild)).toBe(true);
    expect(isSelectable(element("<p>Workspaces</p>").firstChild)).toBe(false);
    expect(isSelectable(null)).toBe(false);
  });
});
