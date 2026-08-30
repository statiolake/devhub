/**
 * The main-process attachment logic, on a fake PTY.
 *
 * Ported from the Rust `terminal/pty.rs` tests. The Rust checked the same
 * invariants against threads and condition variables; here they are checked
 * against what the view actually observes, which is what those invariants
 * existed to protect: frame order, the ack window, the input ledger, latest-wins
 * resize, and who owns which attachment.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentManager,
  FlowControl,
  type AttachContext,
} from "../../src/main/terminal/attachments";
import {
  CancellationToken,
  SCRATCH_TARGET,
  workspaceTarget,
  type TerminalTarget,
} from "../../src/main/terminal/ports";
import {
  MAX_OUTPUT_FRAME_BYTES,
  TerminalFailure,
  decodeTerminalFrame,
  encodeTerminalFrame,
  type TerminalFrame,
} from "../../src/ipc/terminal";
import type { Pty, PtyLaunch } from "../../src/main/terminal/pty";

class FakePty implements Pty {
  readonly pid = 4242;
  readonly written: Uint8Array[] = [];
  readonly resizes: { cols: number; rows: number }[] = [];
  killed = false;
  paused = false;
  private data: ((bytes: Uint8Array) => void) | undefined;
  private exit: (() => void) | undefined;

  constructor(readonly launch: PtyLaunch) {}

  onData(listener: (bytes: Uint8Array) => void) {
    this.data = listener;
  }
  onExit(listener: () => void) {
    this.exit = listener;
  }
  write(bytes: Uint8Array) {
    this.written.push(new Uint8Array(bytes));
  }
  resize(size: { cols: number; rows: number }) {
    this.resizes.push({ cols: size.cols, rows: size.rows });
  }
  kill() {
    this.killed = true;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }

  /** Whatever the child printed. */
  emit(bytes: Uint8Array | string) {
    this.data?.(
      typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
    );
  }
  end() {
    this.exit?.();
  }
}

const WORKSPACE_SURFACE =
  "workspace-terminal:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function targetFor(surfaceKey: string): TerminalTarget {
  return surfaceKey === "global-terminal"
    ? SCRATCH_TARGET
    : workspaceTarget("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "/ws");
}

interface Harness {
  readonly manager: AttachmentManager;
  readonly ptys: FakePty[];
  attach(overrides?: Partial<AttachContext>): {
    receipt: ReturnType<AttachmentManager["attach"]>;
    frames: TerminalFrame[];
    pty: FakePty;
  };
}

function harness(): Harness {
  const ptys: FakePty[] = [];
  let counter = 0;
  const manager = new AttachmentManager({
    randomBytes: (count) =>
      Uint8Array.from({ length: count }, () => (counter += 7) & 0xff),
    environment: () => ({ TERM: "xterm-256color" }),
    spawn: (launch) => {
      const pty = new FakePty(launch);
      ptys.push(pty);
      return pty;
    },
  });
  return {
    manager,
    ptys,
    attach(overrides) {
      const frames: TerminalFrame[] = [];
      const before = ptys.length;
      const surfaceKey = overrides?.surfaceKey ?? "global-terminal";
      const viewLabel = overrides?.viewLabel ?? "shell:1";
      const target = overrides?.target ?? targetFor(surfaceKey);
      // Two phases, as in production: claim the ledger, resolve the session,
      // then publish. The test does the resolving instantly.
      const permit = manager.beginAttach(
        target,
        viewLabel,
        new CancellationToken(),
      );
      const receipt = manager.attach(permit, {
        surfaceKey,
        viewLabel,
        target,
        file: "/usr/bin/tmux",
        args: ["-L", "devhub", "attach-session", "-t", "scratch"],
        cwd: ".",
        size: { cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 },
        // The frames are encoded and decoded exactly as they cross the real
        // boundary, so a test can never assert on a frame the page could not
        // have parsed.
        sink: (frame) => {
          frames.push(decodeTerminalFrame(encodeTerminalFrame(frame)));
          return true;
        },
        ...overrides,
      });
      permit.release();
      return { receipt, frames, pty: ptys[before] };
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("flow control", () => {
  it("holds output at the window until a cumulative ack", () => {
    const flow = new FlowControl();
    for (let sequence = 1; sequence <= 8; sequence += 1) {
      expect(flow.reserve(sequence, 1)).toBe(true);
    }
    expect(flow.reserve(9, 1)).toBe(false);
    expect(flow.acknowledge(8)).toBe(true);
    expect(flow.reserve(9, 1)).toBe(true);
  });

  it("refuses a future ack and an unbounded frame", () => {
    const flow = new FlowControl();
    expect(() => flow.acknowledge(0)).toThrow();
    expect(() => flow.acknowledge(1)).toThrowError(
      expect.objectContaining({ code: "invalid_request" }) as unknown as Error,
    );
    expect(() => flow.reserve(1, MAX_OUTPUT_FRAME_BYTES + 1)).toThrowError(
      expect.objectContaining({ code: "backpressure" }) as unknown as Error,
    );
    expect(() => flow.acknowledge(Number.MAX_SAFE_INTEGER + 2)).toThrow();
  });
});

describe("attach", () => {
  it("gives the view a started frame before any output, and a receipt to match", () => {
    const test = harness();
    const { receipt, frames, pty } = test.attach();
    expect(receipt.surfaceKey).toBe("global-terminal");
    expect(receipt.attachmentId).toMatch(/^[0-9a-f]{32}$/u);
    expect(receipt.targetGeneration).toBeGreaterThan(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "started",
      sequence: 0,
      surfaceKey: "global-terminal",
      targetGeneration: receipt.targetGeneration,
      cols: 80,
      rows: 24,
    });
    pty.emit("hello");
    expect(frames[1]).toMatchObject({ type: "output", sequence: 1 });
    expect(pty.launch.cwd).toBe(".");
    // The client is tmux, never a shell: the shell lives in the session.
    expect(pty.launch.file).toBe("/usr/bin/tmux");
    expect(pty.launch.args).toContain("attach-session");
  });

  it("allocates a monotonic generation per attachment", () => {
    const test = harness();
    const first = test.attach({ viewLabel: "shell:a" }).receipt;
    const second = test.attach({
      viewLabel: "shell:b",
      surfaceKey: WORKSPACE_SURFACE,
    }).receipt;
    expect(second.targetGeneration).toBe(first.targetGeneration + 1);
    expect(second.attachmentId).not.toBe(first.attachmentId);
  });

  it("replaces the attachment a view or a surface already had", () => {
    const test = harness();
    const first = test.attach();
    const second = test.attach();
    expect(first.pty.killed).toBe(true);
    expect(first.frames.at(-1)).toMatchObject({
      type: "exited",
      reason: "detached",
    });
    expect(second.pty.killed).toBe(false);
    expect(test.manager.count).toBe(1);
  });

  it("supersedes an older in-flight attach before either can publish", () => {
    // Resolving a tmux session is not instantaneous, so two attaches for one
    // view can overlap. The older one must lose definitively — not by timing.
    const test = harness();
    const first = test.manager.beginAttach(
      SCRATCH_TARGET,
      "shell:1",
      new CancellationToken(),
    );
    const second = test.manager.beginAttach(
      SCRATCH_TARGET,
      "shell:1",
      new CancellationToken(),
    );
    expect(first.cancel.isCancelled).toBe(true);
    expect(second.cancel.isCancelled).toBe(false);

    const context = {
      surfaceKey: "global-terminal",
      viewLabel: "shell:1",
      target: SCRATCH_TARGET,
      file: "/usr/bin/tmux",
      args: [],
      cwd: ".",
      size: { cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 },
      sink: () => true,
    } as const;
    expect(() => test.manager.attach(first, { ...context })).toThrowError(
      expect.objectContaining({ code: "stale_target" }) as unknown as Error,
    );
    expect(test.ptys).toHaveLength(0);

    // Releasing the stale permit must not unregister the replacement: that is
    // the publication barrier the receipt depends on.
    first.release();
    expect(test.manager.attach(second, { ...context }).surfaceKey).toBe(
      "global-terminal",
    );
    second.release();
  });

  it("tells the view when no PTY could be opened, then refuses the request", () => {
    const frames: TerminalFrame[] = [];
    const manager = new AttachmentManager({
      randomBytes: (count) => new Uint8Array(count).fill(1),
      spawn: () => {
        throw new Error("no pty for you");
      },
    });
    const permit = manager.beginAttach(
      SCRATCH_TARGET,
      "shell:1",
      new CancellationToken(),
    );
    expect(() =>
      manager.attach(permit, {
        surfaceKey: "global-terminal",
        viewLabel: "shell:1",
        target: SCRATCH_TARGET,
        file: "/usr/bin/tmux",
        args: [],
        cwd: ".",
        size: { cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 },
        sink: (frame) => {
          frames.push(frame);
          return true;
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "pty_unavailable",
        // The reason the PTY could not open must not be lost on the way out.
        cause: expect.objectContaining({ message: "no pty for you" }),
      }) as unknown as Error,
    );
    expect(frames.map((frame) => frame.type)).toEqual(["error", "exited"]);
    expect(frames[0]).toMatchObject({
      error: { code: "pty_unavailable" },
      sequence: 0,
    });
  });
});

describe("output", () => {
  it("splits at the frame bound and keeps the sequence contiguous", () => {
    const test = harness();
    const { frames, pty } = test.attach();
    pty.emit(new Uint8Array(MAX_OUTPUT_FRAME_BYTES + 10).fill(0x41));
    const outputs = frames.filter((frame) => frame.type === "output");
    expect(outputs).toHaveLength(2);
    expect(outputs.map((frame) => frame.sequence)).toEqual([1, 2]);
    expect(
      outputs.reduce(
        (total, frame) =>
          total + (frame.type === "output" ? frame.bytes.byteLength : 0),
        0,
      ),
    ).toBe(MAX_OUTPUT_FRAME_BYTES + 10);
  });

  it("pauses the child once the view stops consuming, and resumes on ack", () => {
    const test = harness();
    const { receipt, frames, pty } = test.attach();
    const identity = {
      surfaceKey: receipt.surfaceKey,
      attachmentId: receipt.attachmentId,
      targetGeneration: receipt.targetGeneration,
      viewLabel: "shell:1",
    };
    for (let index = 0; index < 9; index += 1) pty.emit("x");
    expect(frames.filter((frame) => frame.type === "output")).toHaveLength(8);
    expect(pty.paused).toBe(true);
    test.manager.acknowledge(identity, 8);
    expect(frames.filter((frame) => frame.type === "output")).toHaveLength(9);
    expect(pty.paused).toBe(false);
  });

  it("disconnects a view that never acknowledges", () => {
    vi.useFakeTimers();
    const test = harness();
    const { frames, pty } = test.attach();
    for (let index = 0; index < 9; index += 1) pty.emit("x");
    vi.advanceTimersByTime(2_000);
    expect(frames.at(-2)).toMatchObject({ error: { code: "backpressure" } });
    expect(frames.at(-1)).toMatchObject({
      type: "exited",
      reason: "detached",
    });
    expect(pty.killed).toBe(true);
  });

  it("ends the attachment when the child exits", () => {
    const test = harness();
    const { frames, pty } = test.attach();
    pty.emit("done\n");
    pty.end();
    expect(frames.at(-1)).toMatchObject({ type: "exited", reason: "eof" });
    expect(test.manager.count).toBe(0);
  });

  it("stops producing for a view that has gone away", () => {
    const ptys: FakePty[] = [];
    const manager = new AttachmentManager({
      randomBytes: (count) => new Uint8Array(count).fill(3),
      spawn: (launch) => {
        const pty = new FakePty(launch);
        ptys.push(pty);
        return pty;
      },
    });
    // A sink that reports the view is gone must end the attachment, not go on
    // reading a PTY nobody can see.
    const permit = manager.beginAttach(
      SCRATCH_TARGET,
      "shell:1",
      new CancellationToken(),
    );
    expect(() =>
      manager.attach(permit, {
        surfaceKey: "global-terminal",
        viewLabel: "shell:1",
        target: SCRATCH_TARGET,
        file: "/usr/bin/tmux",
        args: [],
        cwd: ".",
        size: { cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 },
        sink: () => false,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "channel_closed" }) as unknown as Error,
    );
    expect(ptys[0].killed).toBe(true);
    expect(manager.count).toBe(0);
  });
});

describe("input", () => {
  it("accepts a strict sequence and refuses replays and gaps", () => {
    const test = harness();
    const { receipt, pty } = test.attach();
    const identity = {
      surfaceKey: receipt.surfaceKey,
      attachmentId: receipt.attachmentId,
      targetGeneration: receipt.targetGeneration,
      viewLabel: "shell:1",
    };
    test.manager.input(identity, 1, new TextEncoder().encode("first\n"));
    expect(() =>
      test.manager.input(identity, 3, new TextEncoder().encode("gap")),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_request" }) as unknown as Error,
    );
    test.manager.input(identity, 2, new TextEncoder().encode("second\n"));
    expect(() =>
      test.manager.input(identity, 2, new TextEncoder().encode("replay")),
    ).toThrow();
    expect(
      new TextDecoder().decode(
        Uint8Array.from(pty.written.flatMap((bytes) => [...bytes])),
      ),
    ).toBe("first\nsecond\n");
  });

  it("refuses a request that does not own the attachment", () => {
    const test = harness();
    const { receipt } = test.attach();
    const identity = {
      surfaceKey: receipt.surfaceKey,
      attachmentId: receipt.attachmentId,
      targetGeneration: receipt.targetGeneration,
      viewLabel: "shell:1",
    };
    for (const wrong of [
      { ...identity, viewLabel: "shell:2" },
      { ...identity, targetGeneration: identity.targetGeneration + 1 },
      { ...identity, attachmentId: "f".repeat(32) },
      {
        ...identity,
        surfaceKey: WORKSPACE_SURFACE,
      },
    ]) {
      expect(() =>
        test.manager.input(wrong, 1, Uint8Array.from([65])),
      ).toThrowError(
        expect.objectContaining({
          code: "wrong_attachment",
        }) as unknown as Error,
      );
    }
  });
});

describe("resize", () => {
  it("is latest-wins and reaches the PTY once per interval", () => {
    vi.useFakeTimers();
    const test = harness();
    const { receipt, pty } = test.attach();
    const identity = {
      surfaceKey: receipt.surfaceKey,
      attachmentId: receipt.attachmentId,
      targetGeneration: receipt.targetGeneration,
      viewLabel: "shell:1",
    };
    test.manager.resize(identity, {
      cols: 80,
      rows: 24,
      pixelWidth: 0,
      pixelHeight: 0,
    });
    test.manager.resize(identity, {
      cols: 100,
      rows: 30,
      pixelWidth: 0,
      pixelHeight: 0,
    });
    test.manager.resize(identity, {
      cols: 120,
      rows: 40,
      pixelWidth: 0,
      pixelHeight: 0,
    });
    expect(pty.resizes).toHaveLength(0);
    vi.advanceTimersByTime(16);
    expect(pty.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });
});

describe("detach", () => {
  it("is idempotent for the exact handle and refuses a different one", () => {
    const test = harness();
    const { receipt, frames, pty } = test.attach();
    const identity = {
      surfaceKey: receipt.surfaceKey,
      attachmentId: receipt.attachmentId,
      targetGeneration: receipt.targetGeneration,
      viewLabel: "shell:1",
    };
    expect(() =>
      test.manager.detach({ ...identity, viewLabel: "shell:2" }),
    ).toThrowError(
      expect.objectContaining({
        code: "wrong_attachment",
      }) as unknown as Error,
    );
    test.manager.detach(identity);
    expect(pty.killed).toBe(true);
    expect(frames.at(-1)).toMatchObject({
      type: "exited",
      reason: "detached",
    });
    // The handle is gone, and a second release of it is not an error.
    expect(() => test.manager.detach(identity)).not.toThrow();
    expect(test.manager.count).toBe(0);
  });

  it("takes a closed view's and the whole app's attachments with it", () => {
    const test = harness();
    const first = test.attach({ viewLabel: "shell:a" });
    const second = test.attach({
      viewLabel: "shell:b",
      surfaceKey: WORKSPACE_SURFACE,
    });
    test.manager.detachView("shell:a");
    expect(first.pty.killed).toBe(true);
    expect(second.pty.killed).toBe(false);
    test.manager.detachAll();
    expect(second.pty.killed).toBe(true);
    expect(test.manager.count).toBe(0);
  });

  it("refuses every request once the attachment has ended", () => {
    const test = harness();
    const { receipt, pty } = test.attach();
    const identity = {
      surfaceKey: receipt.surfaceKey,
      attachmentId: receipt.attachmentId,
      targetGeneration: receipt.targetGeneration,
      viewLabel: "shell:1",
    };
    pty.end();
    expect(() =>
      test.manager.input(identity, 1, Uint8Array.from([65])),
    ).toThrowError(TerminalFailure);
  });
});
