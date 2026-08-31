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
}

const fixtures: Fixture[] = [];

function fixture(label: string, environment?: Record<string, string>): Fixture {
  sequence += 1;
  const home = realpathSync(scratchDirectory(`tmux-${label}`));
  const socket = socketName(`dh${label}${process.pid}${sequence}`);
  const runtime = new TmuxTerminalRuntime({
    context: {
      home,
      environment: { ...process.env, ...environment },
    },
    tmux: {
      kind: "resolved",
      value: { path: TMUX as string, basename: "tmux" },
    },
    shell: { path: "/bin/zsh", basename: "zsh" },
    tmuxArgs: [],
    effectiveSocketName: socket,
    timeoutMs: 10_000,
    // Scratch stays inside the repository, never in the OS temp directory.
    bootstrapDirectory: home,
  });
  const created = { home, runtime, socket, cancel: new CancellationToken() };
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
  },
);

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
