import { describe, expect, it, vi } from "vitest";
import {
	CLOSE_WORKSPACE_REQUEST,
	listenForCloseRequests,
	type ClosingWorkspace,
	type CloseRequestAnswer,
} from "./workbenchCloseRequests.js";

const WS = "11111111-1111-4111-8111-111111111111";
const SCRATCH = "00000000-0000-4000-8000-00000000005c";

interface Contents {
	readonly name: string;
}

/** ipcMain played by hand: the one handler, called as a workbench would. */
function harness(workspaces: Map<Contents, ClosingWorkspace>) {
	const handlers = new Map<
		string,
		(event: { readonly sender: Contents }, ...args: unknown[]) => unknown
	>();
	const close = vi.fn<(id: string) => void>();
	listenForCloseRequests<Contents>(
		{
			handle: (channel, listener) => {
				handlers.set(channel, listener);
			},
		},
		{ workspaceOf: (contents) => workspaces.get(contents), close },
	);
	const ask = (sender: Contents, mode: unknown): CloseRequestAnswer => {
		const handler = handlers.get(CLOSE_WORKSPACE_REQUEST);
		if (handler === undefined) throw new Error("no handler");
		return handler({ sender }, mode) as CloseRequestAnswer;
	};
	return { ask, close, handlers };
}

describe("a workbench asking to close its Workspace (Vim quitting)", () => {
	const editor = { name: "editor" };
	const scratch = { name: "scratch" };
	const stranger = { name: "stranger" };
	const workspaces = () =>
		new Map<Contents, ClosingWorkspace>([
			[editor, { id: WS, scratch: false, closing: false }],
			[scratch, { id: SCRATCH, scratch: true, closing: false }],
		]);

	it("answers on the channel the overlay asks on", () => {
		const { handlers } = harness(workspaces());
		expect([...handlers.keys()]).toEqual(["vscode:devhubCloseWorkspace"]);
	});

	it("a probe says the Workspace can close, and closes nothing", () => {
		const { ask, close } = harness(workspaces());
		expect(ask(editor, "probe")).toBe("closable");
		expect(close).not.toHaveBeenCalled();
	});

	it("close presses the Workspace's close button — the one close path", () => {
		const { ask, close } = harness(workspaces());
		expect(ask(editor, "close")).toBe("closing");
		expect(close).toHaveBeenCalledExactlyOnceWith(WS);
	});

	it("a close already underway (its sheet up) is not started again", () => {
		const { ask, close } = harness(
			new Map([[editor, { id: WS, scratch: false, closing: true }]]),
		);
		expect(ask(editor, "close")).toBe("closing");
		expect(close).not.toHaveBeenCalled();
	});

	it("Scratch is never closed: its workbench is told so, to probe and close alike", () => {
		const { ask, close } = harness(workspaces());
		expect(ask(scratch, "probe")).toBe("scratch");
		expect(ask(scratch, "close")).toBe("scratch");
		expect(close).not.toHaveBeenCalled();
	});

	it("contents that are no Workspace's workbench, and requests it does not know, close nothing", () => {
		const { ask, close } = harness(workspaces());
		expect(ask(stranger, "close")).toBe("unknown");
		expect(ask(editor, "quit")).toBe("unknown");
		expect(ask(editor, undefined)).toBe("unknown");
		expect(close).not.toHaveBeenCalled();
	});
});
