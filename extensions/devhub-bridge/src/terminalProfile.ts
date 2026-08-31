/**
 * The workbench's integrated terminal, attached to DevHub's tmux session.
 *
 * DevHub's terminals live in a tmux server on a socket DevHub owns, under
 * markers DevHub sets, so that closing a window, switching workspace or
 * quitting the app never ends a shell. That has not changed. What changed is
 * which terminal you see them in: it is the workbench's own integrated
 * terminal now, rather than a second emulator beside the workbench.
 *
 * So this contributes one profile, and the profile does one thing — attach.
 * The session name, the socket and the marker protocol are not spelled here and
 * must not be: they belong to DevHub's terminal runtime, and a copy of the
 * naming rule in an extension is a second answer that will one day disagree
 * with the first. The profile is asked for, per window, over DevHub's control
 * socket, which is the same front door the "Install 'devhub' command" palette
 * entry already knocks on.
 *
 * A window with no DevHub behind it — this extension is built in, so that is
 * possible — contributes nothing and leaves the person with VS Code's own
 * profiles, which is the honest answer rather than a profile that fails to run.
 */

import { connect } from "node:net";
import * as vscode from "vscode";
import { controlSocketFromGlobalStorage } from "./installCli";

/** The id in `contributes.terminal.profiles`, and the title the default names. */
export const TERMINAL_PROFILE_ID = "devhub.tmux";
export const TERMINAL_PROFILE_TITLE = "DevHub";

interface ProfileAnswer {
	ok: boolean;
	message: string;
	profile?: { file: string; args: string[] };
}

/**
 * Ask DevHub for the command line, over the control socket.
 *
 * Nothing is caught here beyond the socket's own transport: a DevHub that
 * refuses is a terminal that cannot be opened, and saying so is the answer.
 */
export function requestTerminalProfile(
	socketPath: string,
	root: string | null,
): Promise<ProfileAnswer> {
	return new Promise<ProfileAnswer>((resolve, reject) => {
		const socket = connect(socketPath);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ kind: "terminal-profile", root })}\n`);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
		});
		socket.on("error", reject);
		socket.on("close", () => {
			const line = buffer.split("\n")[0] ?? "";
			if (line.length === 0) {
				reject(new Error("DevHub closed the connection without answering."));
				return;
			}
			resolve(JSON.parse(line) as ProfileAnswer);
		});
	});
}

/**
 * This window's workspace folder as DevHub names it, or `null` for the
 * folderless window — which is DevHub's Scratch context.
 *
 * More than one folder is not a window DevHub makes, and guessing which of
 * them the terminal belongs to would be inventing an answer.
 */
export function workbenchRoot(
	folders: readonly { readonly uri: vscode.Uri }[] | undefined,
): string | null | undefined {
	if (!folders || folders.length === 0) return null;
	if (folders.length > 1) return undefined;
	const uri = folders[0].uri;
	return uri.scheme === "file" ? uri.fsPath : undefined;
}

export function registerTerminalProfile(
	context: vscode.ExtensionContext,
): vscode.Disposable {
	return vscode.window.registerTerminalProfileProvider(TERMINAL_PROFILE_ID, {
		async provideTerminalProfile() {
			const socketPath = controlSocketFromGlobalStorage(
				context.globalStorageUri.fsPath,
			);
			const root = workbenchRoot(vscode.workspace.workspaceFolders);
			if (!socketPath || root === undefined) {
				throw new Error(
					"This workbench is not running inside DevHub, so it has no DevHub terminal session to attach to.",
				);
			}
			const answer = await requestTerminalProfile(socketPath, root);
			if (!answer.ok || !answer.profile) {
				throw new Error(answer.message);
			}
			return new vscode.TerminalProfile({
				name: TERMINAL_PROFILE_TITLE,
				shellPath: answer.profile.file,
				shellArgs: answer.profile.args,
				// tmux is the shell here, and it is the session's shell that runs a
				// login profile — a login flag on the client would run one twice.
				isTransient: false,
			});
		},
	});
}
