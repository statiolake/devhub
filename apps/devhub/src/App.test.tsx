import { render, screen } from "@testing-library/react";
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
    vi.mocked(appClient.getSnapshot).mockRejectedValueOnce(
      new Error("native host stopped"),
    );
    render(<App client={appClient} />);

    expect(
      await screen.findByRole("heading", {
        name: "The workbench is unavailable",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("native host stopped")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
  });
});
