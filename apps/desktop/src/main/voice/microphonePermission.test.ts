import { describe, expect, it, vi } from "vitest";

import {
	AGENTS_PAGE_URL,
	allowsAgentsMicrophoneCheck,
	allowsAgentsMicrophoneRequest,
	letAgentsPageDictate,
} from "./microphonePermission.js";

const SHELL = "devhub-app://shell";

describe("allowsAgentsMicrophoneRequest", () => {
	it("allows audio for the Agents page", () => {
		expect(
			allowsAgentsMicrophoneRequest("media", {
				requestingUrl: AGENTS_PAGE_URL,
				mediaTypes: ["audio"],
			}),
		).toBe(true);
		expect(
			allowsAgentsMicrophoneRequest("media", {
				requestingUrl: `${AGENTS_PAGE_URL}?x=1#y`,
				mediaTypes: ["audio"],
			}),
		).toBe(true);
	});

	it("refuses video, unnamed media, other permissions and other pages", () => {
		const cases: [string, string, string[]][] = [
			["media", AGENTS_PAGE_URL, ["audio", "video"]],
			["media", AGENTS_PAGE_URL, ["video"]],
			["media", AGENTS_PAGE_URL, []],
			["geolocation", AGENTS_PAGE_URL, ["audio"]],
			["media", `${SHELL}/sidebar.html`, ["audio"]],
			["media", "vscode-file://vscode-app/x/workbench.html", ["audio"]],
			["media", "https://evil.example/agents.html", ["audio"]],
		];
		for (const [permission, url, mediaTypes] of cases)
			expect(
				allowsAgentsMicrophoneRequest(permission, {
					requestingUrl: url,
					mediaTypes,
				}),
			).toBe(false);
	});
});

describe("allowsAgentsMicrophoneCheck", () => {
	it("allows an audio check from the Agents page", () => {
		expect(
			allowsAgentsMicrophoneCheck("media", AGENTS_PAGE_URL, SHELL, {
				mediaType: "audio",
			}),
		).toBe(true);
	});

	it("refuses anything else", () => {
		expect(
			allowsAgentsMicrophoneCheck("media", AGENTS_PAGE_URL, SHELL, {
				mediaType: "video",
			}),
		).toBe(false);
		expect(
			allowsAgentsMicrophoneCheck("media", `${SHELL}/toasts.html`, SHELL, {
				mediaType: "audio",
			}),
		).toBe(false);
		expect(
			allowsAgentsMicrophoneCheck("media", AGENTS_PAGE_URL, "https://x", {
				mediaType: "audio",
			}),
		).toBe(false);
		expect(
			allowsAgentsMicrophoneCheck("clipboard-read", AGENTS_PAGE_URL, SHELL, {
				mediaType: "audio",
			}),
		).toBe(false);
	});
});

describe("letAgentsPageDictate", () => {
	function fakeSession() {
		const installed: { request?: unknown; check?: unknown } = {};
		const session = {
			setPermissionRequestHandler: (handler: unknown) => {
				installed.request = handler;
			},
			setPermissionCheckHandler: (handler: unknown) => {
				installed.check = handler;
			},
		};
		return { session, installed };
	}

	it("lets the Agents page through a handler that refuses everything (VS Code's)", () => {
		const { session, installed } = fakeSession();
		letAgentsPageDictate(session as never);
		const vscodeRequest = vi.fn(
			(_c: unknown, _p: string, callback: (ok: boolean) => void) =>
				callback(false),
		);
		const vscodeCheck = vi.fn(() => false);
		session.setPermissionRequestHandler(vscodeRequest as never);
		session.setPermissionCheckHandler(vscodeCheck as never);

		const request = installed.request as (
			c: unknown,
			p: string,
			cb: (ok: boolean) => void,
			d: object,
		) => void;
		const check = installed.check as (
			c: unknown,
			p: string,
			o: string,
			d: object,
		) => boolean;

		const answers: boolean[] = [];
		request(null, "media", (ok) => answers.push(ok), {
			requestingUrl: AGENTS_PAGE_URL,
			mediaTypes: ["audio"],
		});
		request(null, "media", (ok) => answers.push(ok), {
			requestingUrl: AGENTS_PAGE_URL,
			mediaTypes: ["video"],
		});
		expect(answers).toEqual([true, false]);
		expect(vscodeRequest).toHaveBeenCalledTimes(1);

		const contents = { getURL: () => AGENTS_PAGE_URL };
		expect(check(contents, "media", SHELL, { mediaType: "audio" })).toBe(true);
		expect(check(contents, "media", SHELL, { mediaType: "video" })).toBe(false);
		expect(vscodeCheck).toHaveBeenCalledTimes(1);
	});

	it("refuses everything else when the handler is cleared", () => {
		const { session, installed } = fakeSession();
		letAgentsPageDictate(session as never);
		session.setPermissionRequestHandler(null as never);
		session.setPermissionCheckHandler(null as never);
		const answers: boolean[] = [];
		(
			installed.request as (
				c: unknown,
				p: string,
				cb: (ok: boolean) => void,
				d: object,
			) => void
		)(null, "geolocation", (ok) => answers.push(ok), {
			requestingUrl: AGENTS_PAGE_URL,
		});
		expect(answers).toEqual([false]);
		expect(
			(installed.check as (...a: unknown[]) => boolean)(
				null,
				"notifications",
				SHELL,
				{},
			),
		).toBe(false);
	});
});
