/**
 * Reopen in Container, Reopen Folder Locally and Switch Container.
 *
 * The editor-side half of DevHub's dev containers. A Workspace is its folder,
 * and its terminals and Agents run where that folder is; whether its *editor*
 * is attached to one of the folder's dev containers is a mode of the editor,
 * switched from here, the way VS Code's own Dev Containers extension switches
 * it. Each command asks DevHub over the control socket — DevHub owns the
 * container, the window and the Workspace — and says DevHub's refusal in
 * DevHub's words.
 *
 * Here and not in `devhub-bridge`, because this extension is `ui`-kind: it
 * runs on this Mac in every window, the local ones and the ones attached to a
 * container, which is where the control socket is.
 *
 * The VS Code API arrives as {@link CommandsApi} rather than by importing
 * `vscode`, for the reason `resolveRemote.ts` gives: the decisions — which
 * definitions are offered, which request is sent, what is said — are exactly
 * what the tests are for.
 */

import type {
  BuildLogAnswer,
  DevContainerConfig,
  DevContainerConfigsAnswer,
  ReattachTarget,
  WindowFolder,
} from "./control";

/** The `vscode` surface the commands need, and nothing else. */
export interface CommandsApi {
  /** The window's folder, or nothing for a window with none. */
  windowFolder(): WindowFolder | undefined;
  /** `vscode.env.remoteName`: `dev-container` in an attached window. */
  remoteName(): string | undefined;
  /** A quick pick; resolves to the chosen item, or nothing on Escape. */
  pick<T extends { label: string }>(
    items: readonly T[],
    placeholder: string,
  ): Promise<T | undefined>;
  /** An error notification; resolves to the action chosen, if any. */
  showError(message: string, ...actions: string[]): Promise<string | undefined>;
  /**
   * Follow the build log at `path` into the window's "Dev Containers" output
   * from the next bring-up on, until `stop`. See `buildLog.ts`.
   */
  followBuildLog(path: string): Promise<{ stop(): Promise<void> }>;
  /** Show the whole build log at `path`; false when there is none. */
  showBuildLog(path: string): Promise<boolean>;
  /** Run `work` under a progress notification titled `title`. */
  withProgress<T>(title: string, work: () => Promise<T>): Promise<T>;
  /** An information notification; resolves to the action chosen, if any. */
  showInfo(message: string, ...actions: string[]): Promise<string | undefined>;
  /** A per-folder flag, kept in the window's `workspaceState`. */
  getFlag(key: string): boolean;
  setFlag(key: string, value: boolean): Promise<void>;
  /** `setContext` for the keys the commands' `when` clauses read. */
  setContext(key: string, value: unknown): void;
}

/** Talks to DevHub. See `control.ts`. */
export interface DevHubConnection {
  configs(window: WindowFolder): Promise<DevContainerConfigsAnswer>;
  reattach(
    window: WindowFolder,
    to: ReattachTarget,
  ): Promise<{ ok: boolean; message: string }>;
  buildLog(window: WindowFolder, configPath: string): Promise<BuildLogAnswer>;
}

/** The action a failed bring-up's notice offers. */
export const SHOW_BUILD_LOG = "Show Build Log";

/** The context key the commands' `when` clauses read: how many definitions. */
export const CONFIG_COUNT_KEY = "devhub.devContainerConfigs";

/**
 * Tell the commands' `when` clauses how many definitions this window's
 * Workspace has. Asked once when the extension starts; each command asks
 * again when it runs, so a definition written since is found then.
 */
export async function refreshAvailability(
  api: CommandsApi,
  devhub: DevHubConnection,
): Promise<void> {
  const window = api.windowFolder();
  if (window === undefined) {
    api.setContext(CONFIG_COUNT_KEY, 0);
    return;
  }
  const answer = await devhub.configs(window);
  api.setContext(
    CONFIG_COUNT_KEY,
    answer.ok ? (answer.devContainers?.configs.length ?? 0) : 0,
  );
}

/** The notice's text, as the official Dev Containers extension words it. */
export const OFFER_MESSAGE =
  "Folder contains a Dev Container configuration file. Reopen folder to develop in a container.";
export const OFFER_REOPEN = "Reopen in Container";
export const OFFER_NEVER = "Don't Show Again";
/** The per-folder flag that {@link OFFER_NEVER} sets. */
export const OFFER_DISMISSED_KEY = "devhub.devContainerOffer.dismissed";

/**
 * Offer to reopen a local folder in its dev container, once per window open,
 * the way the official extension does: only in a local window of a folder that
 * has a definition, and until "Don't Show Again" (kept per folder). Closing
 * the notice without choosing only dismisses it for this window.
 */
export async function offerReopenInContainer(
  api: CommandsApi,
  devhub: DevHubConnection,
): Promise<void> {
  const window = api.windowFolder();
  if (window === undefined || window.scheme !== "file") return;
  if (api.remoteName() !== undefined) return;
  if (api.getFlag(OFFER_DISMISSED_KEY)) return;
  const answer = await devhub.configs(window);
  if (!answer.ok || (answer.devContainers?.configs.length ?? 0) === 0) return;
  const chosen = await api.showInfo(OFFER_MESSAGE, OFFER_REOPEN, OFFER_NEVER);
  if (chosen === OFFER_REOPEN) await reopenInContainer(api, devhub);
  else if (chosen === OFFER_NEVER) await api.setFlag(OFFER_DISMISSED_KEY, true);
}

type Choice = {
  label: string;
  description: string;
  config: DevContainerConfig;
};

function choices(configs: readonly DevContainerConfig[]): Choice[] {
  return configs.map((config) => ({
    label: config.label ?? "Dev Container",
    description: config.path,
    config,
  }));
}

/** Ask DevHub for the definitions, or say why it could not answer. */
async function configsOf(
  api: CommandsApi,
  devhub: DevHubConnection,
  window: WindowFolder,
): Promise<{ configs: DevContainerConfig[]; current?: string } | undefined> {
  const answer = await devhub.configs(window);
  if (!answer.ok || answer.devContainers === undefined) {
    void api.showError(answer.message);
    return undefined;
  }
  api.setContext(CONFIG_COUNT_KEY, answer.devContainers.configs.length);
  return answer.devContainers;
}

/** Where DevHub writes the build log of `configPath`'s container. */
async function buildLogOf(
  api: CommandsApi,
  devhub: DevHubConnection,
  window: WindowFolder,
  configPath: string,
): Promise<string | undefined> {
  const answer = await devhub.buildLog(window, configPath);
  if (!answer.ok || answer.buildLog === undefined) {
    void api.showError(answer.message);
    return undefined;
  }
  return answer.buildLog;
}

/**
 * Move the editor. Into a container, the bring-up's build log is followed
 * into the output while DevHub works, and a refusal offers it — the log is
 * where a build that failed says why.
 */
async function reattach(
  api: CommandsApi,
  devhub: DevHubConnection,
  window: WindowFolder,
  to: ReattachTarget,
  title: string,
): Promise<void> {
  const log =
    "configPath" in to
      ? await buildLogOf(api, devhub, window, to.configPath)
      : undefined;
  if ("configPath" in to && log === undefined) return;
  const following =
    log === undefined ? undefined : await api.followBuildLog(log);
  let answer: { ok: boolean; message: string };
  try {
    answer = await api.withProgress(title, () => devhub.reattach(window, to));
  } finally {
    await following?.stop();
  }
  if (answer.ok) return;
  if (log === undefined) {
    void api.showError(answer.message);
    return;
  }
  if (
    (await api.showError(answer.message, SHOW_BUILD_LOG)) === SHOW_BUILD_LOG
  ) {
    await showLogOrSay(api, log);
  }
}

async function showLogOrSay(api: CommandsApi, log: string): Promise<void> {
  if (!(await api.showBuildLog(log))) {
    void api.showError(
      `DevHub has not built or started this dev container yet, so it has no build log (${log}).`,
    );
  }
}

/** Reopen in Container: one definition goes straight in, several are asked. */
export async function reopenInContainer(
  api: CommandsApi,
  devhub: DevHubConnection,
): Promise<void> {
  const window = api.windowFolder();
  if (window === undefined) return;
  const found = await configsOf(api, devhub, window);
  if (found === undefined) return;
  if (found.configs.length === 0) {
    void api.showError("This folder has no dev container definition.");
    return;
  }
  const chosen =
    found.configs.length === 1
      ? found.configs[0]
      : (await api.pick(choices(found.configs), "Which dev container?"))
          ?.config;
  if (chosen === undefined) return;
  await reattach(
    api,
    devhub,
    window,
    { configPath: chosen.path },
    "Starting the dev container…",
  );
}

/** Reopen Folder Locally: the editor back on the Workspace's own machine. */
export async function reopenLocally(
  api: CommandsApi,
  devhub: DevHubConnection,
): Promise<void> {
  const window = api.windowFolder();
  if (window === undefined) return;
  await reattach(
    api,
    devhub,
    window,
    { kind: "host" },
    "Reopening the folder locally…",
  );
}

/** Switch Container: another of the folder's definitions. */
export async function switchContainer(
  api: CommandsApi,
  devhub: DevHubConnection,
): Promise<void> {
  const window = api.windowFolder();
  if (window === undefined) return;
  const found = await configsOf(api, devhub, window);
  if (found === undefined) return;
  const others = found.configs.filter(
    (config) => config.path !== found.current,
  );
  if (others.length === 0) {
    void api.showError("This folder has no other dev container definition.");
    return;
  }
  const chosen = (
    await api.pick(choices(others), "Switch to which dev container?")
  )?.config;
  if (chosen === undefined) return;
  await reattach(
    api,
    devhub,
    window,
    { configPath: chosen.path },
    "Switching dev container…",
  );
}

/**
 * Show Build Log: the log of the container the editor is in, or, in a window
 * whose editor is on its own machine, of the definition chosen — the one
 * there is, or the one asked for.
 */
export async function showBuildLog(
  api: CommandsApi,
  devhub: DevHubConnection,
): Promise<void> {
  const window = api.windowFolder();
  if (window === undefined) return;
  const found = await configsOf(api, devhub, window);
  if (found === undefined) return;
  if (found.configs.length === 0) {
    void api.showError("This folder has no dev container definition.");
    return;
  }
  const chosen =
    found.current ??
    (found.configs.length === 1
      ? found.configs[0]?.path
      : (await api.pick(choices(found.configs), "Whose build log?"))?.config
          .path);
  if (chosen === undefined) return;
  const log = await buildLogOf(api, devhub, window, chosen);
  if (log === undefined) return;
  await showLogOrSay(api, log);
}
