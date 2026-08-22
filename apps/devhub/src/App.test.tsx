import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { ShellClient } from "./shell/client";

const starting = {
  schemaVersion: 1,
  revision: 0,
  productName: "DevHub",
  platform: "macos",
  windowLabel: "app-shell",
  readiness: "starting",
} as const;

const ready = { ...starting, revision: 1, readiness: "ready" } as const;

const client = (overrides: Partial<ShellClient> = {}): ShellClient => ({
  getSnapshot: vi.fn().mockResolvedValue(starting),
  markReady: vi.fn().mockResolvedValue(ready),
  subscribe: vi.fn().mockResolvedValue(() => undefined),
  ...overrides,
});

describe("DevHub app shell", () => {
  it("renders fixed activities and only the Rust-owned snapshot", async () => {
    const shellClient = client();
    render(<App shellClient={shellClient} />);

    expect(screen.getByText("Waking the local shell")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "DevHub is ready." }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Editor" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Agent" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Terminal" })).toBeDisabled();
    expect(screen.getAllByText("DevHub")).not.toHaveLength(0);
    expect(shellClient.markReady).toHaveBeenCalledOnce();
  });

  it("exposes the native lifecycle intent and supports retry after failure", async () => {
    const failing = client({
      getSnapshot: vi.fn().mockRejectedValue(new Error("native host stopped")),
    });
    render(<App shellClient={failing} />);

    expect(
      await screen.findByRole("heading", { name: "The shell is unavailable" }),
    ).toBeInTheDocument();
    expect(screen.getByText("native host stopped")).toBeInTheDocument();
    expect(failing.markReady).not.toHaveBeenCalled();

    const retry = screen.getByRole("button", { name: "Try again" });
    fireEvent.click(retry);
    await waitFor(() => expect(failing.getSnapshot).toHaveBeenCalledTimes(2));
  });
});
