/**
 * The process settings are DevHub's, and a workbench may not write them.
 *
 * `WorkbenchView` exists because a workbench is not entitled to a window of
 * DevHub's. The same sentence is true one level up: a workbench is not
 * entitled to the *application*. VS Code's main process reaches straight past
 * every service into `electron.app` to set the proxy for all of DevHub's
 * traffic, to fill the OS "recent items" with the files one editor opened, to
 * bounce the Dock, to replace the Dock menu, to claim `code-oss://` for the
 * DevHub binary, to point the updater at VS Code's own feed — each of them a
 * decision about DevHub made by something that has never heard of it.
 *
 * So those calls stop here. This is the same move `shell/menu.ts` makes for
 * `Menu.setApplicationMenu`: the method on the live object is replaced, and
 * what upstream calls is DevHub's answer instead of Electron's.
 *
 * **Why not a proxy object.** The audit proposed swapping `electron.app` for a
 * `Proxy`, which would also catch process APIs VS Code has not touched yet.
 * `app` is a non-configurable accessor on the `electron` module object — the
 * same wall `browserWindowShim.ts` documents for the `BrowserWindow`
 * constructor — so it cannot be swapped without a second submodule patch. The
 * members themselves are ordinary writable properties on the app object, so
 * this fence names them one at a time instead. The cost is that a *new* API
 * arrives unnoticed rather than warned about, and the mitigation is below:
 * every name is asserted to exist before it is replaced, so a rename in a VS
 * Code or Electron bump fails at startup rather than quietly reopening a hole.
 *
 * **What is not here.** `quit`, `exit` and `relaunch` are translated where
 * they mean something — `services/devhubLifecycleMainService.ts` — and not
 * here, because DevHub's own shutdown path calls exactly those three on the
 * same object and a fence around them would be a fence around DevHub itself.
 *
 * Installed from `codeMain.ts`, at the point where DevHub hands over to VS
 * Code: DevHub's own `app.setPath` calls in `main.ts` run long before that,
 * and everything after it belongs to the workbench world.
 */

import { electron } from "../electron.js";

/** A call that was refused, with what asked for it. */
export interface DroppedProcessSetting {
	readonly member: string;
	readonly at: Date;
}

const dropped: DroppedProcessSetting[] = [];

/**
 * What VS Code asked of DevHub's process and did not get.
 *
 * Kept because a fence that leaves no trace is indistinguishable from a
 * feature that never ran: when the Dock does not bounce or a proxy setting
 * appears to do nothing, this is the answer.
 */
export function droppedProcessSettings(): readonly DroppedProcessSetting[] {
	return dropped;
}

/**
 * The members DevHub answers instead of Electron, and what it answers.
 *
 * The value is what upstream gets back. Each one says "this did not happen"
 * in the vocabulary of that API — `false` for the two that report whether they
 * worked, a resolved promise for the one that is awaited, `-1` for the Dock's
 * bounce id, `undefined` for the rest — so no caller is told a refusal
 * succeeded.
 */
const APP_MEMBERS: Readonly<Record<string, () => unknown>> = {
	// The proxy for every DevHub connection, from one workbench's `http.proxy`.
	setProxy: () => Promise.resolve(),
	// The OS "recent items" belong to DevHub's own model of workspaces.
	addRecentDocument: () => undefined,
	clearRecentDocuments: () => undefined,
	// The Dock badge is the application's, not one workbench's notification.
	setBadgeCount: () => false,
	// The OS's idea of what this binary is, and what it opens.
	setAsDefaultProtocolClient: () => false,
	setAppUserModelId: () => undefined,
	// Every directory DevHub keeps is chosen in `main.ts`, before this runs.
	// The only caller left is the update service pointing `appUpdate` at VS
	// Code's feed.
	setPath: () => undefined,
};

/** Windows' jump list; the property does not exist elsewhere. */
const WINDOWS_APP_MEMBERS: Readonly<Record<string, () => unknown>> = {
	setJumpList: () => undefined,
};

/** macOS' Dock, which belongs to DevHub in the same way the menu bar does. */
const DOCK_MEMBERS: Readonly<Record<string, () => unknown>> = {
	// Upstream's Dock menu is "recent folders" and "new window" — DevHub's
	// answers to both live in the App Shell.
	setMenu: () => undefined,
	bounce: () => -1,
	cancelBounce: () => undefined,
	setBadge: () => undefined,
};

/**
 * Replace one member with DevHub's answer to it.
 *
 * Exported for the test, which drives it against a stand-in for `app`: the
 * real one only exists inside Electron.
 */
export function fenceMember(
	target: object,
	member: string,
	answer: () => unknown,
	what: string,
): void {
	const descriptor = Object.getOwnPropertyDescriptor(target, member);
	if (!descriptor) {
		// Loud, because the alternative is a fence with a hole in it that
		// nothing will ever point at. A bump that renames the member has to be
		// read, not survived.
		throw new Error(`DevHub cannot fence ${what}: there is no such member`);
	}
	if (!descriptor.writable && !descriptor.configurable) {
		throw new Error(`DevHub cannot fence ${what}: it is read-only`);
	}
	(target as Record<string, unknown>)[member] = (...args: unknown[]) => {
		void args;
		if (!dropped.some((call) => call.member === what)) {
			// Once per member: the first time says the fence is doing something,
			// and the hundredth would only bury it.
			console.info(
				`[devhub] the workbench asked for ${what} — not DevHub's to give`,
			);
		}
		dropped.push({ member: what, at: new Date() });
		return answer();
	};
}

export function installAppFence(): void {
	const app = electron.app;
	for (const [member, answer] of Object.entries(APP_MEMBERS)) {
		fenceMember(app, member, answer, `app.${member}`);
	}
	if (process.platform === "win32") {
		for (const [member, answer] of Object.entries(WINDOWS_APP_MEMBERS)) {
			fenceMember(app, member, answer, `app.${member}`);
		}
	}
	const dock = app.dock;
	if (dock) {
		for (const [member, answer] of Object.entries(DOCK_MEMBERS)) {
			fenceMember(dock, member, answer, `app.dock.${member}`);
		}
	}

	// Not under `app`, but the same sentence: one workbench's password-store
	// argument would drop the encryption backing every secret in the process to
	// plain text. Upstream checks whether the method exists before using it
	// (`encryptionMainService.ts`), so removing it puts upstream on its own
	// error path rather than a silent downgrade.
	const safeStorage = electron.safeStorage as unknown as Record<
		string,
		unknown
	>;
	if (typeof safeStorage.setUsePlainTextEncryption !== "function") {
		throw new Error(
			"DevHub cannot fence safeStorage.setUsePlainTextEncryption: there is no such member",
		);
	}
	safeStorage.setUsePlainTextEncryption = undefined;
}
