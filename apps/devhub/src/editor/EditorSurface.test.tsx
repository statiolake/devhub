import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startWorkbench = vi.fn();
const workbenchHost = vi.fn();
vi.mock("./workbench", () => ({ startWorkbench, workbenchHost }));

const editorFailure = { current: null as unknown };
vi.mock("../app/useAppShell", () => ({
  useAppShell: () => ({ editorFailure: editorFailure.current }),
}));

const { UserFacingFailure } = await import("../app/failure");
const { EditorSurface } = await import("./EditorSurface");

const remote = {
  authority: "127.0.0.1:1",
  connectionToken: "t",
  commit: "c",
};

describe("EditorSurface", () => {
  beforeEach(() => {
    startWorkbench.mockReset();
    workbenchHost.mockReset();
    editorFailure.current = null;
  });

  it("replaces the starting notice with the Workbench once it is up", async () => {
    // The whole contract: a Surface that keeps saying it is starting after the
    // Workbench has started is a Surface nobody can use, and it looks exactly
    // like a hang.
    const host = document.createElement("div");
    host.textContent = "workbench";
    startWorkbench.mockResolvedValue(undefined);
    workbenchHost.mockReturnValue(host);

    render(<EditorSurface remote={remote} folder="/workspace" />);
    expect(screen.getByText("Opening the workbench…")).toBeInTheDocument();

    await waitFor(() => expect(host.parentElement).not.toBeNull());
    expect(
      screen.queryByText("Opening the workbench…"),
    ).not.toBeInTheDocument();
  });

  it("draws a start that failed where every other Surface draws one", async () => {
    // A failure that belongs to a Surface belongs in that Surface. The alert
    // is for an action the user just took, and nobody asked for this one.
    startWorkbench.mockRejectedValue(
      new UserFacingFailure("The editor is open on another Workspace.", "why"),
    );

    render(<EditorSurface remote={remote} folder="/workspace" />);
    await waitFor(() =>
      expect(
        screen.getByText("The editor is open on another Workspace."),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("why")).toBeInTheDocument();
    expect(
      screen.queryByText("Opening the workbench…"),
    ).not.toBeInTheDocument();
  });

  it("answers a failure with no words of its own with the stable sentence", async () => {
    // An internal message is not a next step, and the Surface does not invent
    // one. The same conversion every other failure goes through decides this.
    startWorkbench.mockRejectedValue(new Error("ERR_INTERNAL_7"));

    render(<EditorSurface remote={remote} folder="/workspace" />);
    await waitFor(() =>
      expect(
        screen.getByText("The native app shell is unavailable."),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/ERR_INTERNAL_7/)).not.toBeInTheDocument();
  });

  it("distinguishes waiting for a server from waiting for the Workbench", () => {
    // The two fail for unrelated reasons. A Surface that says only "starting"
    // cannot tell anyone which one has stopped.
    render(<EditorSurface />);
    expect(startWorkbench).not.toHaveBeenCalled();
    expect(screen.getByText("Starting the editor server…")).toBeInTheDocument();
  });
});
