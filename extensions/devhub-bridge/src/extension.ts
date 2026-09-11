/**
 * DevHub's own built-in VS Code extension.
 *
 * Two jobs, and they are the two things a *product* cannot say to VS Code any
 * other way:
 *
 * - `contributes.configurationDefaults` in the manifest, which is the only
 *   supported way to move a workbench default on the desktop (see
 *   `scripts/stage-builtin-extensions.sh` for why that forces this extension
 *   to be built in rather than installed).
 * - `devhub.installCli`, the palette command that puts `devhub` on the PATH,
 *   mirroring VS Code's own "Shell Command: Install 'code' command in PATH".
 *
 * What used to be here as well was a websocket transport to a DevHub-hosted
 * Bridge endpoint: a frame codec, a session ledger, a reconnecting controller,
 * a surface registry, a URI-handler navigation grammar, and a fault union to
 * report all of it. That belonged to the web era, when DevHub served a Web
 * Workbench and injected `DEVHUB_BRIDGE_*` into it. The desktop app injects
 * nothing, so none of it ever ran; it has been deleted rather than left as a
 * branch that is always taken one way.
 */

import * as vscode from "vscode";
import { controlSocketFromGlobalStorage, requestInstall } from "./installCli";

/**
 * The palette command that puts `devhub` on the PATH.
 *
 * Nothing is caught: a failure to reach DevHub or to write the launcher is the
 * answer to the command and is shown as an error, not logged and shrugged off.
 * A rejection from `requestInstall` leaves the command handler, which is where
 * VS Code turns it into the error a person sees.
 */
function installCliCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand("devhub.installCli", async () => {
    const socketPath = controlSocketFromGlobalStorage(
      context.globalStorageUri.fsPath,
    );
    if (!socketPath) {
      await vscode.window.showErrorMessage(
        "This workbench is not running inside DevHub, so there is no DevHub to install a command for.",
      );
      return;
    }
    const answer = await requestInstall(socketPath);
    if (answer.ok) {
      await vscode.window.showInformationMessage(answer.message);
    } else {
      await vscode.window.showErrorMessage(answer.message);
    }
  });
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(installCliCommand(context));
}

export function deactivate(): void {
  // Nothing is owned across deactivation: the command disposable is on the
  // extension context, and no socket is held open between invocations.
}
