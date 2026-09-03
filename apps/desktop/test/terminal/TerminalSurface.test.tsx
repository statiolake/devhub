// @vitest-environment jsdom

/**
 * The terminal surface component.
 *
 * Ported from the Tauri app's `src/terminal/TerminalSurface.test.tsx`. The
 * cases that only existed to feed the performance-marker harness are gone with
 * the markers; everything that describes what the pane does — the handshake,
 * the ack, the input ledger, pooling, resize coalescing, appearance, and which
 * exact handle gets released — is here.
 */

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./terminal-v1.fixture.json" with { type: "json" };
import type {
  TerminalClient,
  TerminalInputRequest,
} from "../../src/shell/terminal/client";
import { TerminalFailure } from "../../src/ipc/terminal";
import type { TerminalAppearance } from "../../src/shell/terminal/theme";
import { TerminalSurface } from "../../src/shell/terminal/TerminalSurface";

interface MockTerminalInstance {
  readonly writes: string[];
  readonly emitData: (value: string) => void;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly options: Record<string, unknown>;
}

interface MockFitInstance {
  dimensions: { cols: number; rows: number };
}

interface MockResizeObserverInstance {
  readonly trigger: () => void;
}

const mocks = vi.hoisted(() => ({
  terminals: [] as MockTerminalInstance[],
  fits: [] as MockFitInstance[],
  observers: [] as MockResizeObserverInstance[],
}));

vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    readonly writes: string[] = [];
    private dataHandler: ((value: string) => void) | undefined;
    readonly dispose = vi.fn();
    readonly options: Record<string, unknown> = {};

    constructor(options: Record<string, unknown> = {}) {
      // The real Terminal takes its font and theme at construction, so a mock
      // that drops them cannot tell a missing projection from a working one.
      Object.assign(this.options, options);
      mocks.terminals.push(this as unknown as MockTerminalInstance);
    }

    loadAddon() {}

    open(host: HTMLElement) {
      const element = document.createElement("div");
      element.className = "xterm";
      element.append(document.createElement("textarea"));
      host.append(element);
    }

    attachCustomKeyEventHandler() {}

    onData(handler: (value: string) => void) {
      this.dataHandler = handler;
      return { dispose: vi.fn() };
    }

    emitData(value: string) {
      this.dataHandler?.(value);
    }

    write(value: string | Uint8Array, callback?: () => void) {
      this.writes.push(
        typeof value === "string" ? value : new TextDecoder().decode(value),
      );
      callback?.();
    }

    focus() {}
  }

  return { Terminal: MockTerminal };
});

vi.mock("@xterm/addon-fit", () => {
  class MockFitAddon {
    readonly dimensions = { cols: 80, rows: 24 };

    constructor() {
      mocks.fits.push(this as unknown as MockFitInstance);
    }

    fit() {}

    proposeDimensions() {
      return this.dimensions;
    }
  }

  return { FitAddon: MockFitAddon };
});

function raw(
  kind: number,
  header: Record<string, unknown>,
  output: ArrayLike<number> = [],
) {
  const metadata = new TextEncoder().encode(JSON.stringify(header));
  const bytes = new Uint8Array(8 + metadata.byteLength + output.length);
  bytes[0] = 1;
  bytes[1] = kind;
  new DataView(bytes.buffer).setUint32(4, metadata.byteLength, true);
  bytes.set(metadata, 8);
  bytes.set(output, 8 + metadata.byteLength);
  return bytes;
}

function receipt(id: string, generation: number) {
  return {
    schemaVersion: 1 as const,
    attachmentId: id,
    surfaceKey: "global-terminal",
    targetGeneration: generation,
  };
}

function started(id: string, generation: number) {
  return raw(1, {
    ...fixture.started,
    attachmentId: id,
    targetGeneration: generation,
  });
}

function output(id: string, sequence: number, bytes: Uint8Array) {
  return raw(
    2,
    { ...fixture.outputMetadata, attachmentId: id, sequence },
    bytes,
  );
}

const PALETTE = {
  ansi: Array.from({ length: 16 }, (_, index) => `#0${index.toString(16)}0000`),
  background: "#ffffff",
  cursor: "#202020",
  cursorText: "#ffffff",
  foreground: "#202020",
  selectionBackground: "#bfd9f2",
  selectionForeground: "#202020",
};

function appearanceFixture(): TerminalAppearance {
  return {
    terminalFontFamily: "SF Mono",
    terminalFontSize: 13,
    terminalLineHeight: 1.2,
    terminalMargin: 4,
    terminalTheme: {
      light: PALETTE,
      dark: { ...PALETTE, background: "#121314" },
    },
  };
}

function clientHarness(
  inputImpl: (request: TerminalInputRequest) => Promise<void> = async () =>
    undefined,
  deferFirstAttach = false,
) {
  const handlers: Array<(value: unknown) => void> = [];
  const receipts = [
    receipt("0123456789abcdef0123456789abcdef", 42),
    receipt("abcdef0123456789abcdef0123456789", 43),
  ];
  let attachCount = 0;
  let releaseFirstAttach: (() => void) | undefined;
  const client: TerminalClient = {
    channelId: "channel-1",
    attach: vi.fn(async (request, onFrame) => {
      void request;
      const index = attachCount++;
      const nextReceipt = receipts[index] ?? receipts[receipts.length - 1];
      handlers.push(onFrame);
      if (deferFirstAttach && index === 0) {
        await new Promise<void>((resolve) => {
          releaseFirstAttach = resolve;
        });
      }
      onFrame(started(nextReceipt.attachmentId, nextReceipt.targetGeneration));
      return nextReceipt;
    }),
    input: vi.fn(inputImpl),
    resize: vi.fn(async () => undefined),
    acknowledge: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
  };
  return {
    client,
    handlers,
    receipts,
    releaseFirstAttach: () => releaseFirstAttach?.(),
  };
}

beforeEach(() => {
  class TestResizeObserver {
    private readonly callback: () => void;

    constructor(callback: () => void) {
      this.callback = callback;
      mocks.observers.push(this as unknown as MockResizeObserverInstance);
    }

    observe() {}

    disconnect() {}

    trigger() {
      this.callback();
    }
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});

afterEach(() => {
  // Vitest runs without globals here, so Testing Library's automatic cleanup
  // is not installed: a surface left mounted would leak into the next case.
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mocks.terminals.length = 0;
  mocks.fits.length = 0;
  mocks.observers.length = 0;
});

describe("TerminalSurface lifecycle", () => {
  it("labels xterm's hidden native input for VoiceOver", async () => {
    const harness = clientHarness();
    render(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    expect(
      await screen.findByRole("textbox", { name: "Scratch terminal input" }),
    ).toHaveAttribute("aria-label", "Scratch terminal input");
  });

  it("keeps a pooled surface off the resize path until it is on screen", async () => {
    // A pooled surface sits under `display: none`, where the fit addon has no
    // box to measure and would fall back to 80x24. Sending that would resize
    // the pane the user is not looking at, so nothing leaves while hidden.
    const harness = clientHarness();
    const view = render(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        client={harness.client}
        hidden
      />,
    );
    await waitFor(() => expect(harness.client.attach).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(1));
    const attachResizes = (harness.client.resize as ReturnType<typeof vi.fn>)
      .mock.calls.length;
    act(() => mocks.observers[0]?.trigger());
    // Resize is coalesced onto a frame timer, so the gate has to be observed
    // after that timer would have fired, not merely on the next microtask.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(harness.client.resize).toHaveBeenCalledTimes(attachResizes);

    // Coming back on screen is the first moment there is a real box to
    // report, and a real box is a different size from the 80x24 a surface with
    // no layout falls back to — that difference is the whole reason there is
    // something to send.
    mocks.fits[0].dimensions.cols = 132;
    mocks.fits[0].dimensions.rows = 43;
    view.rerender(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await waitFor(() =>
      expect(harness.client.resize).toHaveBeenCalledTimes(attachResizes + 1),
    );
    // The attachment was never torn down, so the pooled PTY is still the one
    // on screen.
    expect(harness.client.attach).toHaveBeenCalledTimes(1);
    expect(harness.client.detach).not.toHaveBeenCalled();
  });

  it("attaches with target zero, accepts Started, writes output, and ACKs after write", async () => {
    const harness = clientHarness();
    render(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await waitFor(() => expect(harness.client.attach).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(1));
    expect(harness.client.attach).toHaveBeenCalledWith(
      expect.objectContaining({
        targetGeneration: 0,
        surfaceKey: "global-terminal",
      }),
      expect.any(Function),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    act(() =>
      harness.handlers[0](
        output(
          harness.receipts[0].attachmentId,
          1,
          new TextEncoder().encode("hello"),
        ),
      ),
    );
    await waitFor(() => expect(mocks.terminals[0].writes).toEqual(["hello"]));
    await waitFor(() =>
      expect(harness.client.acknowledge).toHaveBeenCalledWith(
        expect.objectContaining({
          sequence: 1,
          attachmentId: harness.receipts[0].attachmentId,
          targetGeneration: 42,
        }),
      ),
    );
  });

  it("accepts a Started frame delivered after the receipt", async () => {
    let onFrame: ((value: unknown) => void) | undefined;
    const harness = clientHarness();
    harness.client.attach = vi.fn(async (_request, callback) => {
      onFrame = callback;
      return harness.receipts[0];
    });
    render(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await waitFor(() => expect(harness.client.attach).toHaveBeenCalledTimes(1));
    expect(harness.client.resize).not.toHaveBeenCalled();
    act(() => onFrame?.(started(harness.receipts[0].attachmentId, 42)));
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(1));
    expect(harness.client.detach).not.toHaveBeenCalled();
  });

  it("names the missing executable the main process could not find", async () => {
    // The whole point of the wire's summary: what reaches the pane is what the
    // main process said, not a second sentence re-derived from the code here.
    // "Terminal unavailable (runtime unavailable)" named neither the program
    // nor the search, and was what a packaged DevHub showed for a tmux that
    // was simply not on launchd's PATH.
    const summary =
      "DevHub could not find 'tmux' on PATH (looked in: /usr/bin, /bin, /usr/sbin, /sbin).";
    const harness = clientHarness();
    harness.client.attach = vi.fn(async () => {
      throw new TerminalFailure("runtime_unavailable", { summary });
    });
    render(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/terminal session is not connected/i);
    expect(alert).toHaveTextContent(summary);
  });

  it("keeps waiting while main is still sending, and fails only when it goes quiet", async () => {
    // "Slow" and "silent" are different states. On a cold start with several
    // Agents mounted at once, attaching takes longer than any fixed budget —
    // and a pane that called that a failure was cured by pressing Retry once
    // the machine was quiet, which is a load problem wearing a failure's
    // words. So the clock measures silence, and every frame restarts it.
    vi.useFakeTimers();
    const harness = clientHarness();
    let onFrame: ((value: unknown) => void) | undefined;
    harness.client.attach = vi.fn(async (_request, callback) => {
      onFrame = callback;
      return new Promise<ReturnType<typeof receipt>>(() => undefined);
    });
    render(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(4_000));
    act(() => onFrame?.(started(harness.receipts[0].attachmentId, 42)));
    for (let beat = 0; beat < 3; beat += 1) {
      act(() => vi.advanceTimersByTime(4_000));
      act(() =>
        onFrame?.(
          output(
            harness.receipts[0].attachmentId,
            beat + 1,
            new TextEncoder().encode("."),
          ),
        ),
      );
    }
    // Sixteen seconds of a five-second budget, and the pane is still waiting:
    // it is a spinner, not an alert.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/connecting/i);

    act(() => vi.advanceTimersByTime(5_001));
    expect(screen.getByRole("alert")).toHaveTextContent(
      /terminal session is not connected/i,
    );
  });

  it("keeps the handshake timeout until a pre-receipt Started has a receipt", async () => {
    vi.useFakeTimers();
    const harness = clientHarness();
    let resolveAttach:
      | ((value: ReturnType<typeof receipt>) => void)
      | undefined;
    harness.client.attach = vi.fn(async (_request, callback) => {
      callback(started(harness.receipts[0].attachmentId, 42));
      return new Promise<ReturnType<typeof receipt>>((resolve) => {
        resolveAttach = resolve;
      });
    });
    render(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    // The pre-receipt Started is a sign of life and restarts the clock, so the
    // failure comes from the silence that follows it, not from the attach.
    act(() => vi.advanceTimersByTime(5_001));
    // A dead session is an alert, not a status line, and it names the cause.
    expect(screen.getByRole("alert")).toHaveTextContent(
      /terminal session is not connected/i,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /terminal connection is unavailable/i,
    );

    await act(async () => {
      resolveAttach?.(harness.receipts[0]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.client.detach).toHaveBeenCalledTimes(1);
    expect(harness.client.detach).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentId: harness.receipts[0].attachmentId,
        targetGeneration: harness.receipts[0].targetGeneration,
      }),
    );
    expect(harness.client.resize).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("drains output buffered between Started and the receipt", async () => {
    const harness = clientHarness();
    harness.client.attach = vi.fn(async (_request, callback) => {
      callback(started(harness.receipts[0].attachmentId, 42));
      callback(
        output(
          harness.receipts[0].attachmentId,
          1,
          new TextEncoder().encode("buffered"),
        ),
      );
      return harness.receipts[0];
    });
    render(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await waitFor(() =>
      expect(mocks.terminals[0].writes).toEqual(["buffered"]),
    );
    await waitFor(() =>
      expect(harness.client.acknowledge).toHaveBeenCalledWith(
        expect.objectContaining({
          sequence: 1,
          attachmentId: harness.receipts[0].attachmentId,
        }),
      ),
    );
  });

  it("ignores input before the receipt and serializes Unicode input from sequence one", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstInput = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const harness = clientHarness(async (request) => {
      if (request.inputSequence === 1) await firstInput;
    }, true);
    render(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await waitFor(() => expect(mocks.terminals).toHaveLength(1));
    mocks.terminals[0].emitData("ignored before attach");
    harness.releaseFirstAttach();
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(1));
    mocks.terminals[0].emitData("あ");
    mocks.terminals[0].emitData("💻");
    await waitFor(() => expect(harness.client.input).toHaveBeenCalledTimes(1));
    expect(harness.client.input).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ inputSequence: 1, bytes: [0xe3, 0x81, 0x82] }),
    );
    releaseFirst?.();
    await waitFor(() => expect(harness.client.input).toHaveBeenCalledTimes(2));
    expect(harness.client.input).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        inputSequence: 2,
        bytes: [0xf0, 0x9f, 0x92, 0xbb],
      }),
    );
  });

  it("fail-stops the input queue, then resets the sequence on a replacement receipt", async () => {
    const harness = clientHarness(async (request) => {
      if (request.targetGeneration === 42) {
        throw { code: "channel_closed" };
      }
    });
    render(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(1));
    mocks.terminals[0].emitData("a");
    mocks.terminals[0].emitData("b");
    await waitFor(() => expect(harness.client.input).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument(),
    );
    expect(harness.client.input).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(harness.client.attach).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(2));
    mocks.terminals[0].emitData("c");
    await waitFor(() => expect(harness.client.input).toHaveBeenCalledTimes(2));
    expect(harness.client.input).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inputSequence: 1,
        targetGeneration: 43,
        bytes: [99],
      }),
    );
  });

  it("coalesces resize bursts, caps dimensions, and detaches on unmount", async () => {
    const harness = clientHarness();
    const rendered = render(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(1));
    mocks.fits[0].dimensions.cols = 9999;
    mocks.fits[0].dimensions.rows = 9999;
    act(() => {
      mocks.observers[0].trigger();
      mocks.observers[0].trigger();
      mocks.observers[0].trigger();
    });
    await new Promise((resolve) => setTimeout(resolve, 24));
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(2));
    expect(harness.client.resize).toHaveBeenLastCalledWith(
      expect.objectContaining({ cols: 500, rows: 500 }),
    );
    rendered.unmount();
    await waitFor(() => expect(harness.client.detach).toHaveBeenCalledTimes(1));
    expect(harness.client.detach).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentId: harness.receipts[0].attachmentId,
        targetGeneration: 42,
      }),
    );
  });

  it("projects terminal appearance without remounting the PTY view", async () => {
    const harness = clientHarness();
    const firstAppearance = appearanceFixture();
    const rendered = render(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        appearance={firstAppearance}
        client={harness.client}
      />,
    );
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(1));
    // The chosen family leads a stack that ends in the monospace generic, so
    // an unresolvable name can never fall through to a proportional face.
    expect(mocks.terminals[0].options.fontFamily).toBe(
      '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    );
    expect(mocks.terminals[0].options).toMatchObject({
      fontSize: 13,
      lineHeight: 1.2,
    });
    // A bigger face is fewer cells in the same pane; the addon would measure
    // that, so the mock says it, and the refit has something to report.
    mocks.fits[0].dimensions.cols = 69;
    mocks.fits[0].dimensions.rows = 20;
    rendered.rerender(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        appearance={{ ...firstAppearance, terminalFontSize: 15 }}
        client={harness.client}
      />,
    );
    await waitFor(() => expect(mocks.terminals[0].options.fontSize).toBe(15));
    expect(harness.client.attach).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(2));
    expect(mocks.terminals[0].options.theme).toMatchObject({
      background: "#ffffff",
    });
  });

  it("ignores stale output from a replaced attachment and surfaces a receipt mismatch", async () => {
    const harness = clientHarness();
    const rendered = render(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(1));
    act(() => harness.handlers[0](new Uint8Array([1])));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(2));
    act(() =>
      harness.handlers[0](
        output(
          harness.receipts[0].attachmentId,
          1,
          new TextEncoder().encode("old"),
        ),
      ),
    );
    act(() =>
      harness.handlers[1](
        output(
          harness.receipts[1].attachmentId,
          1,
          new TextEncoder().encode("new"),
        ),
      ),
    );
    await waitFor(() => expect(mocks.terminals[0].writes).toEqual(["new"]));
    rendered.unmount();

    const mismatch = clientHarness();
    mismatch.client.attach = vi.fn(async (_request, onFrame) => {
      mismatch.handlers.push(onFrame);
      onFrame(started(mismatch.receipts[1].attachmentId, 43));
      return mismatch.receipts[0];
    });
    render(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        client={mismatch.client}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/terminal connection is unavailable/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    await waitFor(() =>
      expect(mismatch.client.detach).toHaveBeenCalledWith(
        expect.objectContaining({
          attachmentId: mismatch.receipts[0].attachmentId,
          targetGeneration: mismatch.receipts[0].targetGeneration,
        }),
      ),
    );
  });

  it("detaches the exact receipt when an error frame arrives", async () => {
    const harness = clientHarness();
    harness.client.attach = vi.fn(async (_request, callback) => {
      setTimeout(() => callback(raw(4, fixture.errorMetadata)), 0);
      return harness.receipts[0];
    });
    render(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument(),
    );
    expect(harness.client.detach).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentId: harness.receipts[0].attachmentId,
        targetGeneration: harness.receipts[0].targetGeneration,
      }),
    );
  });

  it("says the session ended and reconnects on retry", async () => {
    const harness = clientHarness();
    render(
      <TerminalSurface
        surfaceKey="global-terminal"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(1));
    act(() =>
      harness.handlers[0](
        raw(3, {
          ...fixture.exited,
          attachmentId: harness.receipts[0].attachmentId,
          sequence: 1,
          reason: "eof",
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByText(/session disconnected/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(harness.client.attach).toHaveBeenCalledTimes(2));
  });
});
