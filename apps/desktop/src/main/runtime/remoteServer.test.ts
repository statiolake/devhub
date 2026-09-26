import { describe, expect, it } from "vitest";
import { remoteServerPaths, startServerScript } from "./remoteServer.js";

const PATHS = remoteServerPaths({
	home: "/home/vscode",
	dataFolderName: ".devhub-server",
	applicationName: "devhub-server",
	commit: "abc",
});

describe("starting the remote extension host", () => {
	it("leaves its PATH alone when nothing is to be put in front", () => {
		expect(startServerScript(PATHS)).not.toMatch(/PATH=/u);
	});

	it("puts DevHub's devhub command in front of its PATH in a dev container", () => {
		// There is no DevHub tmux in a container to put it on a pane's PATH, so
		// the server carries it to the terminals and tasks it starts.
		const script = startServerScript(
			PATHS,
			"/home/vscode/.devhub-server/bin/x y",
		);
		expect(script).toContain(
			`PATH='/home/vscode/.devhub-server/bin/x y':"$PATH" nohup `,
		);
	});
});
