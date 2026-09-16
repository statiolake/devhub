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

export function activate(context: vscode.ExtensionContext): void {
  const socketPath = controlSocketFromGlobalStorage(
    context.globalStorageUri.fsPath,
  );
  context.subscriptions.push(
    vscode.workspace.registerRemoteAuthorityResolver("ssh-remote", {
      resolve: (authority, resolveContext) =>
        resolveRemote(
          api,
          requestResolveRemote,
          socketPath,
          authority,
          resolveContext.resolveAttempt,
        ) as Promise<vscode.ResolverResult>,
    }),
  );
}

export function deactivate(): void {
  // Nothing is owned across deactivation: the registration is on the extension
  // context, and no socket is held open between resolves.
}
