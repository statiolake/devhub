/**
 * The attachment ledger, on a fake pty host.
 *
 * Ported from the Rust `terminal/pty.rs` tests. What is checked is who owns
 * which control client: the receipt, the generation, a surface replacing its
 * own client, an older attach losing to a newer one, and the releases of a
 * page, a target and the app. The client's data path is the pty host's
 * (`src/main/ptyHost/ptyHost.test.ts`).
 */

import { describe, expect, it, vi } from "vitest";
import {
  AttachmentManager,
  type AttachContext,
  type HostedOpen,
  type HostedPtys,
} from "../../src/main/terminal/attachments";
import {
  CancellationToken,
  SCRATCH_TARGET,
  workspaceTarget,
  type TerminalTarget,
} from "../../src/main/terminal/ports";
import type { ExitReason } from "../../src/ipc/terminal";

const SCRATCH_SURFACE =
  "workspace-terminal:00000000-0000-4000-8000-00000000005c";
const WORKSPACE_SURFACE =
  "workspace-terminal:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_WORKSPACE_SURFACE =
  "workspace-terminal:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function targetFor(surfaceKey: string): TerminalTarget {
  if (surfaceKey === SCRATCH_SURFACE) return SCRATCH_TARGET;
  if (surfaceKey === OTHER_WORKSPACE_SURFACE) {
    return workspaceTarget(
      "local",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "/other",
    );
  }
  return workspaceTarget(
    "local",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "/ws",
  );
}

/** The pty host as the ledger sees it: what it was asked to start and stop. */
class FakeHost implements HostedPtys {
  available = true;
  readonly opened: HostedOpen[] = [];
  readonly stopped = new Map<string, ExitReason>();

  open(spec: HostedOpen): Promise<number> {
    this.opened.push(spec);
    return Promise.resolve(1);
  }

  stop(id: string, reason: ExitReason): void {
    this.stopped.set(id, reason);
  }
}

function harness(
  onEndedByItself?: ConstructorParameters<
    typeof AttachmentManager
  >[0]["onEndedByItself"],
) {
  const host = new FakeHost();
  let counter = 0;
  const manager = new AttachmentManager({
    onEndedByItself,
    randomBytes: (count) =>
      Uint8Array.from({ length: count }, () => (counter += 7) & 0xff),
    hosted: host,
  });
  const ended = vi.fn();
  const context = (overrides?: Partial<AttachContext>): AttachContext => {
    const surfaceKey = overrides?.surfaceKey ?? SCRATCH_SURFACE;
    return {
      surfaceKey,
      viewLabel: "shell:1",
      target: targetFor(surfaceKey),
      file: "/usr/bin/tmux",
      args: ["-L", "devhub", "attach-session", "-t", "scratch"],
      cwd: ".",
      environment: { TERM: "xterm-256color" },
      size: { cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 },
      plan: (launch) => ({ launch, ended }),
      route: { page: {}, channelId: "c" },
      ...overrides,
    };
  };
  return {
    host,
    manager,
    ended,
    context,
    async attach(overrides?: Partial<AttachContext>) {
      const full = context(overrides);
      // Two phases, as in production: claim the ledger, resolve the session,
      // then publish. The test does the resolving instantly.
      const permit = manager.beginAttach(
        full.target,
        full.surfaceKey,
        full.viewLabel,
        new CancellationToken(),
      );
      try {
        const receipt = await manager.attach(permit, full);
        return { receipt, spec: host.opened.at(-1) as HostedOpen };
      } finally {
        permit.release();
      }
    },
  };
}

const identityOf = (
  receipt: { surfaceKey: string; attachmentId: string; targetGeneration: number },
  viewLabel: string,
) => ({
  surfaceKey: receipt.surfaceKey,
  attachmentId: receipt.attachmentId,
  targetGeneration: receipt.targetGeneration,
  viewLabel,
});

describe("attach", () => {
  it("starts a control client in the pty host and hands back its receipt", async () => {
    const test = harness();
    const { receipt, spec } = await test.attach();
    expect(receipt.surfaceKey).toBe(SCRATCH_SURFACE);
    expect(receipt.attachmentId).toMatch(/^[0-9a-f]{32}$/u);
    expect(receipt.targetGeneration).toBeGreaterThan(0);
    expect(spec).toMatchObject({
      id: receipt.attachmentId,
      surfaceKey: SCRATCH_SURFACE,
      targetGeneration: receipt.targetGeneration,
      route: { channelId: "c" },
    });
    // The client is tmux -C on pipes, never a shell: the shell lives in the
    // session.
    expect(spec.launch.file).toBe("/usr/bin/tmux");
    expect(spec.launch.args).toEqual([
      "-L",
      "devhub",
      "-C",
      "attach-session",
      "-t",
      "scratch",
    ]);
    expect(spec.launch.pipes).toBe(true);
    // Its popups are a shell on the same machine, in a PTY.
    expect(spec.popupLaunch?.file).toBe("/bin/sh");
    expect(test.manager.hostedGeneration(receipt.attachmentId)).toBe(1);
  });

  it("allocates a monotonic generation per attachment", async () => {
    const test = harness();
    const first = (await test.attach({ viewLabel: "shell:a" })).receipt;
    const second = (
      await test.attach({ viewLabel: "shell:b", surfaceKey: WORKSPACE_SURFACE })
    ).receipt;
    expect(second.targetGeneration).toBe(first.targetGeneration + 1);
    expect(second.attachmentId).not.toBe(first.attachmentId);
  });

  it("replaces the client the same surface already had", async () => {
    const test = harness();
    const first = await test.attach();
    const second = await test.attach();
    expect(test.host.stopped.get(first.receipt.attachmentId)).toBe("detached");
    expect(test.host.stopped.has(second.receipt.attachmentId)).toBe(false);
    expect(test.manager.count).toBe(1);
  });

  it("supersedes an older in-flight attach before either can publish", async () => {
    // Resolving a tmux session is not instantaneous, so two attaches for one
    // view can overlap. The older one must lose definitively — not by timing.
    const test = harness();
    const first = test.manager.beginAttach(
      SCRATCH_TARGET,
      SCRATCH_SURFACE,
      "shell:1",
      new CancellationToken(),
    );
    const second = test.manager.beginAttach(
      SCRATCH_TARGET,
      SCRATCH_SURFACE,
      "shell:1",
      new CancellationToken(),
    );
    expect(first.cancel.isCancelled).toBe(true);
    expect(second.cancel.isCancelled).toBe(false);
    await expect(
      test.manager.attach(first, test.context()),
    ).rejects.toMatchObject({ code: "stale_target" });
    expect(test.host.opened).toHaveLength(0);
    // Releasing the stale permit must not unregister the replacement: that is
    // the publication barrier the receipt depends on.
    first.release();
    expect(
      (await test.manager.attach(second, test.context())).surfaceKey,
    ).toBe(SCRATCH_SURFACE);
    second.release();
  });

  it("is refused while the pty host is given up on, or its machine cannot say what to run", async () => {
    const test = harness();
    test.host.available = false;
    await expect(test.attach()).rejects.toMatchObject({
      code: "pty_unavailable",
    });
    test.host.available = true;
    await expect(test.attach({ plan: () => undefined })).rejects.toMatchObject({
      code: "pty_unavailable",
    });
    expect(test.host.opened).toHaveLength(0);
    expect((await test.attach()).receipt.surfaceKey).toBe(SCRATCH_SURFACE);
  });

  it("says a client ended on its own, and nothing DevHub ended itself", async () => {
    const ended = vi.fn();
    const test = harness(ended);
    const own = await test.attach({ surfaceKey: WORKSPACE_SURFACE });
    test.manager.hostedEnded(own.receipt.attachmentId, "eof");
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith({
      surfaceKey: WORKSPACE_SURFACE,
      target: targetFor(WORKSPACE_SURFACE),
    });
    // A detach, a closed view, a close of the target, and quit stop the
    // client first: none of those is a session that ended.
    const detached = await test.attach({ surfaceKey: WORKSPACE_SURFACE });
    test.manager.detachTarget(targetFor(WORKSPACE_SURFACE));
    test.manager.hostedEnded(detached.receipt.attachmentId, "eof");
    const view = await test.attach({
      surfaceKey: OTHER_WORKSPACE_SURFACE,
      viewLabel: "pane:2",
    });
    test.manager.detachView("pane:2");
    test.manager.hostedEnded(view.receipt.attachmentId, "eof");
    const quit = await test.attach({ surfaceKey: WORKSPACE_SURFACE });
    test.manager.detachAll();
    test.manager.hostedEnded(quit.receipt.attachmentId, "eof");
    expect(ended).toHaveBeenCalledTimes(1);
  });
});

describe("detach", () => {
  it("is idempotent for the exact handle and refuses a different one", async () => {
    const test = harness();
    const { receipt } = await test.attach();
    const identity = identityOf(receipt, "shell:1");
    expect(() =>
      test.manager.detach({ ...identity, viewLabel: "shell:2" }),
    ).toThrowError(
      expect.objectContaining({
        code: "wrong_attachment",
      }) as unknown as Error,
    );
    test.manager.detach(identity);
    expect(test.host.stopped.get(receipt.attachmentId)).toBe("detached");
    // The handle is gone, and a second release of it is not an error.
    expect(() => test.manager.detach(identity)).not.toThrow();
    expect(test.manager.count).toBe(0);
  });

  it("takes a closed view's and the whole app's clients with it", async () => {
    const test = harness();
    const first = await test.attach({ viewLabel: "shell:a" });
    const second = await test.attach({
      viewLabel: "shell:b",
      surfaceKey: WORKSPACE_SURFACE,
    });
    test.manager.detachView("shell:a");
    expect(test.host.stopped.has(first.receipt.attachmentId)).toBe(true);
    expect(test.host.stopped.has(second.receipt.attachmentId)).toBe(false);
    test.manager.detachAll();
    expect(test.host.stopped.has(second.receipt.attachmentId)).toBe(true);
    expect(test.manager.count).toBe(0);
  });
});

/**
 * Who owns an attachment.
 *
 * Every terminal surface of a window can be a component of one page, so the
 * page label names the page and nothing finer. Ownership is the (page,
 * surface) pair: these are the cases that pair has to get right, and every one
 * of them is what the page label alone would get wrong.
 */
describe("ownership", () => {
  const PAGE = "7";
  const OTHER_PAGE = "9";

  it("lets every terminal surface of one page hold its own client", async () => {
    const test = harness();
    await test.attach({ viewLabel: PAGE });
    await test.attach({ viewLabel: PAGE, surfaceKey: WORKSPACE_SURFACE });
    await test.attach({ viewLabel: PAGE, surfaceKey: OTHER_WORKSPACE_SURFACE });
    expect(test.manager.count).toBe(3);
    expect(test.host.stopped.size).toBe(0);
  });

  it("keeps two attaches of one page in flight together", () => {
    // Startup attaches Scratch and a workspace terminal at once, and neither
    // resolves instantly: the ledger must not treat the second as a
    // replacement for the first.
    const test = harness();
    const scratch = test.manager.beginAttach(
      SCRATCH_TARGET,
      SCRATCH_SURFACE,
      PAGE,
      new CancellationToken(),
    );
    const workspace = test.manager.beginAttach(
      targetFor(WORKSPACE_SURFACE),
      WORKSPACE_SURFACE,
      PAGE,
      new CancellationToken(),
    );
    expect(scratch.cancel.isCancelled).toBe(false);
    expect(workspace.cancel.isCancelled).toBe(false);
    scratch.release();
    workspace.release();
  });

  it("supersedes the surface that remounted, and only that one", async () => {
    const test = harness();
    const scratch = await test.attach({ viewLabel: PAGE });
    const workspace = await test.attach({
      viewLabel: PAGE,
      surfaceKey: WORKSPACE_SURFACE,
    });
    // The pooled workspace surface remounts: it attaches again before React
    // has run the old unmount's detach.
    const remounted = await test.attach({
      viewLabel: PAGE,
      surfaceKey: WORKSPACE_SURFACE,
    });
    expect(test.host.stopped.get(workspace.receipt.attachmentId)).toBe(
      "detached",
    );
    expect(test.host.stopped.has(remounted.receipt.attachmentId)).toBe(false);
    expect(test.host.stopped.has(scratch.receipt.attachmentId)).toBe(false);
    expect(test.manager.count).toBe(2);
    // The superseded handle is the one stale one; a live handle presented by
    // another page is still foreign.
    expect(() =>
      test.manager.detach(identityOf(workspace.receipt, PAGE)),
    ).not.toThrow();
    expect(() =>
      test.manager.detach(identityOf(scratch.receipt, OTHER_PAGE)),
    ).toThrowError(
      expect.objectContaining({ code: "wrong_attachment" }) as unknown as Error,
    );
  });

  it("releases every surface of a page that goes away, and no other page's", async () => {
    const test = harness();
    const scratch = await test.attach({ viewLabel: PAGE });
    const workspace = await test.attach({
      viewLabel: PAGE,
      surfaceKey: WORKSPACE_SURFACE,
    });
    const elsewhere = await test.attach({
      viewLabel: OTHER_PAGE,
      surfaceKey: OTHER_WORKSPACE_SURFACE,
    });
    test.manager.detachView(PAGE);
    expect(test.host.stopped.has(scratch.receipt.attachmentId)).toBe(true);
    expect(test.host.stopped.has(workspace.receipt.attachmentId)).toBe(true);
    expect(test.host.stopped.has(elsewhere.receipt.attachmentId)).toBe(false);
    expect(test.manager.count).toBe(1);
  });
});
