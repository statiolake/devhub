/** Ported from the `api.rs` test module of the Tauri agent adapter. */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	HERDR_INITIAL_REQUEST_BYTES,
	HerdrTransport,
	Invalidation,
	MAX_API_LINE_BYTES,
	baseSubscriptionKinds,
	clientSocketPath,
	parseResponse,
	sessionSocketPath,
} from "./api.js";
import {
	AgentRuntimeErrorCode,
	ProviderErrorCategory,
	type AgentRuntimeError,
} from "./error.js";

const scratchDirs: string[] = [];
const servers: Server[] = [];

function scratchDir(): string {
	// Under the repo, never the OS temp dir. Unix socket paths are short by
	// necessity, so the directory name is kept short too.
	const dir = mkdtempSync(join(import.meta.dirname, "api-t-"));
	scratchDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (servers.length > 0) {
		const server = servers.pop()!;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	while (scratchDirs.length > 0) {
		rmSync(scratchDirs.pop()!, { recursive: true, force: true });
	}
});

async function listen(
	path: string,
	onLine: (socket: import("node:net").Socket, line: string) => void,
): Promise<void> {
	const server = createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				onLine(socket, line);
			}
		});
		socket.on("error", () => undefined);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(path, resolve));
}

async function codeOf(
	run: () => Promise<unknown>,
): Promise<AgentRuntimeErrorCode> {
	try {
		await run();
	} catch (error) {
		return (error as AgentRuntimeError).code;
	}
	throw new Error("expected a failure");
}

describe("the Herdr JSON transport", () => {
	it("uses an absolute XDG config home only", () => {
		expect(sessionSocketPath("/devhub-home", "/config")).toBe(
			"/config/herdr/sessions/devhub-session/herdr.sock",
		);
		expect(sessionSocketPath("/devhub-home", "relative")).toBe(
			"/devhub-home/.config/herdr/sessions/devhub-session/herdr.sock",
		);
	});

	it("derives the control socket beside the API socket", () => {
		expect(
			clientSocketPath("/config/herdr/sessions/devhub-session/herdr.sock"),
		).toBe("/config/herdr/sessions/devhub-session/herdr-client.sock");
	});

	it("rejects an oversized request before it connects a socket", async () => {
		const transport = new HerdrTransport("/no/such/herdr.sock");
		expect(
			await codeOf(() =>
				transport.request("workspace.create", {
					payload: "x".repeat(HERDR_INITIAL_REQUEST_BYTES),
				}),
			),
		).toBe(AgentRuntimeErrorCode.BoundedInput);
	});

	it("bounds a provider line", async () => {
		const path = join(scratchDir(), "t.sock");
		await listen(path, (socket) => {
			socket.write(`${"x".repeat(MAX_API_LINE_BYTES + 1)}\n`);
		});
		const transport = new HerdrTransport(path, 2_000);
		expect(await codeOf(() => transport.request("ping", {}))).toBe(
			AgentRuntimeErrorCode.BoundedInput,
		);
	});

	it("classifies a missing provider resource as a stable cleanup class", () => {
		const line = Buffer.from(
			'{"id":"x","error":{"code":"pane_not_found","message":"secret"}}',
		);
		let error: AgentRuntimeError | undefined;
		try {
			parseResponse(line);
		} catch (thrown) {
			error = thrown as AgentRuntimeError;
		}
		expect(error?.code).toBe(AgentRuntimeErrorCode.ProviderNotFound);
		expect(`${error?.stack}${error?.message}`).not.toContain("secret");
	});

	it("classifies agent-start codes without retaining provider text", () => {
		for (const [providerCode, expected] of [
			["agent_name_taken", ProviderErrorCategory.AgentNameTaken],
			["agent_pane_busy", ProviderErrorCategory.AgentPaneBusy],
			["agent_pane_not_found", ProviderErrorCategory.AgentPaneNotFound],
			["agent_pane_unavailable", ProviderErrorCategory.AgentPaneUnavailable],
			["agent_start_input_failed", ProviderErrorCategory.AgentStartInputFailed],
			["invalid_request", ProviderErrorCategory.InvalidRequest],
			["future_private_code", ProviderErrorCategory.Other],
		] as const) {
			let error: AgentRuntimeError | undefined;
			try {
				parseResponse(
					Buffer.from(
						`{"id":"x","error":{"code":"${providerCode}","message":"private secret"}}`,
					),
				);
			} catch (thrown) {
				error = thrown as AgentRuntimeError;
			}
			expect(error?.providerCategory).toBe(expected);
			const rendered = `${error?.stack}${error?.message}`;
			expect(rendered).not.toContain(providerCode);
			expect(rendered).not.toContain("private secret");
		}
	});

	it("subscribes to structural and agent lifecycle events", () => {
		const rendered = JSON.stringify(baseSubscriptionKinds());
		expect(rendered).toContain("pane.agent_detected");
		expect(rendered).toContain("pane.updated");
		expect(rendered).not.toContain("pane-live");
	});

	it("keeps default requests bounded but allows the agent-start margin", async () => {
		const path = join(scratchDir(), "t.sock");
		await listen(path, (socket) => {
			setTimeout(() => socket.write('{"result":{"ok":true}}\n'), 5_500);
		});
		const transport = new HerdrTransport(path);
		expect(await codeOf(() => transport.request("ordinary", {}))).toBe(
			AgentRuntimeErrorCode.Timeout,
		);
		const started = (await transport.requestWithTimeout(
			"agent.start",
			{},
			7_000,
		)) as { ok: boolean };
		expect(started.ok).toBe(true);
	}, 20_000);

	it("coalesces invalidation for fifty milliseconds", () => {
		const invalidation = new Invalidation();
		expect(invalidation.pendingWait()).toBeUndefined();
		invalidation.mark();
		const wait = invalidation.pendingWait();
		expect(wait).toBeLessThanOrEqual(50);
		expect(wait).toBeGreaterThan(0);
		const generation = invalidation.generation;
		invalidation.mark();
		expect(invalidation.generation).toBeGreaterThan(generation);
	});
});
