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
  showError(message: string): void;
  /** Run `work` under a progress notification titled `title`. */
  withProgress<T>(title: string, work: () => Promise<T>): Promise<T>;
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
}

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
    api.showError(answer.message);
    return undefined;
  }
  api.setContext(CONFIG_COUNT_KEY, answer.devContainers.configs.length);
  return answer.devContainers;
}

async function reattach(
  api: CommandsApi,
  devhub: DevHubConnection,
  window: WindowFolder,
  to: ReattachTarget,
  title: string,
): Promise<void> {
  const answer = await api.withProgress(title, () =>
    devhub.reattach(window, to),
  );
  if (!answer.ok) api.showError(answer.message);
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
    api.showError("This folder has no dev container definition.");
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
    api.showError("This folder has no other dev container definition.");
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
