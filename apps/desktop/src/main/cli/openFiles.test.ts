/**
 * That a local file opened into a *remote* window is a local file.
 *
 * This is the finding the rest of the same-window work rests on, and it is
 * unobvious enough to be worth stating twice — once about DevHub's own message,
 * and once about the upstream registration that makes the message mean what it
 * says.
 *
 * In the desktop workbench the renderer runs on this machine, and `file:` is
 * registered against the *local* disk in every window, remote authority or not
 * (`vscode/src/vs/workbench/electron-browser/desktop.main.ts`, "Local Files").
 * The remote file system is a different scheme entirely, `vscode-remote:`
 * (`remoteFileSystemProviderClient.ts`). The renaming people have in mind when
 * they say "`file:` in a remote window means the remote FS" happens only at the
 * extension-host RPC boundary, in the URI transformer, and the renderer-side
 * protocol is created without one.
 *
 * So: no provider, no patch, no new scheme, and no branch in `openFiles.ts`.
 * What there has to be is a test, because "we rely on upstream not having a
 * branch here" is exactly the kind of claim that stops being true during a
 * submodule bump and takes a week to find afterwards.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ICodeWindow } from "code-oss-dev/out/vs/platform/window/electron-main/window.js";
import { openFileInWorkbench } from "./openFiles.js";

/** The repo root, from this file's own location. */
const REPO_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
	"..",
);

function vscodeSource(...parts: string[]): string {
	return readFileSync(join(REPO_ROOT, "vscode", "src", "vs", ...parts), "utf8");
}

interface SentMessage {
	readonly channel: string;
	readonly payload: {
		readonly filesToOpenOrCreate?: readonly {
			readonly fileUri: { readonly scheme: string; readonly path: string };
		}[];
		readonly filesToWait?: {
			readonly waitMarkerFileUri: {
				readonly scheme: string;
				readonly path: string;
			};
		};
	};
}

/** A window that records what it was sent, and nothing else. */
function recordingWindow(remoteAuthority: string | undefined): {
	readonly window: ICodeWindow;
	readonly sent: SentMessage[];
} {
	const sent: SentMessage[] = [];
	const window = {
		remoteAuthority,
		sendWhenReady: (channel: string, _cancel: unknown, payload: unknown) => {
			sent.push({ channel, payload: payload as SentMessage["payload"] });
		},
	} as unknown as ICodeWindow;
	return { window, sent };
}

describe("a local file opened into a window with a remote authority", () => {
	it("is sent as a file: URI, the same one a local window is sent", () => {
		const remote = recordingWindow("ssh-remote+build-host");
		const local = recordingWindow(undefined);
		const file = { path: "/work/notes.md", exists: true, isDirectory: false };

		openFileInWorkbench(remote.window, file, undefined, undefined);
		openFileInWorkbench(local.window, file, undefined, undefined);

		const opened = remote.sent[0]?.payload.filesToOpenOrCreate?.[0]?.fileUri;
		expect(opened?.scheme).toBe("file");
		expect(opened?.path).toBe("/work/notes.md");
		// Byte for byte the same message: there is no remote case here, which
		// is the whole claim. A branch would be the thing to delete.
		expect(remote.sent).toEqual(local.sent);
	});

	/**
	 * The marker rides on the same rule, and it is the one that hurts when it
	 * is wrong: a marker the workbench deletes on the wrong machine leaves a
	 * `git commit` waiting forever on a file nothing will ever touch.
	 */
	it("sends the --wait marker as a file: URI too", () => {
		const remote = recordingWindow("ssh-remote+build-host");

		openFileInWorkbench(
			remote.window,
			{ path: "/work/COMMIT_EDITMSG", exists: true, isDirectory: false },
			undefined,
			"/var/folders/devhub-wait/marker",
		);

		const marker = remote.sent[0]?.payload.filesToWait?.waitMarkerFileUri;
		expect(marker?.scheme).toBe("file");
		expect(marker?.path).toBe("/var/folders/devhub-wait/marker");
	});
});

/**
 * The upstream facts the test above is only meaningful because of.
 *
 * Read out of the pinned submodule's source rather than asserted from memory,
 * so that a bump which adds a `remoteAuthority` branch to the "Local Files"
 * registration turns this red here instead of turning a local file in a remote
 * window into a file nobody can save.
 */
describe("the workbench's file: provider", () => {
	it("is the local disk, registered with no remote-authority branch", () => {
		const source = vscodeSource(
			"workbench",
			"electron-browser",
			"desktop.main.ts",
		);

		const registration = source.indexOf(
			"fileService.registerProvider(Schemas.file, diskFileSystemProvider)",
		);
		expect(registration).toBeGreaterThan(0);

		// The provider it registers is the electron-browser one — an IPC client
		// to *this* machine's main process — and it is constructed right above
		// the registration with nothing between them that could pick a
		// different one per window.
		const construction = source.lastIndexOf(
			"new DiskFileSystemProvider(",
			registration,
		);
		expect(construction).toBeGreaterThan(0);
		const between = source.slice(construction, registration);
		expect(between).not.toMatch(/remoteAuthority/u);
		expect(between).not.toMatch(/\bif\s*\(/u);
	});

	it("is a different scheme from the remote file system", () => {
		const source = vscodeSource(
			"workbench",
			"services",
			"remote",
			"common",
			"remoteFileSystemProviderClient.ts",
		);

		// `vscode-remote:`, not `file:`. The two never contend for one scheme,
		// which is why a remote window can hold both kinds of editor at once.
		expect(source).toMatch(/registerProvider\(\s*Schemas\.vscodeRemote\s*,/u);
		expect(source).not.toMatch(/registerProvider\(\s*Schemas\.file\s*,/u);
	});
});
