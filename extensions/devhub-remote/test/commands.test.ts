import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
  CONFIG_COUNT_KEY,
  OFFER_DISMISSED_KEY,
  OFFER_MESSAGE,
  OFFER_NEVER,
  OFFER_REOPEN,
  offerReopenInContainer,
  refreshAvailability,
  reopenInContainer,
  reopenLocally,
  SHOW_BUILD_LOG,
  showBuildLog,
  switchContainer,
  type CommandsApi,
  type DevHubConnection,
} from "../src/commands";
import type { DevContainerConfig, ReattachTarget } from "../src/control";

const WINDOW = {
  scheme: "file",
  authority: "",
  path: "/src/api",
  fsPath: "/src/api",
};
const DEFAULT = { path: "/src/api/.devcontainer/devcontainer.json" };
const PYTHON = {
  path: "/src/api/.devcontainer/python/devcontainer.json",
  label: "python",
};

/** A window and a DevHub that record what was asked of them. */
function world(options: {
  configs: DevContainerConfig[];
  current?: string;
  picks?: (labels: string[]) => number | undefined;
  refuse?: string;
  /** The action chosen on an error notice. */
  answers?: string;
  /** Whether a build log exists to show. */
  logExists?: boolean;
  /** The action chosen on the info notice. */
  offerAnswer?: string;
  remote?: string;
  scheme?: string;
  dismissed?: boolean;
}) {
  const infos: string[] = [];
  const flags = new Map<string, boolean>();
  if (options.dismissed) flags.set(OFFER_DISMISSED_KEY, true);
  const said: string[] = [];
  const offeredActions: string[][] = [];
  /** What happened to build logs, in order. */
  const logs: string[] = [];
  const context = new Map<string, unknown>();
  const reattached: ReattachTarget[] = [];
  const offered: string[][] = [];
  const api: CommandsApi = {
    windowFolder: () => ({ ...WINDOW, scheme: options.scheme ?? "file" }),
    remoteName: () => options.remote,
    showInfo: (message) => {
      infos.push(message);
      return Promise.resolve(options.offerAnswer);
    },
    getFlag: (key) => flags.get(key) === true,
    setFlag: (key, value) => {
      flags.set(key, value);
      return Promise.resolve();
    },
    pick: (items) => {
      const labels = items.map((item) => item.label);
      offered.push(labels);
      const index = options.picks?.(labels);
      return Promise.resolve(index === undefined ? undefined : items[index]);
    },
    showError: (message, ...actions) => {
      said.push(message);
      offeredActions.push(actions);
      return Promise.resolve(options.answers);
    },
    followBuildLog: (path) => {
      logs.push(`follow ${path}`);
      return Promise.resolve({
        stop: () => {
          logs.push(`stop ${path}`);
          return Promise.resolve();
        },
      });
    },
    showBuildLog: (path) => {
      logs.push(`show ${path}`);
      return Promise.resolve(options.logExists ?? true);
    },
    withProgress: (_title, work) => {
      logs.push("reattaching");
      return work();
    },
    setContext: (key, value) => {
      context.set(key, value);
    },
  };
  const devhub: DevHubConnection = {
    configs: () =>
      Promise.resolve({
        ok: true,
        message: "",
        devContainers: { configs: options.configs, current: options.current },
      }),
    buildLog: (_window, configPath) =>
      Promise.resolve({
        ok: true,
        message: "",
        buildLog: `/logs/${configPath.split("/").at(-2) ?? ""}.log`,
      }),
    reattach: (_window, to) => {
      reattached.push(to);
      return Promise.resolve(
        options.refuse === undefined
          ? { ok: true, message: "reattached" }
          : { ok: false, message: options.refuse },
      );
    },
  };
  return {
    api,
    devhub,
    said,
    context,
    reattached,
    offered,
    logs,
    offeredActions,
    infos,
    flags,
  };
}

test("a folder with one definition is reopened in it without a question", async () => {
  const { api, devhub, reattached, offered } = world({ configs: [DEFAULT] });
  await reopenInContainer(api, devhub);
  deepStrictEqual(reattached, [{ configPath: DEFAULT.path }]);
  deepStrictEqual(offered, []);
});

test("a folder with several asks which, and Escape reopens nothing", async () => {
  const chosen = world({ configs: [DEFAULT, PYTHON], picks: () => 1 });
  await reopenInContainer(chosen.api, chosen.devhub);
  deepStrictEqual(chosen.offered, [["Dev Container", "python"]]);
  deepStrictEqual(chosen.reattached, [{ configPath: PYTHON.path }]);

  const escaped = world({ configs: [DEFAULT, PYTHON], picks: () => undefined });
  await reopenInContainer(escaped.api, escaped.devhub);
  deepStrictEqual(escaped.reattached, []);
});

test("Reopen Folder Locally asks for the Workspace's own machine", async () => {
  const { api, devhub, reattached } = world({ configs: [DEFAULT] });
  await reopenLocally(api, devhub);
  deepStrictEqual(reattached, [{ kind: "host" }]);
});

test("Switch Container offers only the definitions the editor is not in", async () => {
  const { api, devhub, reattached, offered } = world({
    configs: [DEFAULT, PYTHON],
    current: DEFAULT.path,
    picks: () => 0,
  });
  await switchContainer(api, devhub);
  deepStrictEqual(offered, [["python"]]);
  deepStrictEqual(reattached, [{ configPath: PYTHON.path }]);
});

test("DevHub's refusal is said in DevHub's words, and offers the build log", async () => {
  const { api, devhub, said, offeredActions, logs } = world({
    configs: [DEFAULT],
    refuse: "The dev container for /src/api could not be started: no image",
    answers: SHOW_BUILD_LOG,
  });
  await reopenInContainer(api, devhub);
  deepStrictEqual(said, [
    "The dev container for /src/api could not be started: no image",
  ]);
  deepStrictEqual(offeredActions, [[SHOW_BUILD_LOG]]);
  // Followed while DevHub worked, stopped when it answered, and shown whole
  // when the person asked for it from the notice.
  deepStrictEqual(logs, [
    "follow /logs/.devcontainer.log",
    "reattaching",
    "stop /logs/.devcontainer.log",
    "show /logs/.devcontainer.log",
  ]);
});

test("a bring-up that succeeds follows its log and offers nothing", async () => {
  const { api, devhub, said, logs } = world({
    configs: [DEFAULT, PYTHON],
    current: DEFAULT.path,
    picks: () => 0,
  });
  await switchContainer(api, devhub);
  deepStrictEqual(said, []);
  deepStrictEqual(logs, [
    "follow /logs/python.log",
    "reattaching",
    "stop /logs/python.log",
  ]);
});

test("Reopen Folder Locally has no build log to follow", async () => {
  const { api, devhub, logs } = world({ configs: [DEFAULT] });
  await reopenLocally(api, devhub);
  deepStrictEqual(logs, ["reattaching"]);
});

test("Show Build Log shows the log of the container the editor is in", async () => {
  const { api, devhub, logs, offered } = world({
    configs: [DEFAULT, PYTHON],
    current: PYTHON.path,
  });
  await showBuildLog(api, devhub);
  deepStrictEqual(offered, []);
  deepStrictEqual(logs, ["show /logs/python.log"]);
});

test("Show Build Log in a window on its own machine asks which, and says when there is none", async () => {
  const { api, devhub, logs, offered, said } = world({
    configs: [DEFAULT, PYTHON],
    picks: () => 1,
    logExists: false,
  });
  await showBuildLog(api, devhub);
  deepStrictEqual(offered, [["Dev Container", "python"]]);
  deepStrictEqual(logs, ["show /logs/python.log"]);
  strictEqual(said.length, 1);
  strictEqual(said[0]?.includes("no build log"), true);
});

test("the when clauses are told how many definitions there are", async () => {
  const { api, devhub, context } = world({ configs: [DEFAULT, PYTHON] });
  await refreshAvailability(api, devhub);
  strictEqual(context.get(CONFIG_COUNT_KEY), 2);
});

test("a local folder with a definition offers to reopen, and Reopen does", async () => {
  const w = world({ configs: [DEFAULT], offerAnswer: OFFER_REOPEN });
  await offerReopenInContainer(w.api, w.devhub);
  deepStrictEqual(w.infos, [OFFER_MESSAGE]);
  deepStrictEqual(w.reattached, [{ configPath: DEFAULT.path }]);
});

test("Don't Show Again is remembered; closing the notice is not", async () => {
  const never = world({ configs: [DEFAULT], offerAnswer: OFFER_NEVER });
  await offerReopenInContainer(never.api, never.devhub);
  strictEqual(never.flags.get(OFFER_DISMISSED_KEY), true);
  deepStrictEqual(never.reattached, []);

  const closed = world({ configs: [DEFAULT] });
  await offerReopenInContainer(closed.api, closed.devhub);
  strictEqual(closed.flags.get(OFFER_DISMISSED_KEY), undefined);
});

test("no offer in a container, without a definition, once dismissed, or off disk", async () => {
  for (const options of [
    { configs: [DEFAULT], remote: "dev-container" },
    { configs: [] },
    { configs: [DEFAULT], dismissed: true },
    { configs: [DEFAULT], scheme: "vscode-remote" },
  ]) {
    const w = world(options);
    await offerReopenInContainer(w.api, w.devhub);
    deepStrictEqual(w.infos, []);
  }
});
