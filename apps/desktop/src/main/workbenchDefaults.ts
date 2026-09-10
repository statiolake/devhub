/**
 * The workbench settings DevHub cannot contribute as defaults.
 *
 * Everything that takes goes through the bridge extension's
 * `contributes.configurationDefaults`, which is the supported way for a product
 * to move a default — but VS Code accepts extension-contributed defaults only
 * for machine-overridable, window, resource and language-overridable scoped
 * settings (see the `configurationDefaults` extension point in
 * `vscode/src/vs/workbench/api/common/configurationExtensionPoint.ts`). Some of
 * those below are `ConfigurationScope.APPLICATION`, so contributing them is
 * refused with a warning; the rest are here because a contributed default
 * arrives too late to be believed. Either way they are written into the user's
 * settings file — once, and only where the person has not already said
 * otherwise, so a user override still wins.
 *
 * That last clause is the whole reason the terminal is *not* here any more. A
 * key in this file is a suggestion: the person's settings file is theirs, their
 * dotfiles tool rewrites it wholesale, and when it did, the DevHub profile went
 * with it and the next reload produced a plain zsh. DevHub's terminal is not a
 * suggestion, so it is not a setting — it is told to VS Code in code, by
 * `patches/vscode/0003-devhub-terminal-is-the-terminal.patch`, which reads no
 * terminal setting at all.
 *
 * This module is deliberately free of Electron and of the filesystem: what the
 * file should say next is the part worth testing, and the write around it is
 * three lines.
 */

import {
	parse,
	type ParseError,
} from "code-oss-dev/out/vs/base/common/json.js";
import {
	applyEdits,
	setProperty,
} from "code-oss-dev/out/vs/base/common/jsonEdit.js";

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
export function workbenchDefaults(): Readonly<Record<string, unknown>> {
	return {
		"window.titleBarStyle": "native",
		"window.customTitleBarVisibility": "never",
		"security.workspace.trust.untrustedFiles": "open",
		"extensions.verifySignature": false,
	};
}

/**
 * The keys of `settings` that DevHub still owes an answer for, and what it is.
 *
 * A key the person has written — to any value, including the one DevHub would
 * have chosen — is theirs, so it is not in the result and nothing rewrites it.
 */
export function missingWorkbenchDefaults(
	settings: Readonly<Record<string, unknown>>,
): readonly (readonly [string, unknown])[] {
	return Object.entries(workbenchDefaults()).filter(
		([key]) => !(key in settings),
	);
}

/** Where a settings file stopped making sense, in the numbers an editor shows. */
export interface SettingsProblem {
	/** 1-based, as every editor counts. */
	readonly line: number;
	/** 1-based. */
	readonly column: number;
}

/**
 * What should happen to `User/settings.json`, given what is in it.
 *
 * `unreadable` is the whole reason this is a decision rather than a write.
 * The file is the person's — their dotfiles tool rewrites it, they edit it by
 * hand, and it is JSON**C**: VS Code reads it with comments and trailing
 * commas in it and so does this. But a file that is genuinely broken (a
 * truncated object, a missing brace) has no object to merge into, and the two
 * things DevHub must not do about that are the two that are easy to do by
 * accident — overwrite it with a fresh one, which throws away everything the
 * person wrote, or refuse to start, which is what a `JSON.parse` at startup
 * did. Neither is DevHub's to choose. The workbench reads the same file with
 * the same parser and will say the same thing about it, so DevHub starts, says
 * which line, and says what the person has lost until it is fixed.
 */
export type WorkbenchSettingsPlan =
	| { readonly kind: "unreadable"; readonly problem: SettingsProblem }
	/** Every default is already answered; nothing is written. */
	| { readonly kind: "answered" }
	| {
			readonly kind: "write";
			readonly text: string;
			readonly keys: readonly string[];
	  };

/**
 * How the file is written: tabs, and the newline this project writes.
 *
 * It only decides the *added* lines. Everything already in the file keeps the
 * shape it had, comments included, because the defaults go in as edits to the
 * text rather than as a re-serialised object.
 */
const FORMATTING = { insertSpaces: false, tabSize: 4, eol: "\n" };

/**
 * What `User/settings.json` should say next.
 *
 * `undefined` is a file that is not there; empty is a file that is there and
 * says nothing. Both are answered the same way, with a document DevHub writes
 * from scratch — there is nothing in either to preserve.
 */
export function workbenchSettingsPlan(
	existing: string | undefined,
): WorkbenchSettingsPlan {
	const text = existing ?? "";
	const settings = readSettings(text);
	if (settings === undefined) {
		return { kind: "unreadable", problem: firstProblem(text) };
	}
	const missing = missingWorkbenchDefaults(settings);
	if (missing.length === 0) return { kind: "answered" };
	let next = text;
	for (const [key, value] of missing) {
		next = applyEdits(next, setProperty(next, [key], value, FORMATTING));
	}
	return {
		kind: "write",
		text: next.endsWith("\n") ? next : `${next}\n`,
		keys: missing.map(([key]) => key),
	};
}

/**
 * The settings in this text, or nothing if it is not a settings object.
 *
 * VS Code's own parser, with VS Code's own defaults — comments and trailing
 * commas are settings-file grammar, not damage, and a file DevHub called
 * broken that the workbench reads happily would be DevHub inventing a fault.
 */
function readSettings(text: string): Record<string, unknown> | undefined {
	if (text.trim().length === 0) return {};
	const errors: ParseError[] = [];
	const parsed: unknown = parse(text, errors);
	if (errors.length > 0) return undefined;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		// A settings file that is a list or a number parses and still has no
		// key to answer for. There is nowhere to put a default, so it is the
		// same "not something DevHub can merge into" as a syntax error.
		return undefined;
	}
	return parsed as Record<string, unknown>;
}

function firstProblem(text: string): SettingsProblem {
	const errors: ParseError[] = [];
	parse(text, errors);
	return positionOf(text, errors[0]?.offset ?? 0);
}

function positionOf(text: string, offset: number): SettingsProblem {
	const before = text.slice(0, Math.min(offset, text.length));
	const lastBreak = before.lastIndexOf("\n");
	return {
		line: before.split("\n").length,
		column: before.length - lastBreak,
	};
}
