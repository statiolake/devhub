/**
 * The difference between putting a terminal down and ending it.
 *
 * DevHub has two ways to stop showing a terminal and they must not be
 * confused, because only one of them destroys work. Detaching lets go of the
 * client: the page went away, the surface was swapped, or DevHub is quitting.
 * Closing ends the session: the person closed that particular workspace, and
 * its shell and its Agents go with it.
 *
 * The whole of that distinction is whether the runtime is reached at all. A
 * detach touches clients and nothing else; there is no route from it to a
 * `kill-session`. That is what makes "quitting DevHub leaves your work
 * running" a property of the code's shape rather than a promise in a comment,
 * and it is what these tests hold in place.
 */

import { describe, expect, it, vi } from "vitest";
import { TerminalSurfaces } from "../../src/main/terminal/surfaces";
import type { TmuxTerminalRuntime } from "../../src/main/terminal/tmux";
import type { AttachmentManager } from "../../src/main/terminal/attachments";

/** Every destructive thing the runtime can be asked to do. */
function spyRuntime() {
  return {
    closeWorkspace: vi.fn((_target: unknown) => Promise.resolve()),
    closeOwnedSession: vi.fn((_target: unknown) => Promise.resolve()),
    closeAgent: vi.fn((_target: unknown) => Promise.resolve()),
  };
}

/** Only the part of the attachment table `TerminalSurfaces` touches here. */
function spyAttachments() {
  return {
    detachAll: vi.fn(),
    detachTarget: vi.fn(),
    detach: vi.fn(),
    detachView: vi.fn(),
    count: 0,
  };
}

function surfacesWith(
  runtime: ReturnType<typeof spyRuntime>,
  attachments: ReturnType<typeof spyAttachments>,
): TerminalSurfaces {
  return new TerminalSurfaces({
    runtime: runtime as unknown as TmuxTerminalRuntime,
    attachments: attachments as unknown as AttachmentManager,
  });
}

const TARGET = {
  workspaceId: "00000000-0000-4000-8000-0000000000aa",
  root: "/projects/widget",
};

describe("letting go of a terminal", () => {
  it("detaches every client and asks the runtime for nothing", () => {
    // This is the quit path. `app.on('will-quit')` calls exactly this, and
    // if it could reach the runtime, quitting DevHub would end the sessions
    // that are the entire reason the runtime exists.
    const runtime = spyRuntime();
    const attachments = spyAttachments();

    surfacesWith(runtime, attachments).detachAll();

    expect(attachments.detachAll).toHaveBeenCalledOnce();
    expect(runtime.closeWorkspace).not.toHaveBeenCalled();
    expect(runtime.closeOwnedSession).not.toHaveBeenCalled();
    expect(runtime.closeAgent).not.toHaveBeenCalled();
  });

  it("lets go of one page's surfaces without ending anything", () => {
    const runtime = spyRuntime();
    const attachments = spyAttachments();

    surfacesWith(runtime, attachments).detachView("overlay");

    expect(attachments.detachView).toHaveBeenCalledWith("overlay");
    expect(runtime.closeWorkspace).not.toHaveBeenCalled();
  });
});

describe("ending a workspace's terminal", () => {
  it("lets go of its clients first, then kills the session", async () => {
    // The order matters and is the reason these are two calls: a session is
    // only ever killed once nothing is attached to it.
    const runtime = spyRuntime();
    const attachments = spyAttachments();
    const order: string[] = [];
    attachments.detachTarget.mockImplementation(() => {
      order.push("detach");
    });
    runtime.closeWorkspace.mockImplementation(() => {
      order.push("kill");
      return Promise.resolve();
    });

    await surfacesWith(runtime, attachments).closeWorkspace(TARGET);

    expect(order).toEqual(["detach", "kill"]);
    expect(attachments.detachTarget).toHaveBeenCalledWith({
      kind: "workspace",
      ...TARGET,
    });
  });

  it("names the workspace it was asked about, and only that one", async () => {
    const runtime = spyRuntime();
    const attachments = spyAttachments();

    await surfacesWith(runtime, attachments).closeWorkspace(TARGET);

    expect(runtime.closeWorkspace).toHaveBeenCalledOnce();
    expect(runtime.closeWorkspace.mock.calls[0]?.[0]).toEqual(TARGET);
  });
});
