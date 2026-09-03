/**
 * The tmux runtime against a real tmux server.
 *
 * Ported from the Rust `real_transition_sockets_cover_conflicts_unknown_preservation_and_dynamic_rebind`
 * and `tmux_37b_uses_an_isolated_socket_and_marks_only_scratch`. Each case gets
 * its own socket and its own home under `.spike/`, and kills its server
 * afterwards, so nothing here can touch the developer's own tmux.
 *
 * These are the tests that prove the property the whole runtime exists for: a
 * session DevHub created is still there later, and a session it did not create
 * is never touched.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationDeadline } from "../../src/main/terminal/command";
import {
  CancellationToken,
  SCRATCH_TARGET,
  socketName,
  workspaceTarget,
  type SocketName,
} from "../../src/main/terminal/ports";
import {
  SCRATCH_SESSION,
  TmuxTerminalRuntime,
  agentSessionName,
  isMarked,
  workspaceDigest,
} from "../../src/main/terminal/tmux";
import { AgentSessions } from "../../src/main/agent/sessions";
import { AgentStatusDetector } from "../../src/main/agent/detect/detector";
import {
  AgentInjectionQueue,
  IDLE_SETTLE_MS,
} from "../../src/main/agent/injection";
import { CLAUDE_IDLE } from "../../src/main/agent/detect/claudeScreens.fixture";
import { scratchDirectory } from "./scratch";

const TMUX_CANDIDATES = [
  "/opt/homebrew/bin/tmux",
  "/usr/local/bin/tmux",
  "/usr/bin/tmux",
];
const TMUX = TMUX_CANDIDATES.find((path) => existsSync(path));

let sequence = 0;

interface Fixture {
  readonly home: string;
  readonly runtime: TmuxTerminalRuntime;
  readonly socket: SocketName;
  readonly cancel: CancellationToken;
  /** How many tmux processes this fixture's runtime has started so far. */
  readonly tmuxRuns: () => number;
}

const fixtures: Fixture[] = [];

/**
 * A tmux that records every time it is run, and then is tmux.
 *
 * What an operation costs is not how long one command takes — on a quiet
 * machine every one of them answers in single-digit milliseconds — but how
 * many processes it starts. A cold start measured 2,235 tmux processes in 25
 * seconds, and no single one of them was slow. Counting is therefore the only
 * measurement that sees the problem, and this shim is how a test counts.
 */
function countingTmux(home: string): { path: string; runs: () => number } {
  const log = join(home, "tmux-runs");
  const path = join(home, "counting-tmux");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf 'x' >> ${JSON.stringify(log)}\nexec ${JSON.stringify(TMUX)} "$@"\n`,
    { mode: 0o755 },
  );
  return {
    path,
    runs: () => (existsSync(log) ? statSync(log).size : 0),
  };
}

function fixture(
  label: string,
  environment?: Record<string, string>,
  options?: { readonly counting?: boolean },
): Fixture {
  sequence += 1;
  const home = realpathSync(scratchDirectory(`tmux-${label}`));
  const socket = socketName(`dh${label}${process.pid}${sequence}`);
  const counting = options?.counting
    ? countingTmux(home)
    : { path: TMUX as string, runs: () => 0 };
  const runtime = new TmuxTerminalRuntime({
    context: {
      home,
      environment: { ...process.env, ...environment },
    },
    tmux: {
      kind: "resolved",
      value: { path: counting.path, basename: "tmux" },
    },
    shell: { path: "/bin/zsh", basename: "zsh" },
    tmuxArgs: [],
    effectiveSocketName: socket,
    timeoutMs: 10_000,
    // Scratch stays inside the repository, never in the OS temp directory.
    bootstrapDirectory: home,
  });
  const created = {
    home,
    runtime,
    socket,
    cancel: new CancellationToken(),
    tmuxRuns: counting.runs,
  };
  fixtures.push(created);
  return created;
}

function killServer(socket: string): void {
  try {
    execFileSync(TMUX as string, ["-L", socket, "kill-server"], {
      stdio: "ignore",
    });
  } catch {
    // Not a swallow: no server on that socket is the state this wants.
  }
}

function tmuxOutside(socket: string, args: readonly string[]): void {
  execFileSync(TMUX as string, ["-f", "/dev/null", "-L", socket, ...args], {
    stdio: "ignore",
    env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined } as never,
  });
}

afterEach(() => {
  while (fixtures.length > 0) {
    const current = fixtures.pop() as Fixture;
    killServer(current.socket);
    rmSync(current.home, { recursive: true, force: true });
  }
});

const deadline = (runtime: TmuxTerminalRuntime) =>
  OperationDeadline.in(runtime.timeoutMs);

// A real server, a real socket: give each case room for the process work.
describe.skipIf(TMUX === undefined)(
  "the tmux runtime, for real",
  { timeout: 30_000 },
  () => {
    it("adopts an absent socket by creating exactly one marked Scratch", async () => {
      const test = fixture("absent");
      writeFileSync(
        join(test.home, ".tmux.conf"),
        "set-option -g @devhub-test-user-config home\n",
      );

      expect((await test.runtime.preflight(test.socket)).state).toBe(
        "target_absent",
      );
      await test.runtime.ensure(SCRATCH_TARGET);

      const preflight = await test.runtime.preflight(test.socket);
      expect(preflight.state).toBe("marked_sessions");
      expect(preflight.ownedSessionCount).toBe(1);
      expect(preflight.unknownSessionCount).toBe(0);

      const sessions = await test.runtime.listSessions(
        test.socket,
        test.cancel,
        deadline(test.runtime),
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0].name).toBe(SCRATCH_SESSION);
      expect(sessions[0].context).toBe("global");
      expect(isMarked(sessions[0], test.home)).toBe(true);

      // The viewer's own tmux config is sourced by the bootstrap, so their
      // key bindings and options are the ones they already have.
      const userConfig = await test.runtime.runTmux(
        test.socket,
        ["show-options", "-gqv", "@devhub-test-user-config"],
        test.home,
        test.cancel,
        deadline(test.runtime),
      );
      expect(userConfig.stdout.toString("utf8")).toBe("home\n");
    });

    it("declares RGB on the server it creates, so colour is not quantised", async () => {
      const test = fixture("truecolor");
      await test.runtime.ensure(SCRATCH_TARGET);

      const features = await test.runtime.runTmux(
        test.socket,
        ["show-options", "-gqv", "terminal-features"],
        test.home,
        test.cancel,
        deadline(test.runtime),
      );
      // Every client of this server is an xterm.js, which renders 24-bit.
      // Without the declaration tmux asks terminfo instead and a colour ramp
      // comes out in bands.
      expect(features.stdout.toString("utf8")).toContain("*:RGB");
    });

    it("leaves none of its own bootstrap variables in the server's environment", async () => {
      const test = fixture("bootenv");
      await test.runtime.ensure(SCRATCH_TARGET);

      const environment = await test.runtime.runTmux(
        test.socket,
        ["show-environment", "-g"],
        test.home,
        test.cancel,
        deadline(test.runtime),
      );
      // A tmux server hands its whole environment to every shell it starts.
      // The two variables the bootstrap config needed are DevHub's own, and
      // would otherwise appear in `env` in every pane for the life of the
      // server.
      const text = environment.stdout.toString("utf8");
      expect(text).not.toContain("DEVHUB_BOOTSTRAP_ROOT");
      expect(text).not.toContain("DEVHUB_USER_TMUX_CONFIG");
    });

    it("counts a foreign session, never names it, and never kills it", async () => {
      const test = fixture("foreign-count");
      await test.runtime.ensure(SCRATCH_TARGET);
      await test.runtime.runTmux(
        test.socket,
        ["new-session", "-d", "-s", "foreign", "-c", test.home],
        test.home,
        test.cancel,
        deadline(test.runtime),
      );

      const preflight = await test.runtime.preflight(test.socket);
      expect(preflight.state).toBe("marked_sessions");
      expect(preflight.ownedSessionCount).toBe(1);
      expect(preflight.unknownSessionCount).toBe(1);

      const inventory = await test.runtime.inspectOwnedSessions(test.socket);
      expect(inventory.sessions).toEqual([
        { kind: "scratch", sessionName: SCRATCH_SESSION },
      ]);
      expect(inventory.unknownSessionCount).toBe(1);

      await test.runtime.closeOwnedSession(test.socket, {
        kind: "scratch",
        sessionName: SCRATCH_SESSION,
      });
      const remaining = await test.runtime.listSessions(
        test.socket,
        test.cancel,
        deadline(test.runtime),
      );
      // The unknown session is somebody else's work. Cleaning up after
      // ourselves must never take it with us.
      expect(remaining.map((session) => session.name)).toEqual(["foreign"]);

      // Releasing an already released record is complete, not an error.
      await expect(
        test.runtime.closeOwnedSession(test.socket, {
          kind: "scratch",
          sessionName: SCRATCH_SESSION,
        }),
      ).resolves.toBeUndefined();
    });

    it("recreates a Scratch that disappeared from a server it owns", async () => {
      const test = fixture("recreate");
      await test.runtime.ensure(SCRATCH_TARGET);
      await test.runtime.runTmux(
        test.socket,
        ["kill-session", "-t", SCRATCH_SESSION],
        test.home,
        test.cancel,
        deadline(test.runtime),
      );
      // A marker alone is not ownership: the exact session has to be there,
      // and if it is not, it is created through the same metadata chain.
      await test.runtime.ensure(SCRATCH_TARGET);
      const sessions = await test.runtime.listSessions(
        test.socket,
        test.cancel,
        deadline(test.runtime),
      );
      expect(sessions.some((session) => isMarked(session, test.home))).toBe(
        true,
      );
    });

    it("creates and closes a workspace session by its own digest name", async () => {
      const test = fixture("workspace");
      mkdirSync(join(test.home, "workspace"), { recursive: true });
      const root = realpathSync(join(test.home, "workspace"));
      const workspaceId = "00000000-0000-4000-8000-000000000042";
      const target = workspaceTarget(workspaceId, root);
      await test.runtime.ensure(target);

      const sessions = await test.runtime.listSessions(
        test.socket,
        test.cancel,
        deadline(test.runtime),
      );
      expect(sessions).toHaveLength(2);
      const expected = `ws-${workspaceDigest(root).slice(0, 20)}`;
      const session = sessions.find((candidate) => candidate.name === expected);
      expect(session?.context).toBe("workspace");
      expect(session?.workspaceId).toBe(workspaceId);
      expect(session?.root).toBe(root);

      // Asking again is idempotent: the same workspace is the same session.
      await test.runtime.ensure(target);
      expect(
        await test.runtime.listSessions(
          test.socket,
          test.cancel,
          deadline(test.runtime),
        ),
      ).toHaveLength(2);

      await test.runtime.closeWorkspace({ workspaceId, root });
      const afterClose = await test.runtime.listSessions(
        test.socket,
        test.cancel,
        deadline(test.runtime),
      );
      expect(afterClose.map((entry) => entry.name)).toEqual([SCRATCH_SESSION]);
    });

    /**
     * Closing a workspace on purpose ends its work, all of it.
     *
     * A DevHub session outliving the app is the point of the runtime, but that
     * is about *quitting* — see the case below. Closing one particular
     * workspace is the opposite instruction: the person is done with it, and
     * leaving its shell and its Agents running on the socket means they are
     * still there, still holding their directory, at the next launch of an app
     * that no longer has a row for them.
     *
     * The Scratch and a session belonging to another workspace are the control:
     * "close this workspace" must reach exactly this workspace's sessions.
     */
    it("takes a workspace's Agents with it when the workspace is closed", async () => {
      const test = fixture("closeagents");
      mkdirSync(join(test.home, "workspace"), { recursive: true });
      const root = realpathSync(join(test.home, "workspace"));
      const workspaceId = "00000000-0000-4000-8000-000000000044";
      const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9";
      // Another workspace, which nothing here may touch.
      mkdirSync(join(test.home, "other"), { recursive: true });
      const otherRoot = realpathSync(join(test.home, "other"));
      const otherId = "00000000-0000-4000-8000-000000000045";

      const sessions = new AgentSessions(test.runtime);
      await test.runtime.ensure(SCRATCH_TARGET);
      await test.runtime.ensure(workspaceTarget(workspaceId, root));
      await test.runtime.ensure(workspaceTarget(otherId, otherRoot));
      await sessions.launch({
        agentId,
        workspaceId,
        root,
        command: { file: "/bin/sh", args: ["-c", "sleep 30"], env: {} },
      });

      const before = await test.runtime.listSessions(
        test.socket,
        test.cancel,
        deadline(test.runtime),
      );
      expect(before).toHaveLength(4);

      // What an explicit close does, in the order the app does it: the Agents
      // first, then the workspace's own terminal.
      await sessions.terminate(agentId);
      await test.runtime.closeWorkspace({ workspaceId, root });

      const after = await test.runtime.listSessions(
        test.socket,
        test.cancel,
        deadline(test.runtime),
      );
      expect(after.map((entry) => entry.name).sort()).toEqual(
        [
          SCRATCH_SESSION,
          `ws-${workspaceDigest(otherRoot).slice(0, 20)}`,
        ].sort(),
      );
      expect(await sessions.list()).toEqual([]);
    });

    /**
     * The other half of the pair above: what a close ends, a quit keeps.
     *
     * Quitting detaches clients and kills nothing, so the sessions are still
     * on the socket afterwards and the next launch adopts them rather than
     * building new ones — which is what makes coming back find the same shells
     * with the same scrollback and the same Agents mid-turn.
     *
     * That quitting takes no other route is pinned in `surfaces.test.ts`,
     * where `detachAll` is shown never to reach the runtime at all. What is
     * proved here is the end of it that a person would notice: a second
     * runtime on the same socket finds everything, including which Agent
     * belongs to which workspace.
     */
    it("leaves its sessions on the socket for the next launch to adopt", async () => {
      const test = fixture("quitkeeps");
      mkdirSync(join(test.home, "workspace"), { recursive: true });
      const root = realpathSync(join(test.home, "workspace"));
      const workspaceId = "00000000-0000-4000-8000-000000000046";
      const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab0";

      const sessions = new AgentSessions(test.runtime);
      await test.runtime.ensure(SCRATCH_TARGET);
      await test.runtime.ensure(workspaceTarget(workspaceId, root));
      await sessions.launch({
        agentId,
        workspaceId,
        root,
        command: { file: "/bin/sh", args: ["-c", "sleep 30"], env: {} },
      });

      // A fresh runtime on the same socket is what the next launch is: it
      // adopts what is there rather than rebuilding it, which is only true if
      // quitting left it there.
      const relaunched = fixture("quitkeeps2");
      const adopted = new TmuxTerminalRuntime({
        context: { home: test.home, environment: { ...process.env } },
        tmux: {
          kind: "resolved",
          value: { path: TMUX as string, basename: "tmux" },
        },
        shell: { path: "/bin/zsh", basename: "zsh" },
        tmuxArgs: [],
        effectiveSocketName: test.socket,
        timeoutMs: 10_000,
        bootstrapDirectory: relaunched.home,
      });

      const after = await adopted.listSessions(
        test.socket,
        test.cancel,
        deadline(adopted),
      );
      expect(after.map((entry) => entry.name).sort()).toEqual(
        [
          SCRATCH_SESSION,
          agentSessionName(agentId),
          `ws-${workspaceDigest(root).slice(0, 20)}`,
        ].sort(),
      );
      expect(await new AgentSessions(adopted).list()).toEqual([
        { agentId, workspaceId },
      ]);
    });

    it("reports what a workspace terminal would destroy", async () => {
      const test = fixture("inspect");
      mkdirSync(join(test.home, "workspace"), { recursive: true });
      const root = realpathSync(join(test.home, "workspace"));
      const target = workspaceTarget(
        "00000000-0000-4000-8000-000000000043",
        root,
      );
      await test.runtime.ensure(target);
      // A session that is only a shell is clean; nothing would be lost.
      const inspection = await test.runtime.inspect(target);
      expect(inspection.extraPanes).toEqual({ kind: "clean" });
      expect(inspection.extraWindows).toEqual({ kind: "clean" });
    });

    it("costs the same number of tmux processes whatever the session count", async () => {
      const test = fixture("processes", undefined, { counting: true });
      const targets = [];
      for (let index = 0; index < 8; index += 1) {
        const root = join(test.home, `workspace-${index}`);
        mkdirSync(root, { recursive: true });
        targets.push(
          workspaceTarget(
            `00000000-0000-4000-8000-00000000005${index}`,
            realpathSync(root),
          ),
        );
      }
      await test.runtime.ensure(SCRATCH_TARGET);
      for (const target of targets) await test.runtime.ensure(target);

      // Nine marked sessions exist. Attaching to one that is already there
      // takes a fixed five commands whatever the count is, because each of the
      // two inventories it reads is a single `list-sessions`. Reading the
      // markers a field at a time cost `4N` per inventory instead: the same
      // attach measured 78 processes here, and grew by eight with every
      // workspace the viewer had open.
      const attachStart = test.tmuxRuns();
      await test.runtime.ensure(targets[0]);
      expect(test.tmuxRuns() - attachStart).toBe(5);

      // An inspection reads the marker, the inventory, and both of its
      // listings — the windows and the panes share one command. It measured
      // 41 before.
      const inspectStart = test.tmuxRuns();
      const inspection = await test.runtime.inspect(targets[0]);
      expect(inspection.extraPanes).toEqual({ kind: "clean" });
      expect(test.tmuxRuns() - inspectStart).toBe(3);
    });

    it("keeps a root that contains a newline whole in the inventory", async () => {
      const test = fixture("newline-root");
      // The listing is delimited by DevHub's own record separator rather than
      // by tmux's newline, so a path that contains a newline is still one
      // marker and not two half-read sessions.
      mkdirSync(join(test.home, "two\nlines"), { recursive: true });
      const root = realpathSync(join(test.home, "two\nlines"));
      const target = workspaceTarget(
        "00000000-0000-4000-8000-000000000044",
        root,
      );
      await test.runtime.ensure(target);

      const sessions = await test.runtime.listSessions(
        test.socket,
        test.cancel,
        deadline(test.runtime),
      );
      const created = sessions.find((session) => session.root === root);
      expect(created).toBeDefined();
      expect(created?.context).toBe("workspace");
      // And the identity it read back is the one an attach accepts.
      await test.runtime.ensure(target);
    });

    it("refuses a server whose marker is not DevHub's, and leaves it alone", async () => {
      const test = fixture("wrong-marker");
      tmuxOutside(test.socket, [
        "new-session",
        "-d",
        "-s",
        "foreign",
        "-c",
        test.home,
      ]);
      tmuxOutside(test.socket, ["set-option", "-g", "@devhub-protocol", "999"]);

      expect((await test.runtime.preflight(test.socket)).state).toBe(
        "wrong_marker",
      );
      await expect(test.runtime.ensure(SCRATCH_TARGET)).rejects.toThrowError(
        expect.objectContaining({ code: "conflict" }) as unknown as Error,
      );
      await expect(
        test.runtime.inspectOwnedSessions(test.socket),
      ).rejects.toThrowError(
        expect.objectContaining({ code: "conflict" }) as unknown as Error,
      );
      const sessions = await test.runtime.listSessions(
        test.socket,
        test.cancel,
        deadline(test.runtime),
      );
      expect(sessions.map((session) => session.name)).toEqual(["foreign"]);
    });

    it("treats a live server with no marker as foreign, not as absent", async () => {
      const test = fixture("no-marker");
      tmuxOutside(test.socket, [
        "new-session",
        "-d",
        "-s",
        "foreign",
        "-c",
        test.home,
      ]);
      // Absent would mean "create a server here"; this one is already
      // somebody's, so it fails closed instead.
      expect((await test.runtime.preflight(test.socket)).state).toBe(
        "wrong_marker",
      );
    });

    it("never claims a Scratch a trusted user config created first", async () => {
      const test = fixture("foreign-scratch");
      writeFileSync(
        join(test.home, ".tmux.conf"),
        [
          `new-session -d -s ${SCRATCH_SESSION} -c "$DEVHUB_BOOTSTRAP_ROOT"`,
          `set-option -t ${SCRATCH_SESSION} @devhub-context foreign`,
          `set-option -t ${SCRATCH_SESSION} @devhub-workspace-id foreign`,
          `set-option -t ${SCRATCH_SESSION} @devhub-root /foreign`,
          "",
        ].join("\n"),
      );

      // The ownership transaction is one command sequence, so the duplicate
      // new-session stops it before the global marker is ever committed.
      await expect(test.runtime.ensure(SCRATCH_TARGET)).rejects.toThrowError(
        expect.objectContaining({ code: "conflict" }) as unknown as Error,
      );
      const sessions = await test.runtime.listSessions(
        test.socket,
        test.cancel,
        deadline(test.runtime),
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0].name).toBe(SCRATCH_SESSION);
      expect(sessions[0].context).toBe("foreign");
      expect(sessions[0].root).toBe("/foreign");
      const marker = await test.runtime.runTmux(
        test.socket,
        ["show-options", "-gqv", "@devhub-protocol"],
        test.home,
        test.cancel,
        deadline(test.runtime),
      );
      expect(marker.stdout.toString("utf8")).not.toBe("1\n");
    });

    it("follows a socket change once the transition commits it", async () => {
      const test = fixture("rebind");
      await test.runtime.ensure(SCRATCH_TARGET);
      sequence += 1;
      const rebound = socketName(`dhrebind${process.pid}${sequence}`);
      fixtures.push({ ...test, socket: rebound });

      // A transition holds the gate: inventory the old socket, adopt the new
      // one, then commit the effective name.
      const release = await test.runtime.beginTransition();
      try {
        // Inside a transition the gate is already held, so these are the
        // ungated variants — the same ones the settings flow uses.
        const inventory = await test.runtime.transitionInspectOwnedSessions(
          test.socket,
          test.cancel,
        );
        expect(inventory.sessions).toHaveLength(1);
        expect(
          (await test.runtime.transitionPreflight(rebound, test.cancel)).state,
        ).toBe("target_absent");
        await test.runtime.transitionEnsureOnSocket(
          rebound,
          SCRATCH_TARGET,
          test.cancel,
        );
        test.runtime.setEffectiveSocket(rebound);
      } finally {
        release();
      }

      // Ordinary operations now go to the new socket without being told.
      await test.runtime.ensure(SCRATCH_TARGET);
      const sessions = await test.runtime.listSessions(
        rebound,
        test.cancel,
        deadline(test.runtime),
      );
      expect(sessions.some((session) => session.name === SCRATCH_SESSION)).toBe(
        true,
      );
      // The sessions on the socket being left behind are still there: the
      // viewer decides whether to close them.
      const old = await test.runtime.listSessions(
        test.socket,
        test.cancel,
        deadline(test.runtime),
      );
      expect(old.some((session) => session.name === SCRATCH_SESSION)).toBe(
        true,
      );
    });

    it("answers a health recheck from the live socket", async () => {
      const test = fixture("health");
      expect(await test.runtime.recheckHealth()).toBe(true);
      await test.runtime.ensure(SCRATCH_TARGET);
      expect(await test.runtime.recheckHealth()).toBe(true);
    });

    /**
     * The property this whole transport exists for: an Agent's session ends
     * exactly when its command does, and nothing has to be told about it.
     */
    it("ends an Agent session when the Agent's own command exits", async () => {
      const test = fixture("agentexit");
      const sessions = new AgentSessions(test.runtime);
      const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
      const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
      await test.runtime.ensure(SCRATCH_TARGET);

      await sessions.launch({
        agentId,
        workspaceId,
        root: test.home,
        // `sleep` stands in for an agent CLI: a real command, run directly
        // as the session command, that ends on its own.
        command: { file: "/bin/sh", args: ["-c", "sleep 30"], env: {} },
      });

      expect(await sessions.list()).toEqual([{ agentId, workspaceId }]);
      const listed = await test.runtime.listSessions(
        test.socket,
        test.cancel,
        deadline(test.runtime),
      );
      const session = listed.find(
        (candidate) => candidate.name === agentSessionName(agentId),
      );
      expect(session).toBeDefined();
      expect(isMarked(session as never, test.home)).toBe(true);
      expect(session?.agentId).toBe(agentId);

      // Kill the Agent's process, not its session. tmux takes the session
      // with it, and the next list is the only signal the row needs.
      tmuxOutside(test.socket, [
        "send-keys",
        "-t",
        agentSessionName(agentId),
        "C-c",
      ]);
      await untilGone(sessions, agentId);
      expect(await sessions.list()).toEqual([]);
    });

    it("carries the profile's environment into the Agent's pane", async () => {
      const test = fixture("agentenv");
      const sessions = new AgentSessions(test.runtime);
      const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
      const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
      const marker = join(test.home, "agent-env.txt");
      await test.runtime.ensure(SCRATCH_TARGET);

      await sessions.launch({
        agentId,
        workspaceId,
        root: test.home,
        command: {
          file: "/bin/sh",
          args: [
            "-c",
            'printf %s "$DEVHUB_TEST_VALUE" > "$1"; sleep 30',
            "sh",
            marker,
          ],
          env: { DEVHUB_TEST_VALUE: "carried" },
        },
      });
      await untilFile(marker);
      expect(readFileSync(marker, "utf8")).toBe("carried");

      // Terminating is the exact-record kill, and it takes the pane with it.
      await sessions.terminate(agentId);
      expect(await sessions.list()).toEqual([]);
    });

    it("reads an Agent's own screen and title, and only that Agent's", async () => {
      const test = fixture("agentcap");
      const sessions = new AgentSessions(test.runtime);
      const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
      const other = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
      const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4";
      await test.runtime.ensure(SCRATCH_TARGET);

      await sessions.launch({
        agentId,
        workspaceId,
        root: test.home,
        // Print a line, set an OSC 2 title, then stay alive.
        command: {
          file: "/bin/sh",
          args: [
            "-c",
            "printf 'on the screen\\n'; printf '\\033]2;a title\\007'; sleep 30",
          ],
          env: {},
        },
      });
      await untilTitle(sessions, agentId, workspaceId);
      const screen = await sessions.screen(agentId, workspaceId);
      expect(screen.oscTitle).toBe("a title");
      expect(screen.screen).toContain("on the screen");

      // The id is checked in the same tmux command as the read, so asking
      // about an Agent whose session is not there refuses rather than
      // returning somebody else's pane.
      await expect(sessions.screen(other, workspaceId)).rejects.toThrow();
    });

    it("refuses to resurrect an Agent whose session has ended", async () => {
      const test = fixture("agentgone");
      const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
      const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
      await test.runtime.ensure(SCRATCH_TARGET);

      // `ensure` creates a terminal, because a terminal is a place. An Agent
      // is a process, so the same call must refuse rather than hand back an
      // empty shell wearing the Agent's name.
      await expect(
        test.runtime.ensure({
          kind: "agent",
          agentId,
          workspaceId,
          root: test.home,
        }),
      ).rejects.toThrow();
    });

    /**
     * A server left by a DevHub from before `@devhub-agent-id` existed.
     *
     * This is the shape that took the whole runtime down: `ensureScratch`
     * compares the complete marker tuple, `scratch` carried only the three
     * markers that existed when it was created, and the mismatch was a
     * conflict. Every operation goes through `ensureServer`, so no agent could
     * launch and no workbench terminal could attach — on a socket holding
     * DevHub's own sessions, with DevHub's own protocol marker on it.
     */
    it("adopts its own sessions from before the agent-id marker existed", async () => {
      const test = fixture("premarker");
      const workspaceId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
      const agentId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
      const digest = workspaceDigest(test.home);

      // Built from outside, exactly as the older DevHub wrote it: the server
      // protocol marker, and sessions carrying context, workspace id and root
      // — and no agent-id option at all.
      tmuxOutside(test.socket, [
        "new-session",
        "-d",
        "-s",
        SCRATCH_SESSION,
        "-c",
        test.home,
      ]);
      tmuxOutside(test.socket, ["set-option", "-g", "@devhub-protocol", "1"]);
      for (const [option, value] of [
        ["@devhub-context", "global"],
        ["@devhub-workspace-id", "global"],
        ["@devhub-root", test.home],
      ]) {
        tmuxOutside(test.socket, [
          "set-option",
          "-t",
          SCRATCH_SESSION,
          option,
          value,
        ]);
      }
      const workspaceSession = `ws-${digest.slice(0, 20)}`;
      tmuxOutside(test.socket, [
        "new-session",
        "-d",
        "-s",
        workspaceSession,
        "-c",
        test.home,
      ]);
      for (const [option, value] of [
        ["@devhub-context", "workspace"],
        ["@devhub-workspace-id", workspaceId],
        ["@devhub-root", test.home],
      ]) {
        tmuxOutside(test.socket, [
          "set-option",
          "-t",
          workspaceSession,
          option,
          value,
        ]);
      }

      // An absent agent-id marker reads as `none`, so these are DevHub's own
      // sessions and the tuple matches.
      const sessions = await test.runtime.listSessions(
        test.socket,
        test.cancel,
        deadline(test.runtime),
      );
      for (const session of sessions) {
        expect(isMarked(session, test.home)).toBe(true);
      }

      // The two operations the user could not perform: a workbench terminal
      // attaching to the workspace session that is already there, and an Agent
      // launching at all. Both go through `ensureServer`, which is what the
      // mismatch was taking down.
      await test.runtime.ensure(SCRATCH_TARGET);
      await test.runtime.ensure(workspaceTarget(workspaceId, test.home));
      await test.runtime.launchAgent(
        { agentId, workspaceId, root: test.home },
        { file: "/bin/sh", args: ["-c", "sleep 30"], env: {} },
      );

      const live = await test.runtime.listAgents(test.cancel);
      expect(live.map((one) => one.sessionName)).toContain(
        agentSessionName(agentId),
      );

      // The pre-existing sessions are still the ones that were there: adopting
      // them must not have replaced or renamed anything.
      const after = await test.runtime.listSessions(
        test.socket,
        test.cancel,
        deadline(test.runtime),
      );
      expect(after.map((one) => one.name)).toContain(SCRATCH_SESSION);
      expect(after.map((one) => one.name)).toContain(workspaceSession);
    });

    /**
     * Queued text reaches a real pane, and only once its prompt has settled.
     *
     * The Agent here is a script rather than Claude Code: it prints the very
     * screen the fixtures captured from a real one — so the detector reads it
     * as idle for the same reason it reads the real thing as idle — and then
     * waits on a line of input and writes down exactly what arrived. That
     * makes the whole path testable without a paid CLI: real tmux, real
     * `send-keys`, real bracketed paste, the real detector and the real queue.
     *
     * The one thing a fake cannot prove is how Claude Code itself renders a
     * paste, and that was measured by hand against 2.1.257: three lines went
     * into the prompt box as one message and nothing was submitted until the
     * Enter that follows.
     */
    it("types queued text into an Agent once its prompt has settled", async () => {
      const test = fixture("inject");
      const sessions = new AgentSessions(test.runtime);
      const detector = new AgentStatusDetector();
      const queue = new AgentInjectionQueue();
      const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
      const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5";
      const landed = join(test.home, "received.txt");
      const screenFile = join(test.home, "screen.txt");
      const script = join(test.home, "fake-agent.py");
      writeFileSync(screenFile, CLAUDE_IDLE.screen);
      // Raw bytes, verbatim: a shell's `read` would eat the carriage returns
      // that are the whole point, and the markers have to be seen as sent.
      writeFileSync(
        script,
        [
          "import os, select, sys, termios, time, tty",
          // A TUI puts its terminal in raw mode; a cooked one would have the
          // line discipline turn the carriage returns into newlines before
          // the program ever saw them.
          "tty.setraw(sys.stdin.fileno())",
          "sys.stdout.write(open(sys.argv[1]).read())",
          "sys.stdout.flush()",
          "buf = b''",
          "end = time.time() + 25",
          "closed_at = None",
          "enter_at = None",
          "while time.time() < end:",
          "    r, _, _ = select.select([sys.stdin], [], [], 0.05)",
          "    if r:",
          "        chunk = os.read(sys.stdin.fileno(), 65536)",
          "        if not chunk: break",
          "        buf += chunk",
          "        if closed_at is None and b'\\x1b[201~' in buf:",
          "            closed_at = time.time()",
          "        elif closed_at is not None and b'\\r' in chunk:",
          "            enter_at = time.time()",
          "            break",
          "gap = -1 if (closed_at is None or enter_at is None) else int((enter_at - closed_at) * 1000)",
          "open(sys.argv[2], 'wb').write(buf + b'\\n--GAP--' + str(gap).encode())",
          "time.sleep(30)",
          "",
        ].join("\n"),
      );
      await test.runtime.ensure(SCRATCH_TARGET);

      await sessions.launch({
        agentId,
        workspaceId,
        root: test.home,
        command: {
          file: "/usr/bin/python3",
          args: [script, screenFile, landed],
          env: {},
        },
      });

      const text =
        "First line.\nSecond line, which must not submit on its own.";
      queue.queue(agentId, text);

      let sends = 0;
      const firstIdleAt = { at: 0 };
      let sentAt = 0;
      for (let round = 0; round < 80; round += 1) {
        const screen = await sessions
          .screen(agentId, workspaceId)
          .catch(() => undefined);
        if (screen) {
          const status = detector.status("claude", screen);
          if (status === "idle" && firstIdleAt.at === 0) {
            firstIdleAt.at = Date.now();
          }
          const due = queue.due(agentId, status);
          if (due !== undefined) {
            await sessions.inject(agentId, workspaceId, due);
            queue.sent(agentId);
            sends += 1;
            sentAt = Date.now();
          }
        }
        if (existsSync(landed)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // The prompt had to look free for a whole second before anything went
      // into it — the real clock, not a count of rounds.
      expect(sentAt - firstIdleAt.at).toBeGreaterThanOrEqual(IDLE_SETTLE_MS);

      expect(existsSync(landed)).toBe(true);
      const received = readFileSync(landed, "utf8");
      // Wrapped as a paste, so the program on the other end knows the lines
      // arrived together rather than as two submissions.
      expect(received).toContain("\u001b[200~");
      expect(received).toContain("\u001b[201~");
      expect(received).toContain("First line.");
      expect(received).toContain(
        "Second line, which must not submit on its own.",
      );
      // A line break inside a paste travels as a carriage return; a bare
      // newline is dropped, which is two lines arriving as one sentence.
      expect(received).toContain("First line.\rSecond line");
      // Once. The queue empties on the send, so a later idle round is not a
      // second delivery.
      expect(sends).toBe(1);

      /*
       * And the Return came well after the paste finished.
       *
       * A TUI that never saw the bracketed-paste markers decides for itself
       * whether a fast run of characters was typed or pasted, and while it
       * thinks a paste is in progress a Return inserts a newline instead of
       * submitting. Codex's window for that is 120ms
       * (`PASTE_ENTER_SUPPRESS_WINDOW`), so the gap has to clear it — which is
       * the difference between the instruction being sent and it sitting in
       * the box with a blank line under it.
       */
      const gap = Number(received.split("--GAP--").at(-1));
      expect(gap).toBeGreaterThan(120);
    });

    /** The gate itself, against the states a real Agent actually passes through. */
    it("holds text back while an Agent is busy or asking", async () => {
      const queue = new AgentInjectionQueue();
      const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6";
      queue.queue(agentId, "do the thing");
      for (let round = 0; round < 30; round += 1) {
        expect(queue.due(agentId, "working")).toBeUndefined();
        expect(queue.due(agentId, "waiting")).toBeUndefined();
        expect(queue.due(agentId, "unknown")).toBeUndefined();
      }
      expect(queue.state(agentId, "waiting").waitingFor).toBe("agent_asking");
    });

    /**
     * The size latch an earlier build left behind, cleared on the next open.
     *
     * That build resized the session's window explicitly whenever its client
     * resized, and an explicit `resize-window` pins the window to
     * `window-size manual` permanently. Removing the call does not undo the
     * pin: it is held in the tmux server, and the server outlives the app — so
     * a person who closed DevHub and reopened it at a different size kept
     * getting the old one. The repair has to happen on a session that already
     * exists, which is every session a person actually has.
     */
    it("frees a window an older build pinned to a fixed size", async () => {
      const test = fixture("windowsize");
      const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4";
      const target = workspaceTarget(workspaceId, test.home);
      await test.runtime.ensure(SCRATCH_TARGET);
      await test.runtime.ensure(target);
      const session = `ws-${workspaceDigest(test.home).slice(0, 20)}`;

      // Exactly what the old build did on every client resize.
      tmuxOutside(test.socket, [
        "resize-window",
        "-t",
        session,
        "-x",
        "80",
        "-y",
        "24",
      ]);
      expect(windowSize(test.socket, session)).toBe("manual");

      // The path every open takes.
      await test.runtime.ensure(target);

      expect(windowSize(test.socket, session)).toBe("latest");
    });

    /**
     * An Agent's pane starts with nothing in its title.
     *
     * The whole of "has this Agent said anything?" rests on this: tmux gives a
     * new pane the host name, and if that were left there DevHub would have to
     * guess which titles were the Agent's own. It is blanked at creation, so
     * an empty title means silence and anything else is the Agent speaking.
     *
     * A workspace session is left alone, because tmux names the person's own
     * windows after the pane title and those names are theirs.
     */
    it("gives an Agent a blank pane title, and leaves a workspace's alone", async () => {
      const test = fixture("panetitle");
      const sessions = new AgentSessions(test.runtime);
      const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
      const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
      await test.runtime.ensure(SCRATCH_TARGET);
      await test.runtime.ensure(workspaceTarget(workspaceId, test.home));

      await sessions.launch({
        agentId,
        workspaceId,
        root: test.home,
        command: { file: "/bin/sh", args: ["-c", "sleep 30"], env: {} },
      });

      expect(paneTitle(test.socket, agentSessionName(agentId))).toBe("");
      // tmux's own default, untouched: the host name it gives every new pane.
      expect(
        paneTitle(test.socket, `ws-${workspaceDigest(test.home).slice(0, 20)}`),
      ).not.toBe("");
    });

    /**
     * An Agent session is not a tmux the user drives, so it carries no status
     * bar; the sessions the user *does* drive are left as their own config
     * made them.
     */
    it("turns the status bar off for an Agent, and leaves it alone elsewhere", async () => {
      const test = fixture("agentstatus");
      const sessions = new AgentSessions(test.runtime);
      const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7";
      const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7";
      await test.runtime.ensure(SCRATCH_TARGET);
      await test.runtime.ensure(workspaceTarget(workspaceId, test.home));

      await sessions.launch({
        agentId,
        workspaceId,
        root: test.home,
        command: { file: "/bin/sh", args: ["-c", "sleep 30"], env: {} },
      });

      expect(sessionStatus(test.socket, agentSessionName(agentId))).toBe("off");
      // Scratch and the workspace terminal are the user's own tmux. DevHub
      // sets nothing on them — an unset session option reads as empty — so
      // whatever the user's own config asked for is what they get, which with
      // no config of their own is tmux's default of a visible bar.
      expect(sessionStatus(test.socket, SCRATCH_SESSION)).toBe("");
      expect(
        sessionStatus(
          test.socket,
          `ws-${workspaceDigest(test.home).slice(0, 20)}`,
        ),
      ).toBe("");
      expect(effectiveStatus(test.socket, SCRATCH_SESSION)).toBe("on");
    });

    /**
     * The rule is stated wherever ownership is proven, not only at creation,
     * so an Agent session left over from a build that did not know about it is
     * corrected the next time DevHub opens it.
     */
    it("takes the status bar off an Agent session an older build created", async () => {
      const test = fixture("agentmigrate");
      const sessions = new AgentSessions(test.runtime);
      const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8";
      const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb8";
      await test.runtime.ensure(SCRATCH_TARGET);
      await sessions.launch({
        agentId,
        workspaceId,
        root: test.home,
        command: { file: "/bin/sh", args: ["-c", "sleep 30"], env: {} },
      });

      // Put the session back into the state an older build would have left it.
      tmuxOutside(test.socket, [
        "set-option",
        "-t",
        agentSessionName(agentId),
        "status",
        "on",
      ]);
      expect(sessionStatus(test.socket, agentSessionName(agentId))).toBe("on");

      // The path every open takes.
      await test.runtime.ensure({
        kind: "agent",
        agentId,
        workspaceId,
        root: test.home,
      });

      expect(sessionStatus(test.socket, agentSessionName(agentId))).toBe("off");
    });
  },
);

function showOption(
  socket: string,
  session: string,
  args: readonly string[],
): string {
  return execFileSync(
    TMUX as string,
    ["-L", socket, "show-options", "-t", session, ...args, "status"],
    {
      encoding: "utf8",
      env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined } as never,
    },
  ).trim();
}

/**
 * What the session itself says about its status bar — empty when it says
 * nothing, which is how "DevHub declared nothing here" is spelled.
 */
function sessionStatus(socket: string, session: string): string {
  return showOption(socket, session, ["-v"]);
}

/** What the session ends up with, inherited values included. */
function effectiveStatus(socket: string, session: string): string {
  return showOption(socket, session, ["-A", "-v"]);
}

async function untilGone(
  sessions: AgentSessions,
  agentId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const live = await sessions.list();
    if (!live.some((one) => one.agentId === agentId)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the Agent session outlived its command");
}

async function untilTitle(
  sessions: AgentSessions,
  agentId: string,
  workspaceId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const screen = await sessions.screen(agentId, workspaceId);
    if (screen.oscTitle.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the Agent never set a title");
}

async function untilFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the Agent never wrote its marker file");
}

/** One pane's title, read from outside the runtime under test. */
function paneTitle(socket: string, session: string): string {
  return execFileSync(
    TMUX as string,
    ["-L", socket, "display-message", "-p", "-t", session, "#{pane_title}"],
    {
      encoding: "utf8",
      env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined } as never,
    },
  ).trim();
}

/** Whether a window still follows its client, read from outside. */
function windowSize(socket: string, session: string): string {
  return execFileSync(
    TMUX as string,
    ["-L", socket, "display-message", "-p", "-t", session, "#{window-size}"],
    {
      encoding: "utf8",
      env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined } as never,
    },
  ).trim();
}
