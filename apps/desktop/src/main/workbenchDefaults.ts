/**
 * The workbench settings DevHub cannot contribute as defaults.
 *
 * Everything that takes goes through the bridge extension's
 * `contributes.configurationDefaults`, which is the supported way for a product
 * to move a default — but VS Code accepts extension-contributed defaults only
 * for machine-overridable, window, resource and language-overridable scoped
 * settings (see the `configurationDefaults` extension point in
 * `vscode/src/vs/workbench/api/common/configurationExtensionPoint.ts`). The
 * three below are `ConfigurationScope.APPLICATION`, so contributing them is
 * refused with a warning and they are written into the user's settings file
 * instead — once, and only where the person has not already said otherwise, so
 * a user override still wins.
 *
 * This module is deliberately free of Electron and of the filesystem: the merge
 * rule is the part worth testing, and the write around it is four lines.
 */

/**
 * The defaults, and why each one is not the workbench's own answer.
 *
 * - **The title bar.** A workbench view is chrome inside DevHub's own window,
 *   so it must not draw a title bar of its own.
 * - **Workspace trust.** Upstream's Workspace Trust exists because a window can
 *   be opened by something other than the person at the keyboard — a link, a
 *   recently-opened list, a folder handed to `code` by another program — so the
 *   code in it has to be treated as unknown until somebody says otherwise.
 *   Nothing reaches DevHub that way. A DevHub Workspace is a folder the person
 *   added in DevHub's own picker or named on DevHub's own command line, and the
 *   next thing they do in it is start an Agent, which runs a program of their
 *   choosing against those same files. Restricted Mode in the workbench does
 *   not make that safer; it makes the *terminal* — the one that is now the
 *   workbench's own, on DevHub's tmux session — refuse to open until the folder
 *   is trusted a second time, for a question DevHub already asked by being the
 *   thing that opened it. A person who wants the prompt back sets this to
 *   `true` and gets upstream's behaviour unchanged.
 * - **Untrusted files.** DevHub sends a file no open Workspace contains to the
 *   Scratch workbench, and an empty window is a *trusted* workspace, so
 *   upstream's `requestOpenFilesTrust` asks — every time, about every loose
 *   file, in a modal inside the workbench view — before it will open one
 *   (`editorService.openEditors(..., { validateTrust: true })`). Upstream is
 *   right to ask when the target window was chosen for you by "whichever
 *   window you last looked at". DevHub chose it from the path you typed, on
 *   DevHub's own command line, so the question has one answer and asking it is
 *   the whole of why `devhub <file>` appeared to do nothing.
 */
export const WORKBENCH_DEFAULTS: Readonly<Record<string, string | boolean>> = {
	"window.titleBarStyle": "native",
	"window.customTitleBarVisibility": "never",
	"security.workspace.trust.enabled": false,
	"security.workspace.trust.untrustedFiles": "open",
};

/**
 * The keys of `settings` that DevHub still owes an answer for, and what it is.
 *
 * A key the person has written — to any value, including the one DevHub would
 * have chosen — is theirs, so it is not in the result and nothing rewrites it.
 */
export function missingWorkbenchDefaults(
	settings: Readonly<Record<string, unknown>>,
): readonly (readonly [string, string | boolean])[] {
	return Object.entries(WORKBENCH_DEFAULTS).filter(
		([key]) => !(key in settings),
	);
}
