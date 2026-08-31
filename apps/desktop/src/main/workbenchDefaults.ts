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
 * - **Untrusted files, and only untrusted files.** This is the single
 *   trust-related default DevHub sets, and it is deliberately the narrow one.
 *   Workspace Trust itself stays **on**: opening a folder asks "do you trust
 *   the authors of the files in this folder?" exactly as stock VS Code does,
 *   once per folder, and until somebody answers, the workspace is in Restricted
 *   Mode and its terminal will not start. That wall is correct — a person
 *   clicks "Yes, I trust the authors" once and it is gone for good — and DevHub
 *   is not the right place to decide otherwise on their behalf.
 *
 *   What this key covers is a different question with no such answer. DevHub
 *   sends a file no open Workspace contains to the Scratch workbench, and an
 *   empty window is a *trusted* workspace, so upstream's `requestOpenFilesTrust`
 *   asks — every time, about every loose file, in a modal inside the workbench
 *   view — before it will open one (`editorService.openEditors(..., {
 *   validateTrust: true })`). Upstream is right to ask when the target window
 *   was chosen for you by "whichever window you last looked at". DevHub chose
 *   it from the path you typed, on DevHub's own command line, so the question
 *   has one answer and asking it is the whole of why `devhub <file>` appeared
 *   to do nothing. A person who wants the prompt back sets this to `prompt` and
 *   gets upstream's behaviour unchanged.
 */
export const WORKBENCH_DEFAULTS: Readonly<Record<string, string | boolean>> = {
	"window.titleBarStyle": "native",
	"window.customTitleBarVisibility": "never",
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
