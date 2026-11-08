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

    // Where the clipboard addon and the OSC 52 query guard register. This
    // suite is about the surface, not about what they do, so it only has to
    // exist.
    readonly parser = {
      registerOscHandler: () => ({ dispose: vi.fn() }),
    };

    private textarea: HTMLTextAreaElement | undefined;

    open(host: HTMLElement) {
      const element = document.createElement("div");
      element.className = "xterm";
      this.textarea = document.createElement("textarea");
      element.append(this.textarea);
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

    focus() {
      // Where xterm puts the keys: its hidden textarea.
      this.textarea?.focus();
    }

    clearSelection() {}
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
    surfaceKey: "workspace-terminal:00000000-0000-4000-8000-00000000005c",
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
    terminalScrollSensitivity: 3,
    terminalMargin: 4,
    terminalMacOptionIsMeta: false,
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
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    expect(
      await screen.findByRole("textbox", { name: "Scratch terminal input" }),
    ).toHaveAttribute("aria-label", "Scratch terminal input");
  });

  it("makes no emulator and attaches nothing until it is first shown", async () => {
    const harness = clientHarness();
    const view = render(
      <TerminalSurface
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
        surfaceLabel="Scratch"
        client={harness.client}
        hidden
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(mocks.terminals).toHaveLength(0);
    expect(harness.client.attach).not.toHaveBeenCalled();
    view.rerender(
      <TerminalSurface
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await waitFor(() => expect(harness.client.attach).toHaveBeenCalledTimes(1));
    expect(mocks.terminals).toHaveLength(1);
  });

  it("keeps a pooled surface off the resize path until it is on screen", async () => {
    // A pooled surface sits under `display: none`, where the fit addon has no
    // box to measure and would fall back to 80x24. Sending that would resize
    // the pane the user is not looking at, so nothing leaves while hidden.
    const harness = clientHarness();
    const view = render(
      <TerminalSurface
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await waitFor(() => expect(harness.client.attach).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(1));
    view.rerender(
      <TerminalSurface
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
        surfaceLabel="Scratch"
        client={harness.client}
        hidden
      />,
    );
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
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
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
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await waitFor(() => expect(harness.client.attach).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(1));
    expect(harness.client.attach).toHaveBeenCalledWith(
      expect.objectContaining({
        targetGeneration: 0,
        surfaceKey: "workspace-terminal:00000000-0000-4000-8000-00000000005c",
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
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
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
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
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
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
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
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
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
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
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
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
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
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
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
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
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
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
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
      scrollSensitivity: 3,
    });
    // A bigger face is fewer cells in the same pane; the addon would measure
    // that, so the mock says it, and the refit has something to report.
    mocks.fits[0].dimensions.cols = 69;
    mocks.fits[0].dimensions.rows = 20;
    rendered.rerender(
      <TerminalSurface
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
        surfaceLabel="Scratch"
        appearance={{
          ...firstAppearance,
          terminalFontSize: 15,
          terminalScrollSensitivity: 6,
        }}
        client={harness.client}
      />,
    );
    await waitFor(() => expect(mocks.terminals[0].options.fontSize).toBe(15));
    // The same re-application, without a remount, carries every option: a
    // second path for one of them is a second thing to forget.
    expect(mocks.terminals[0].options.scrollSensitivity).toBe(6);
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
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
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
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
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
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
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
        surfaceKey="workspace-terminal:00000000-0000-4000-8000-00000000005c"
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

describe("TerminalSurface when its pty host ends", () => {
  const KEY = "workspace-terminal:00000000-0000-4000-8000-00000000005c";
  const lost = (id: string, sequence: number) =>
    raw(4, {
      ...fixture.errorMetadata,
      attachmentId: id,
      sequence,
      error: new TerminalFailure("host_restarted").toWire(),
    });

  it("says it is reconnecting and attaches again on its own", async () => {
    const harness = clientHarness();
    render(
      <TerminalSurface
        surfaceKey={KEY}
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(1));
    act(() => harness.handlers[0](lost(harness.receipts[0].attachmentId, 1)));
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await waitFor(() => expect(harness.client.attach).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Reconnecting…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("attaches again when the attach itself was refused as host_restarted", async () => {
    const harness = clientHarness();
    const first = harness.client.attach;
    let refused = false;
    harness.client.attach = vi.fn(async (request, onFrame) => {
      if (!refused) {
        refused = true;
        throw new TerminalFailure("host_restarted");
      }
      return first(request, onFrame);
    });
    render(
      <TerminalSurface
        surfaceKey={KEY}
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await waitFor(() => expect(harness.client.attach).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("still shows any other failure, with Retry", async () => {
    const harness = clientHarness();
    harness.client.attach = vi.fn(async () => {
      throw new TerminalFailure("pty_unavailable");
    });
    render(
      <TerminalSurface
        surfaceKey={KEY}
        surfaceLabel="Scratch"
        client={harness.client}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument(),
    );
    expect(harness.client.attach).toHaveBeenCalledTimes(1);
  });
});

describe("TerminalSurface coming on screen disconnected", () => {
  const KEY = "workspace-terminal:00000000-0000-4000-8000-00000000005c";

  function surface(client: TerminalClient, hidden: boolean) {
    return (
      <TerminalSurface
        surfaceKey={KEY}
        surfaceLabel="Scratch"
        client={client}
        hidden={hidden}
      />
    );
  }

  /** An attach that fails for the first `failures` calls, then succeeds. */
  function failingHarness(failures: number) {
    const harness = clientHarness();
    const succeed = harness.client.attach;
    let calls = 0;
    harness.client.attach = vi.fn(async (request, onFrame) => {
      calls += 1;
      if (calls <= failures) {
        throw new TerminalFailure("session_unavailable");
      }
      return succeed(request, onFrame);
    });
    return harness;
  }

  /** Long enough for anything this pane would do on its own to have happened. */
  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }

  /**
   * A pooled surface that has been on screen once and is hidden now: one
   * that was never shown has not attached at all, so has nothing to retry.
   */
  async function shownThenHidden(client: TerminalClient) {
    const view = render(surface(client, false));
    await waitFor(() => expect(client.attach).toHaveBeenCalledTimes(1));
    await settle();
    view.rerender(surface(client, true));
    return view;
  }

  it("reconnects on its own, once, when it is shown", async () => {
    // A pooled Agent whose attach failed while nobody was looking at it. The
    // person selecting it is asking to use it, so it tries again — once. That
    // try failing is the same pane as before: the error, and Retry.
    const harness = failingHarness(2);
    const view = await shownThenHidden(harness.client);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument(),
    );
    expect(harness.client.attach).toHaveBeenCalledTimes(1);

    view.rerender(surface(harness.client, false));
    await waitFor(() => expect(harness.client.attach).toHaveBeenCalledTimes(2));
    await settle();
    expect(harness.client.attach).toHaveBeenCalledTimes(2);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/terminal session is not connected/i);
    expect(alert).toHaveTextContent("The terminal session is unavailable.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("tries again on the next time it is shown, and not while hidden", async () => {
    const harness = failingHarness(3);
    const view = render(surface(harness.client, false));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument(),
    );
    // Mounted on screen: the mount's own attach is this activation's try.
    await settle();
    expect(harness.client.attach).toHaveBeenCalledTimes(1);

    view.rerender(surface(harness.client, true));
    await settle();
    expect(harness.client.attach).toHaveBeenCalledTimes(1);

    view.rerender(surface(harness.client, false));
    await waitFor(() => expect(harness.client.attach).toHaveBeenCalledTimes(2));
    view.rerender(surface(harness.client, true));
    view.rerender(surface(harness.client, false));
    await waitFor(() => expect(harness.client.attach).toHaveBeenCalledTimes(3));
    await settle();
    expect(harness.client.attach).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("is simply connected when the one try succeeds", async () => {
    const harness = failingHarness(1);
    const view = await shownThenHidden(harness.client);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument(),
    );
    view.rerender(surface(harness.client, false));
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalled());
    await waitFor(() =>
      expect(document.querySelector("[data-connection]")).toHaveAttribute(
        "data-connection",
        "connected",
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(harness.client.attach).toHaveBeenCalledTimes(2);
  });

  it("leaves a connected pane alone when it is shown", async () => {
    const harness = clientHarness();
    const view = await shownThenHidden(harness.client);
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalled());
    view.rerender(surface(harness.client, false));
    await settle();
    expect(harness.client.attach).toHaveBeenCalledTimes(1);
    expect(harness.client.detach).not.toHaveBeenCalled();
  });
});

describe("TerminalSurface off screen", () => {
  const KEY = "workspace-terminal:00000000-0000-4000-8000-00000000005c";

  function surface(client: TerminalClient, hidden: boolean) {
    return (
      <TerminalSurface
        surfaceKey={KEY}
        surfaceLabel="Scratch"
        client={client}
        hidden={hidden}
      />
    );
  }

  function frame(id: string, sequence: number, text: string | Uint8Array) {
    return output(
      id,
      sequence,
      typeof text === "string" ? new TextEncoder().encode(text) : text,
    );
  }

  async function connectedThenHidden() {
    const harness = clientHarness();
    const view = render(surface(harness.client, false));
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(1));
    view.rerender(surface(harness.client, true));
    return { harness, view };
  }

  it("acknowledges what arrives while hidden without drawing it, and draws it, in order, when shown", async () => {
    const { harness, view } = await connectedThenHidden();
    const id = harness.receipts[0].attachmentId;
    act(() => harness.handlers[0](frame(id, 1, "one ")));
    act(() => harness.handlers[0](frame(id, 2, "two")));
    expect(mocks.terminals[0].writes).toEqual([]);
    await waitFor(() =>
      expect(harness.client.acknowledge).toHaveBeenLastCalledWith(
        expect.objectContaining({ sequence: 2, attachmentId: id }),
      ),
    );

    view.rerender(surface(harness.client, false));
    act(() => harness.handlers[0](frame(id, 3, " three")));
    expect(mocks.terminals[0].writes).toEqual(["one ", "two", " three"]);
    // The stream was drawn whole, so the client it came from is kept.
    expect(harness.client.attach).toHaveBeenCalledTimes(1);
    expect(harness.client.detach).not.toHaveBeenCalled();
  });

  it("lets its client go once more arrives while hidden than it keeps, and reads nothing more of it", async () => {
    const { harness } = await connectedThenHidden();
    const id = harness.receipts[0].attachmentId;
    const chunk = new Uint8Array(32 * 1024).fill(0x79);
    // Four frames of the largest size main sends are what is kept.
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      act(() => harness.handlers[0](frame(id, sequence, chunk)));
    }
    await waitFor(() =>
      expect(harness.client.acknowledge).toHaveBeenLastCalledWith(
        expect.objectContaining({ sequence: 4, attachmentId: id }),
      ),
    );
    expect(harness.client.detach).not.toHaveBeenCalled();
    act(() => harness.handlers[0](frame(id, 5, chunk)));
    expect(harness.client.detach).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: id }),
    );
    // What the client still had on the way is passed over, not acknowledged.
    act(() => harness.handlers[0](frame(id, 6, chunk)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(harness.client.acknowledge).not.toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 5 }),
    );
    expect(harness.client.acknowledge).not.toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 6 }),
    );
    // Nor is its end: the pane still shows what it drew, and is connected.
    act(() =>
      harness.handlers[0](
        raw(3, {
          ...fixture.exited,
          attachmentId: id,
          sequence: 7,
          reason: "detached",
        }),
      ),
    );
    expect(harness.client.attach).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/disconnected/i)).not.toBeInTheDocument();
    expect(mocks.terminals[0].writes).toEqual([]);
  });

  it("attaches a new client when it is shown after more than it keeps, without saying it is connecting, and the keys typed meanwhile reach it", async () => {
    const { harness, view } = await connectedThenHidden();
    const id = harness.receipts[0].attachmentId;
    // Five frames of the largest size main sends: more than is kept.
    const chunk = new Uint8Array(32 * 1024).fill(0x79);
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      act(() => harness.handlers[0](frame(id, sequence, chunk)));
    }
    expect(mocks.terminals[0].writes).toEqual([]);
    let release: (() => void) | undefined;
    const attach = harness.client.attach;
    harness.client.attach = vi.fn(async (request, onFrame) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return attach(request, onFrame);
    });

    view.rerender(surface(harness.client, false));
    await waitFor(() => expect(harness.client.attach).toHaveBeenCalledTimes(1));
    expect(harness.client.detach).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: id }),
    );
    expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();
    mocks.terminals[0].emitData("k");
    expect(harness.client.input).not.toHaveBeenCalled();
    act(() => release?.());
    await waitFor(() => expect(harness.client.input).toHaveBeenCalledTimes(1));
    expect(harness.client.input).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentId: harness.receipts[1].attachmentId,
        inputSequence: 1,
        bytes: [0x6b],
      }),
    );
    // The client it replaced was streaming: what it had on the way arrives
    // on the same channel after the new one started, and is not drawn.
    act(() => harness.handlers[1](frame(id, 6, "stale")));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Nothing of what was missed is drawn: the new client draws the screen.
    expect(mocks.terminals[0].writes).toEqual([]);
  });
});

describe("TerminalSurface whose session ends (reattachOnExit)", () => {
  const KEY = "workspace-terminal:00000000-0000-4000-8000-00000000005c";

  /** A client whose every attach is a new attachment, as main's are. */
  function endlessHarness() {
    const handlers: Array<(value: unknown) => void> = [];
    const receipts: ReturnType<typeof receipt>[] = [];
    const client: TerminalClient = {
      channelId: "channel-1",
      attach: vi.fn(async (_request, onFrame) => {
        const index = receipts.length;
        const next = receipt(index.toString(16).padStart(32, "0"), 42 + index);
        receipts.push(next);
        handlers.push(onFrame);
        onFrame(started(next.attachmentId, next.targetGeneration));
        return next;
      }),
      input: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      acknowledge: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
    };
    /** The session the latest client shows ends. */
    const end = () => {
      const last = receipts.length - 1;
      act(() =>
        handlers[last](
          raw(3, {
            ...fixture.exited,
            attachmentId: receipts[last].attachmentId,
            sequence: 1,
            reason: "eof",
          }),
        ),
      );
    };
    const connected = async (attaches: number) => {
      await waitFor(() =>
        expect(client.resize).toHaveBeenCalledTimes(attaches),
      );
      expect(client.attach).toHaveBeenCalledTimes(attaches);
    };
    return { client, end, connected };
  }

  function surface(client: TerminalClient) {
    return render(
      <TerminalSurface
        surfaceKey={KEY}
        surfaceLabel="Scratch"
        client={client}
        hideTitle
        reattachOnExit
      />,
    );
  }

  /** `exit` and Return, typed: keys, then what xterm makes of them. */
  const typeExit = () =>
    act(() => {
      const textarea = document.querySelector("textarea");
      if (!textarea) throw new Error("no terminal input");
      fireEvent.keyDown(textarea, { key: "Enter" });
      mocks.terminals[0].emitData("exit\r");
    });

  it("makes the session again every time it is exited, however fast", async () => {
    const harness = endlessHarness();
    surface(harness.client);
    await harness.connected(1);
    for (let exits = 1; exits <= 5; exits += 1) {
      // `exit` typed the moment the new shell is there, with no pause.
      typeExit();
      harness.end();
      await harness.connected(exits + 1);
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    }
  });

  it("makes it again when it ends by itself after it has been up a while", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const harness = endlessHarness();
    surface(harness.client);
    await harness.connected(1);
    for (let ends = 1; ends <= 3; ends += 1) {
      vi.advanceTimersByTime(3_000);
      harness.end();
      await harness.connected(ends + 1);
    }
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("says it is not connected when a session made again ends at once, untouched", async () => {
    const harness = endlessHarness();
    surface(harness.client);
    await harness.connected(1);
    // The first end is made again whatever it was…
    harness.end();
    await harness.connected(2);
    // …and one that then ends straight away with nothing typed is a shell
    // that cannot start: no loop.
    harness.end();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument(),
    );
    expect(harness.client.attach).toHaveBeenCalledTimes(2);
    // Retry is the person asking; its session ending is made again.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await harness.connected(3);
    harness.end();
    await harness.connected(4);
  });

  it("does not count the terminal's own replies as typing", async () => {
    const harness = endlessHarness();
    surface(harness.client);
    await harness.connected(1);
    harness.end();
    await harness.connected(2);
    // What xterm answers tmux's queries on attach comes through onData too.
    act(() => mocks.terminals[0].emitData("\u001b[?62;22c"));
    harness.end();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument(),
    );
    expect(harness.client.attach).toHaveBeenCalledTimes(2);
  });

  it("gives the keys back to the terminal after a reattach on exit", async () => {
    const harness = endlessHarness();
    const { container } = surface(harness.client);
    await harness.connected(1);
    const textarea = container.querySelector("textarea");
    typeExit();
    harness.end();
    await harness.connected(2);
    expect(document.activeElement).toBe(textarea);
  });
});

describe("TerminalSurface after Retry", () => {
  const KEY = "workspace-terminal:00000000-0000-4000-8000-00000000005c";

  async function disconnected() {
    const harness = clientHarness();
    const view = render(
      <TerminalSurface
        surfaceKey={KEY}
        surfaceLabel="Scratch"
        client={harness.client}
        hideTitle
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
    const retry = await screen.findByRole("button", { name: "Retry" });
    // The failure gives Retry the keys, so Return presses it.
    expect(document.activeElement).toBe(retry);
    return {
      harness,
      retry,
      textarea: view.container.querySelector("textarea"),
    };
  }

  /** Keys typed the instant Retry is pressed, and once it is connected. */
  async function typesAtOnce(
    harness: ReturnType<typeof clientHarness>,
    textarea: HTMLTextAreaElement | null,
  ) {
    const type = (key: string) =>
      act(() => {
        if (!textarea) throw new Error("no terminal input");
        fireEvent.keyDown(textarea, { key });
        mocks.terminals[0].emitData(key);
      });
    // Before the new client is there: the keys are already the terminal's,
    // and what is typed waits for the client.
    expect(document.activeElement).toBe(textarea);
    type("l");
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(document.activeElement).toBe(textarea);
    type("s");
    await waitFor(() => expect(harness.client.input).toHaveBeenCalledTimes(2));
    expect(harness.client.input).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        attachmentId: harness.receipts[1].attachmentId,
        inputSequence: 1,
        bytes: [0x6c],
      }),
    );
    expect(harness.client.input).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        attachmentId: harness.receipts[1].attachmentId,
        inputSequence: 2,
        bytes: [0x73],
      }),
    );
  }

  it("is typed into at once after Return on Retry", async () => {
    const { harness, retry, textarea } = await disconnected();
    // A button's Return is its click; jsdom has no default action for keys.
    fireEvent.keyDown(retry, { key: "Enter" });
    fireEvent.click(retry);
    await typesAtOnce(harness, textarea);
  });

  it("is typed into at once after a click on Retry", async () => {
    const { harness, retry, textarea } = await disconnected();
    retry.focus();
    fireEvent.click(retry);
    await typesAtOnce(harness, textarea);
  });

  it("does not take the keys from something outside it", async () => {
    const { harness, retry } = await disconnected();
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    fireEvent.click(retry);
    elsewhere.focus();
    await waitFor(() => expect(harness.client.resize).toHaveBeenCalledTimes(2));
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});
