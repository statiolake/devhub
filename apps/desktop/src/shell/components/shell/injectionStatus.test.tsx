// @vitest-environment jsdom

/**
 * What the pane says about a message DevHub queued for its Agent: that it is
 * waiting and for what, and how the last one ended — a failure as an alert.
 * Nothing at all when there is nothing to say.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSnapshot } from "../../../ipc/appShell";
import { InjectionStatus } from "./InjectionStatus";

afterEach(cleanup);

function mount(injection: AgentSnapshot["injection"]) {
  return render(
    <InjectionStatus
      agent={{ id: "a-1", injection } as unknown as AgentSnapshot}
    />,
  );
}

describe("the injection status in an Agent's pane", () => {
  it("draws nothing while nothing is queued and nothing has ended", () => {
    const { container } = mount({
      queued: 0,
      waitingFor: "nothing_queued",
      lastResult: undefined,
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("says a message is waiting, and for what, rather than that it was sent", () => {
    mount({ queued: 1, waitingFor: "agent_busy", lastResult: undefined });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for the agent to finish its turn",
    );
  });

  it("distinguishes waiting for the person from waiting for the agent", () => {
    mount({ queued: 2, waitingFor: "awaiting_review", lastResult: undefined });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for you to confirm the wording (2 waiting)",
    );
  });

  it("says a message went, or was cancelled, which an empty queue alone does not", () => {
    mount({
      queued: 0,
      waitingFor: "nothing_queued",
      lastResult: { kind: "sent" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Sent to the agent.");
    cleanup();
    mount({
      queued: 0,
      waitingFor: "nothing_queued",
      lastResult: { kind: "cancelled" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(/Cancelled/u);
  });

  it("keeps a failed send on screen as an alert", () => {
    mount({
      queued: 0,
      waitingFor: "nothing_queued",
      lastResult: {
        kind: "failed",
        reason: "The pane closed before the text could be typed.",
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The pane closed before the text could be typed.",
    );
  });
});
