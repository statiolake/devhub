/**
 * DevHub's `ssh-remote` authority resolver.
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
import { resolveRemote, type ResolverApi } from "./resolveRemote";

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
  const host = authority.slice(authority.indexOf("+") + 1);
  context.subscriptions.push(
    vscode.workspace.registerResourceLabelFormatter({
      scheme: "vscode-remote",
      authority,
      formatting: {
        label: "${path}",
        separator: "/",
        tildify: true,
        workspaceSuffix: `SSH: ${host}`,
      },
    }),
  );
}

export function activate(context: vscode.ExtensionContext): void {
  const socketPath = controlSocketFromGlobalStorage(
    context.globalStorageUri.fsPath,
  );
  const named = new Set<string>();
  context.subscriptions.push(
    vscode.workspace.registerRemoteAuthorityResolver("ssh-remote", {
      resolve: async (authority, resolveContext) => {
        const resolved = (await resolveRemote(
          api,
          requestResolveRemote,
          socketPath,
          authority,
          resolveContext.resolveAttempt,
        )) as vscode.ResolverResult;
        // After the resolve, so that a host that never came up does not leave a
        // label claiming a window is editing on it.
        nameTheHost(context, named, authority);
        return resolved;
      },
    }),
  );
}

export function deactivate(): void {
  // Nothing is owned across deactivation: the registration is on the extension
  // context, and no socket is held open between resolves.
}
