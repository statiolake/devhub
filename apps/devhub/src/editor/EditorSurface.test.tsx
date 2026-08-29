import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startWorkbench = vi.fn();
const workbenchHost = vi.fn();
vi.mock("./workbench", () => ({ startWorkbench, workbenchHost }));

const reportFailure = vi.fn();
vi.mock("../app/useAppShell", () => ({
  useAppShell: () => ({ reportFailure }),
}));

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
    reportFailure.mockReset();
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
    expect(screen.getByText("Starting the editor…")).toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.queryByText("Starting the editor…"),
      ).not.toBeInTheDocument(),
    );
    expect(host.parentElement).not.toBeNull();
  });

  it("hands a start that failed to the shell rather than explaining it", async () => {
    const failure = new Error("no");
    startWorkbench.mockRejectedValue(failure);

    render(<EditorSurface remote={remote} folder="/workspace" />);
    await waitFor(() => expect(reportFailure).toHaveBeenCalledWith(failure));
    // Nothing local is drawn about it; the shell owns that.
    expect(screen.queryByText(/failed|error/i)).not.toBeInTheDocument();
  });

  it("waits without claiming to be starting when there is no server yet", () => {
    render(<EditorSurface />);
    expect(startWorkbench).not.toHaveBeenCalled();
  });
});
