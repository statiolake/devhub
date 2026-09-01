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
 * - **Extension signature verification.** Upstream requires a Microsoft
 *   signature on every gallery install, but only once `isBuilt` is true — a
 *   source run skips the check entirely
 *   (`extensionManagementService.ts#downloadExtension`). DevHub's packaged app
 *   is a built product, so the check turns itself on there and nowhere else,
 *   and it then fails every install with "Signature verification was not
 *   executed": the verifier is `@vscode/vsce-sign`, which Microsoft ships from
 *   a private feed and which is not in this checkout at all.
 *
 *   Shipping it is not an option, and it would answer the wrong question
 *   anyway. DevHub's gallery is Open VSX, whose extensions carry no Microsoft
 *   signature to verify; a check that can only ever say "unsigned" is not
 *   protection, it is a wall in front of the only gallery DevHub has. Turning
 *   it off says what is true — DevHub does not verify Microsoft signatures —
 *   instead of a packaged build that cannot install anything.
 */
export const WORKBENCH_DEFAULTS: Readonly<Record<string, string | boolean>> = {
	"window.titleBarStyle": "native",
	"window.customTitleBarVisibility": "never",
	"security.workspace.trust.untrustedFiles": "open",
	"extensions.verifySignature": false,
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
