import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { AppShellClient } from "./app/client";
import { globalSnapshot } from "./visual-fixtures/app-shell";

function client(snapshot = globalSnapshot): AppShellClient {
  return {
    getSnapshot: vi.fn().mockResolvedValue(snapshot),
    subscribe: vi.fn().mockResolvedValue(() => undefined),
    dispatch: vi.fn().mockResolvedValue({ kind: "noop", snapshot }),
  };
}

describe("DevHub app shell", () => {
  it("renders the native-light shell from one immutable snapshot", async () => {
    const appClient = client();
    render(<App client={appClient} />);

    expect(
      await screen.findByRole("button", { name: "Scratch terminal" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Editor" })).toBeEnabled();
    expect(
      screen.getByRole("button", {
        name: "Agent (Select an Agent to open its control surface.), unavailable",
      }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("heading", { name: "Scratch" }),
    ).toBeInTheDocument();
  });

  it("shows a connection failure with a retry affordance", async () => {
    const appClient = client();
    appClient.openSettings = vi.fn().mockResolvedValue(undefined);
    vi.mocked(appClient.getSnapshot).mockRejectedValueOnce(
      new Error("native host stopped"),
    );
    render(<App client={appClient} />);

    expect(
      await screen.findByText("The native app shell is unavailable."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Settings" }),
    ).toBeInTheDocument();
    // Identifiers for a bug report, shown plainly rather than behind a toggle.
    expect(screen.getByText(/native_unavailable/)).toBeInTheDocument();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Try again" }),
    );
    expect(screen.queryByText("native host stopped")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    await waitFor(() =>
      expect(appClient.openSettings).toHaveBeenCalledTimes(1),
    );
  });
});
