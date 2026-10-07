/**
 * DevHub's `ssh-remote` and `dev-container` authority resolvers.
 *
 * VS Code opens a `vscode-remote://ssh-remote+<host>/...` window by asking
 * whichever extension registered that authority where the remote extension
 * host is. This extension is that registration and nothing else: it asks the
 * running DevHub over its control socket and hands the answer back.
 *
 * It replaces a vendored third-party SSH resolver, which brought its own SSH
 * client, its own ssh configuration reader, its own server-publishing logic and
 * its own settings. DevHub already owns all of that — one connection model, one
 * place a host is spelled — so the extension keeps none of it.
 *
 * `extensionKind` is `ui`: the resolver has to run on the machine DevHub is
 * running on, because that is where the control socket is. (devhub-bridge is
 * the opposite, `workspace`, because its job is inside the window's workbench.)
 */

import { open, stat } from "node:fs/promises";
import * as vscode from "vscode";
import {
  LogFollower,
  showLog,
  type LogFiles,
  type LogOutput,
} from "./buildLog";
import {
  offerReopenInContainer,
  refreshAvailability,
  rebuildContainer,
  rebuildContainerNoCache,
  reopenInContainer,
  reopenLocally,
  showBuildLog,
  switchContainer,
  type CommandsApi,
  type DevHubConnection,
} from "./commands";
import {
  controlSocketFromGlobalStorage,
  requestDevContainerBuildLog,
  requestDevContainerConfigs,
  requestReattachEditor,
  requestDevContainerPorts,
  requestResolveRemote,
} from "./control";
import {
  attributesFor,
  autoForwardAction,
  labelFor,
  makeTunnelFactory,
  requestForwardPort,
  requiresLocalPort,
  type PortsConfiguration,
} from "./ports";
import {
  CONTAINER_PREFIX,
  containerFromPayload,
  machineFromAuthority,
  resolveRemote,
  type ResolverApi,
} from "./resolveRemote";

const api: ResolverApi = {
  resolved: (host, port, connectionToken) =>
    new vscode.ResolvedAuthority(host, port, connectionToken),
  notAvailable: (message) =>
    vscode.RemoteAuthorityResolverError.NotAvailable(message),
  temporarilyNotAvailable: (message) =>
    vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(message),
};

/**
 * Say which host this window is on, not merely that it is on one.
 *
 * `LabelService.getHostLabel` returns the matching formatter's
 * `workspaceSuffix`, and two things read it: the remote indicator in the status
 * bar and the window title. The manifest's formatter matches `ssh-remote+*` and
 * can therefore only say "SSH" — so without this, every remote window of every
 * host reads the same, and a person with two of them open has nothing on screen
 * that tells them apart. DevHub's whole model says otherwise: two hosts' `/src/api`
 * are two Workspaces, and only the host tells them apart.
 *
 * So the authority that was actually resolved gets a formatter of its own.
 * `findFormatting` prefers an exact authority over the wildcard, so this wins
 * for this window and changes nothing for any other.
 *
 * Once per authority, not once per resolve: `resolve()` runs again on every
 * reconnect, and a registration per reconnect is a registration that
 * accumulates for as long as the window is open.
 */
function nameTheHost(
  context: vscode.ExtensionContext,
  named: Set<string>,
  authority: string,
): void {
  if (named.has(authority)) return;
  named.add(authority);
  context.subscriptions.push(
    vscode.workspace.registerResourceLabelFormatter({
      scheme: "vscode-remote",
      authority,
      formatting: {
        label: "${path}",
        separator: "/",
        tildify: true,
        workspaceSuffix: workspaceSuffixFor(authority),
      },
    }),
  );
}

/**
 * What the status bar and the window title say this window is on.
 *
 * A host is named by its alias, which is what the person typed and what tells
 * two of them apart. A dev container is named by its folder, for the same
 * reason and by the same rule — and by its definition too when the folder has
 * several (`.devcontainer/<name>/devcontainer.json`), because then the folder
 * alone does not say which container this is. The container id would be
 * neither — it is a hash that changes on every rebuild.
 */
function workspaceSuffixFor(authority: string): string {
  if (authority.startsWith(CONTAINER_PREFIX)) {
    const container = containerFromPayload(
      authority.slice(CONTAINER_PREFIX.length),
    );
    if (container !== null) {
      const folder = container.hostPath;
      const name = folder.slice(folder.lastIndexOf("/") + 1) || folder;
      const named = /\/\.devcontainer\/([^/]+)\/devcontainer\.json$/u.exec(
        container.configPath,
      );
      const where =
        container.sshHost === undefined ? "" : ` on ${container.sshHost}`;
      return `Dev Container: ${name}${named === null ? "" : ` (${named[1]})`}${where}`;
    }
  }
  return `SSH: ${authority.slice(authority.indexOf("+") + 1)}`;
}

/** The build log's file, read with Node: this extension runs on this Mac. */
const logFiles: LogFiles = {
  stat: async (path) => {
    try {
      const found = await stat(path);
      return { ino: found.ino, size: found.size };
    } catch (failure) {
      // No file is an answer: nothing has been written there yet.
      if ((failure as NodeJS.ErrnoException).code === "ENOENT")
        return undefined;
      throw failure;
    }
  },
  read: async (path, from, to) => {
    const file = await open(path, "r");
    try {
      const bytes = new Uint8Array(to - from);
      const { bytesRead } = await file.read(bytes, 0, bytes.byteLength, from);
      return bytes.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  },
};

/** How often a followed build log is looked at. */
const FOLLOW_EVERY_MS = 250;

/** The commands' view of the window, through the real `vscode`. */
function commandsApiFor(
  context: vscode.ExtensionContext,
  report: (failure: unknown) => void,
): CommandsApi {
  // One "Dev Containers" output per window, made the first time a log is
  // shown in it.
  let channel: vscode.OutputChannel | undefined;
  const output = (): LogOutput => {
    if (channel === undefined) {
      channel = vscode.window.createOutputChannel("Dev Containers");
      context.subscriptions.push(channel);
    }
    return channel;
  };
  return {
    windowFolder: () => {
      const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
      return uri === undefined
        ? undefined
        : {
            scheme: uri.scheme,
            authority: uri.authority,
            path: uri.path,
            fsPath: uri.fsPath,
          };
    },
    remoteName: () => vscode.env.remoteName,
    pick: async (items, placeholder) =>
      vscode.window.showQuickPick([...items], { placeHolder: placeholder }),
    showError: (message, ...actions) =>
      Promise.resolve(vscode.window.showErrorMessage(message, ...actions)),
    showInfo: (message, ...actions) =>
      Promise.resolve(
        vscode.window.showInformationMessage(message, ...actions),
      ),
    getFlag: (key) => context.workspaceState.get<boolean>(key) === true,
    setFlag: (key, value) =>
      Promise.resolve(context.workspaceState.update(key, value)),
    followBuildLog: async (path) => {
      const follower = await LogFollower.start(path, output(), logFiles);
      const timer = setInterval(() => {
        follower.poll().catch(report);
      }, FOLLOW_EVERY_MS);
      return {
        stop: async () => {
          clearInterval(timer);
          // What was written between the last look and the end.
          await follower.poll();
        },
      };
    },
    showBuildLog: (path) => showLog(path, output(), logFiles),
    withProgress: (title, work) =>
      Promise.resolve(
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title },
          work,
        ),
      ),
    setContext: (key, value) => {
      void vscode.commands.executeCommand("setContext", key, value);
    },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const socketPath = controlSocketFromGlobalStorage(
    context.globalStorageUri.fsPath,
  );
  // Reopen in Container, Reopen Folder Locally, Switch Container: see
  // `commands.ts`. Registered in every window, the local ones included, which
  // is why this extension also starts on `onStartupFinished`.
  if (socketPath !== null) {
    const devhub: DevHubConnection = {
      configs: (window) => requestDevContainerConfigs(socketPath, window),
      reattach: (window, to, rebuild) =>
        requestReattachEditor(socketPath, window, to, rebuild),
      buildLog: (window, configPath) =>
        requestDevContainerBuildLog(socketPath, window, configPath),
    };
    // The one place a command's failure is said: every command's rejection
    // comes here.
    const report = (failure: unknown): void => {
      void vscode.window.showErrorMessage(
        failure instanceof Error ? failure.message : String(failure),
      );
    };
    const commandsApi = commandsApiFor(context, report);
    for (const [id, run] of [
      ["devhub.reopenInContainer", reopenInContainer],
      ["devhub.reopenLocally", reopenLocally],
      ["devhub.switchContainer", switchContainer],
      ["devhub.showBuildLog", showBuildLog],
      ["devhub.rebuildContainer", rebuildContainer],
      ["devhub.rebuildContainerNoCache", rebuildContainerNoCache],
    ] as const) {
      context.subscriptions.push(
        vscode.commands.registerCommand(id, () =>
          run(commandsApi, devhub).catch(report),
        ),
      );
    }
    void refreshAvailability(commandsApi, devhub).catch(report);
    // The reopen notice is offered once per window; until a definition
    // exists it is not shown, so a later one (a checkout) offers it then.
    let offered = false;
    const offer = async (): Promise<void> => {
      if (offered) return;
      offered = await offerReopenInContainer(commandsApi, devhub);
    };
    void offer().catch(report);
    // A checkout can add or remove `.devcontainer`: keep the context key and
    // the offer in step with the files.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rescan = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        refreshAvailability(commandsApi, devhub).then(offer).catch(report);
      }, 300);
    };
    for (const glob of ["**/.devcontainer/**", "**/.devcontainer.json"]) {
      const watcher = vscode.workspace.createFileSystemWatcher(glob);
      watcher.onDidCreate(rescan);
      watcher.onDidChange(rescan);
      watcher.onDidDelete(rescan);
      context.subscriptions.push(watcher);
    }
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }
  const named = new Set<string>();
  // One resolver, registered for each authority DevHub owns. The same function
  // answers both: which machine an authority names is `machineFromAuthority`'s
  // decision and the only one, and everything after it — asking DevHub, turning
  // its sentence into the error VS Code understands, returning a port — is
  // identical whether the bytes reach that machine over ssh or over a docker
  // exec. A second registration here, rather than a second extension, is what
  // keeps it that way.
  // The container this window resolved to, for the tunnel factory: VS Code
  // hands the factory a port and nothing about which remote it is on.
  const ports: WindowPorts = { machine: undefined, config: undefined };
  for (const scheme of ["ssh-remote", "dev-container"]) {
    const resolver: vscode.RemoteAuthorityResolver = {
      resolve: async (authority, resolveContext) => {
        const resolved = (await resolveRemote(
          api,
          requestResolveRemote,
          socketPath,
          authority,
          resolveContext.resolveAttempt,
        )) as vscode.ResolverResult;
        if (scheme === "dev-container") {
          ports.machine = machineFromAuthority(authority) ?? undefined;
        }
        // After the resolve, so that a machine that never came up does not
        // leave a label claiming a window is editing on it.
        nameTheHost(context, named, authority);
        return resolved;
      },
    };
    // Port forwarding: see `ports.ts`. Having a `tunnelFactory` is what turns
    // on the Ports view and automatic forwarding for the window at all.
    if (scheme === "dev-container" && socketPath !== null) {
      resolver.tunnelFactory = tunnelFactoryFor(socketPath, ports);
      resolver.tunnelFeatures = {
        elevation: false,
        public: false,
        privacyOptions: [],
      };
    }
    context.subscriptions.push(
      vscode.workspace.registerRemoteAuthorityResolver(scheme, resolver),
    );
  }
  if (socketPath !== null && vscode.env.remoteName === "dev-container") {
    void openDefinitionPorts(context, socketPath, ports).catch(
      (failure: unknown) => {
        console.warn(
          `[devhub-remote] the definition's ports could not be forwarded: ${
            failure instanceof Error ? failure.message : String(failure)
          }`,
        );
      },
    );
  }
}

/** The window's container, and what its definition says about ports. */
interface WindowPorts {
  machine: string | undefined;
  config: PortsConfiguration | undefined;
}

function tunnelFactoryFor(
  socketPath: string,
  ports: WindowPorts,
): NonNullable<vscode.RemoteAuthorityResolver["tunnelFactory"]> {
  const factory = makeTunnelFactory(
    {
      emitter: () => {
        const emitter = new vscode.EventEmitter<void>();
        return {
          event: emitter.event,
          fire: () => emitter.fire(),
          dispose: () => emitter.dispose(),
        };
      },
    },
    (host, port, localPort, requireLocalPort) => {
      const machine = ports.machine ?? machineOfThisWindow();
      if (machine === undefined) {
        return Promise.reject(
          new Error("This window is not attached to a dev container."),
        );
      }
      return requestForwardPort(
        socketPath,
        machine,
        host,
        port,
        localPort,
        requireLocalPort,
      );
    },
    (port) => requiresLocalPort(ports.config, port),
  );
  return (options) => factory(options) as Thenable<vscode.Tunnel>;
}

function machineOfThisWindow(): string | undefined {
  const authority = vscode.env.remoteAuthority;
  return authority === undefined
    ? undefined
    : (machineFromAuthority(authority) ?? undefined);
}

/**
 * The definition's `forwardPorts` and `appPort`, forwarded as the window
 * opens, and its `portsAttributes`' `onAutoForward` applied to the ports VS
 * Code finds by itself.
 */
async function openDefinitionPorts(
  context: vscode.ExtensionContext,
  socketPath: string,
  ports: WindowPorts,
): Promise<void> {
  const machine = ports.machine ?? machineOfThisWindow();
  if (machine === undefined) return;
  const answer = await requestDevContainerPorts(socketPath, machine);
  if (!answer.ok || answer.ports === undefined) return;
  const config = answer.ports;
  ports.config = config;
  context.subscriptions.push(
    vscode.workspace.registerPortAttributesProvider(
      { portRange: [1, 65536] },
      {
        providePortAttributes: ({ port, commandLine }) => {
          const action = autoForwardAction(
            attributesFor(config, port, commandLine),
          );
          return action === undefined
            ? undefined
            : new vscode.PortAttributes(action as vscode.PortAutoForwardAction);
        },
      },
    ),
  );
  for (const { host, port } of config.forwardPorts) {
    const label = labelFor(config, port);
    try {
      const tunnel = await vscode.workspace.openTunnel({
        remoteAddress: { host, port },
        localAddressPort: port,
        ...(label === undefined ? {} : { label }),
      });
      context.subscriptions.push({ dispose: () => void tunnel.dispose() });
    } catch (failure) {
      console.warn(
        `[devhub-remote] forwardPorts ${host}:${String(port)}: ${
          failure instanceof Error ? failure.message : String(failure)
        }`,
      );
    }
  }
}

export function deactivate(): void {
  // Nothing is owned across deactivation: the registration is on the extension
  // context, and no socket is held open between resolves.
}
