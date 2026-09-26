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

import * as vscode from "vscode";
import {
  controlSocketFromGlobalStorage,
  requestResolveRemote,
} from "./control";
import {
  CONTAINER_PREFIX,
  containerFromPayload,
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

export function activate(context: vscode.ExtensionContext): void {
  const socketPath = controlSocketFromGlobalStorage(
    context.globalStorageUri.fsPath,
  );
  const named = new Set<string>();
  // One resolver, registered for each authority DevHub owns. The same function
  // answers both: which machine an authority names is `machineFromAuthority`'s
  // decision and the only one, and everything after it — asking DevHub, turning
  // its sentence into the error VS Code understands, returning a port — is
  // identical whether the bytes reach that machine over ssh or over a docker
  // exec. A second registration here, rather than a second extension, is what
  // keeps it that way.
  for (const scheme of ["ssh-remote", "dev-container"]) {
    context.subscriptions.push(
      vscode.workspace.registerRemoteAuthorityResolver(scheme, {
        resolve: async (authority, resolveContext) => {
          const resolved = (await resolveRemote(
            api,
            requestResolveRemote,
            socketPath,
            authority,
            resolveContext.resolveAttempt,
          )) as vscode.ResolverResult;
          // After the resolve, so that a machine that never came up does not
          // leave a label claiming a window is editing on it.
          nameTheHost(context, named, authority);
          return resolved;
        },
      }),
    );
  }
}

export function deactivate(): void {
  // Nothing is owned across deactivation: the registration is on the extension
  // context, and no socket is held open between resolves.
}
