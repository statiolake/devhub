import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
  CONFIG_COUNT_KEY,
  refreshAvailability,
  reopenInContainer,
  reopenLocally,
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
}) {
  const said: string[] = [];
  const context = new Map<string, unknown>();
  const reattached: ReattachTarget[] = [];
  const offered: string[][] = [];
  const api: CommandsApi = {
    windowFolder: () => WINDOW,
    remoteName: () => undefined,
    pick: (items) => {
      const labels = items.map((item) => item.label);
      offered.push(labels);
      const index = options.picks?.(labels);
      return Promise.resolve(index === undefined ? undefined : items[index]);
    },
    showError: (message) => {
      said.push(message);
    },
    withProgress: (_title, work) => work(),
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
    reattach: (_window, to) => {
      reattached.push(to);
      return Promise.resolve(
        options.refuse === undefined
          ? { ok: true, message: "reattached" }
          : { ok: false, message: options.refuse },
      );
    },
  };
  return { api, devhub, said, context, reattached, offered };
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

test("DevHub's refusal is said in DevHub's words", async () => {
  const { api, devhub, said } = world({
    configs: [DEFAULT],
    refuse: "The dev container for /src/api could not be started: no image",
  });
  await reopenInContainer(api, devhub);
  deepStrictEqual(said, [
    "The dev container for /src/api could not be started: no image",
  ]);
});

test("the when clauses are told how many definitions there are", async () => {
  const { api, devhub, context } = world({ configs: [DEFAULT, PYTHON] });
  await refreshAvailability(api, devhub);
  strictEqual(context.get(CONFIG_COUNT_KEY), 2);
});
