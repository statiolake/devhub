/**
 * Chromium's half of the microphone: the Agents page may open it, for audio
 * only, and nothing else changes.
 *
 * macOS granting DevHub the microphone (`voiceIpc.ts`) is not enough. VS Code's
 * `CodeApplication` installs a permission request handler and a permission
 * check handler on the default session, and they answer only for VS Code's own
 * origins (`vscode-file:` windows and `vscode-webview:` frames) — anything else,
 * DevHub's `devhub-app:` pages included, is refused. So `getUserMedia` on the
 * Agents page failed with Chromium's bare "Permission denied" even after the
 * system prompt had been answered with Allow.
 *
 * Electron keeps one handler of each kind per session, with no way to read the
 * one in place, so DevHub cannot ask VS Code's after the fact. Instead the two
 * setters on the default session are wrapped the moment the app is ready —
 * before VS Code's own `ready` listener runs, since this one is registered
 * from `shimEntry.ts`, first — and every handler set after that, VS Code's
 * included, answers through `allowsAgentsMicrophone` first and its own logic
 * for everything else.
 */

import type { Session, WebContents } from "electron";

import { SHELL_ORIGIN } from "../shell/shellPageProtocol.js";

/** The one page that dictates. */
export const AGENTS_PAGE_URL = `${SHELL_ORIGIN}/agents.html`;

function isAgentsPage(url: string | undefined): boolean {
	if (url === undefined) return false;
	const bare = url.split(/[?#]/, 1)[0];
	return bare === AGENTS_PAGE_URL;
}

/**
 * Whether a permission request is the Agents page asking for the microphone.
 *
 * Only `media`, only audio — a request that also wants the camera, or names
 * no media type at all, is not this, and goes to whatever handler would have
 * answered it anyway.
 */
export function allowsAgentsMicrophoneRequest(
	permission: string,
	details: {
		readonly requestingUrl?: string;
		readonly mediaTypes?: readonly string[];
	},
): boolean {
	if (permission !== "media") return false;
	if (!isAgentsPage(details.requestingUrl)) return false;
	const types = details.mediaTypes ?? [];
	return types.length > 0 && types.every((type) => type === "audio");
}

/** The same for a permission check, which names one media type, and an origin. */
export function allowsAgentsMicrophoneCheck(
	permission: string,
	pageUrl: string | undefined,
	requestingOrigin: string,
	details: { readonly mediaType?: string; readonly requestingUrl?: string },
): boolean {
	if (permission !== "media") return false;
	if (details.mediaType !== "audio") return false;
	if (requestingOrigin !== SHELL_ORIGIN) return false;
	return isAgentsPage(details.requestingUrl ?? pageUrl);
}

type RequestHandler = Parameters<Session["setPermissionRequestHandler"]>[0];
type CheckHandler = Parameters<Session["setPermissionCheckHandler"]>[0];

type PermissionSetters = Pick<
	Session,
	"setPermissionRequestHandler" | "setPermissionCheckHandler"
>;

/**
 * Wrap `session`'s two setters so that every handler set from now on lets the
 * Agents page have the microphone and answers everything else as the handler
 * it wraps would. Clearing a handler (`null`) leaves only the microphone
 * allowed: every other permission is refused, never opened up.
 */
export function letAgentsPageDictate(session: PermissionSetters): void {
	const setRequest = session.setPermissionRequestHandler.bind(session);
	const setCheck = session.setPermissionCheckHandler.bind(session);

	const wrapRequest = (handler: RequestHandler): RequestHandler => {
		return (contents, permission, callback, details) => {
			if (allowsAgentsMicrophoneRequest(permission, details)) {
				callback(true);
				return;
			}
			if (handler === null) {
				callback(false);
				return;
			}
			handler(contents, permission, callback, details);
		};
	};
	const wrapCheck = (handler: CheckHandler): CheckHandler => {
		return (contents, permission, requestingOrigin, details) => {
			if (
				allowsAgentsMicrophoneCheck(
					permission,
					pageUrlOf(contents),
					requestingOrigin,
					details,
				)
			)
				return true;
			if (handler === null) return false;
			return handler(contents, permission, requestingOrigin, details);
		};
	};

	session.setPermissionRequestHandler = (handler) => {
		setRequest(wrapRequest(handler));
	};
	session.setPermissionCheckHandler = (handler) => {
		setCheck(wrapCheck(handler));
	};
}

function pageUrlOf(contents: WebContents | null): string | undefined {
	try {
		return contents?.getURL();
	} catch {
		return undefined;
	}
}
