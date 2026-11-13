// Start DevHub from this checkout on the stability profile, with a CDP port,
// and end it — and the tmux server it started — whatever happened.
//
// Like scripts/smoke_packaged_app.py's source run, every location a live
// DevHub owns moves: HOME, XDG_CONFIG_HOME, XDG_STATE_HOME and TMUX_TMPDIR into
// the run's directory, and the profile names the tmux socket
// (`devhub-stability`) and the data directories.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { appDir, PROFILE } from "./profile.mjs";

const electron = () =>
  execFileSync(join(appDir, "scripts", "electron-path.sh"))
    .toString()
    .trim();
const tmux = join(appDir, "out", "tmux", "bin", "tmux");
const cliBinary = () => {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const os = process.platform === "darwin" ? "darwin" : "linux";
  return join(appDir, "out", "cli", `${os}-${arch}`, "devhub");
};

function environment(paths) {
  const env = { ...process.env };
  // Nothing of the session the harness runs in leaks into the app: not an
  // enclosing tmux, nor an agent's own variables.
  for (const name of Object.keys(env)) {
    if (/^(CLAUDE|ANTHROPIC|TMUX|GIT_EDITOR|NVIM|VIM)/.test(name))
      delete env[name];
  }
  if (env.NODE_OPTIONS) {
    env.NODE_OPTIONS = env.NODE_OPTIONS.replace(/--use-openssl-ca/g, "").trim();
    if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS;
  }
  Object.assign(env, {
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_STATE_HOME: paths.state,
    XDG_DATA_HOME: join(paths.home, ".local", "share"),
    XDG_CACHE_HOME: join(paths.home, ".cache"),
    TMUX_TMPDIR: paths.tmux,
    DEVHUB_PROFILE: PROFILE,
    SHELL: "/bin/bash",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    NODE_ENV: "development",
    ELECTRON_ENABLE_LOGGING: "1",
  });
  return env;
}

function userDataDir(env) {
  const out = execFileSync(
    electron(),
    [join(appDir, "out", "main", "profilePaths.js")],
    {
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    },
  ).toString();
  const line = out
    .split("\n")
    .find((l) => l.startsWith("DEVHUB_USER_DATA_DIR="));
  if (!line)
    throw new Error(`profilePaths.js named no user data directory:\n${out}`);
  return line.slice("DEVHUB_USER_DATA_DIR=".length).replace(/^'|'$/g, "");
}

function ask(socket, request, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let buffered = "";
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error(`no answer to ${request.kind} within ${timeoutMs} ms`));
    }, timeoutMs);
    client.on("connect", () => client.write(`${JSON.stringify(request)}\n`));
    client.on("data", (chunk) => {
      buffered += chunk;
      const end = buffered.indexOf("\n");
      if (end >= 0) {
        clearTimeout(timer);
        client.end();
        resolve(JSON.parse(buffered.slice(0, end)));
      }
    });
    client.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function startApp(
  paths,
  { port, size = [1400, 900], logPath, neovimDelayMs },
) {
  const env = environment(paths);
  // Every round trip to Neovim this much longer (src/main/neovimHost/delayProxy.ts).
  if (neovimDelayMs) env.DEVHUB_NEOVIM_DELAY_MS = String(neovimDelayMs);
  const userData = userDataDir(env);
  mkdirSync(userData, { recursive: true });
  const args = [
    appDir,
    "--user-data-dir",
    userData,
    `--remote-debugging-port=${port}`,
    "--force-device-scale-factor=1",
    // Software GL on Xvfb either way; this keeps the compositor on the CPU
    // path every run, rather than whichever the driver probe chose.
    "--disable-gpu",
    `--window-size=${size[0]},${size[1]}`,
  ];
  if (process.getuid?.() === 0) args.push("--no-sandbox");
  const log = openSync(logPath, "w");
  const child = spawn(electron(), args, {
    env,
    cwd: paths.home,
    stdio: ["ignore", log, log],
    detached: true,
  });
  const socket = join(userData, "devhub", "control.sock");
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`the app exited (${child.exitCode}); see ${logPath}`);
    if (existsSync(socket)) {
      try {
        const reply = await ask(socket, { kind: "version" }, 2_000);
        if (reply.ok) break;
      } catch {
        // not listening yet
      }
    }
    if (Date.now() > deadline)
      throw new Error(`the app never answered on ${socket}; see ${logPath}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    child,
    env,
    socket,
    port,
    /** `devhub <args>` from `cwd`, as a person types it. */
    cli(args, cwd) {
      return execFileSync(cliBinary(), args, {
        cwd,
        env: {
          ...env,
          DEVHUB_CONTROL_SOCKET: socket,
          DEVHUB_LAUNCH_COMMAND: '["/bin/false"]',
        },
        timeout: 30_000,
      }).toString();
    },
    /** The app's own tmux, on the profile's server. */
    tmux(...args) {
      return execFileSync(tmux, ["-L", `devhub-${PROFILE}`, ...args], {
        env,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
    },
    stop() {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
      try {
        execFileSync(tmux, ["-L", `devhub-${PROFILE}`, "kill-server"], {
          env,
          stdio: "ignore",
        });
      } catch {
        // no server
      }
    },
  };
}
