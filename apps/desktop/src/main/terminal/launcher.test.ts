import { describe, expect, it } from "vitest";
import {
	remoteTerminalPaths,
	remoteCliBinDirectory,
	remoteCliScript,
} from "./launcher.js";

describe("where all of it goes on another machine", () => {
	const paths = {
		home: "/home/dev",
		controlSocketPath: "/data/devhub/devhub/control.sock",
	};

	it("keeps DevHub's files in one directory of its own", () => {
		const remote = remoteTerminalPaths(paths);
		expect(remote.directory).toBe("/home/dev/.devhub/terminal");
		expect(remote.socket.startsWith(`${remote.directory}/`)).toBe(true);
	});

	// Two DevHub profiles on one Mac reaching one host must not adopt each
	// other's socket, and the socket path is the one thing that tells them
	// apart before anything has been written.
	it("gives each DevHub its own socket on the host", () => {
		const other = remoteTerminalPaths({
			...paths,
			controlSocketPath: "/data/devhub-second/devhub/control.sock",
		});
		expect(other.socket).not.toBe(remoteTerminalPaths(paths).socket);
	});

	it("puts the `devhub` command in a directory of its own, beside the rest", () => {
		const remote = remoteTerminalPaths(paths);
		expect(remote.cliBinDirectory.startsWith(`${remote.directory}/`)).toBe(
			true,
		);
		expect(remote.cli).toBe(`${remote.cliBinDirectory}/devhub`);
	});

	/**
	 * The *directory* is what goes on a pane's PATH, so it is the directory
	 * that has to differ per DevHub: two profiles sharing one would put two
	 * `devhub` scripts at one path, and the second to start would silently
	 * take the first one's name.
	 */
	it("gives each DevHub its own bin directory, not just its own file", () => {
		const other = remoteTerminalPaths({
			...paths,
			controlSocketPath: "/data/devhub-second/devhub/control.sock",
		});
		expect(other.cliBinDirectory).not.toBe(
			remoteTerminalPaths(paths).cliBinDirectory,
		);
		// And the derived spelling is the same one, so the PATH a session is
		// given names the directory the shim was actually written into.
		expect(remoteCliBinDirectory(paths.home, paths.controlSocketPath)).toBe(
			remoteTerminalPaths(paths).cliBinDirectory,
		);
	});
});

/**
 * The `devhub` a pane on a host runs.
 *
 * A shim that execs the app's own `devhub` binary installed there, over
 * DevHub's own forwarded socket.
 */
describe("the `devhub` command written on another machine", () => {
	const script = remoteCliScript({
		execPath: "/home/dev/.devhub-server/devhub/0123456789ab/bin/devhub",
		socketPath: "/home/dev/.devhub/terminal/control-abcdef.sock",
		machine: "ssh:build-host",
	});

	it("runs the installed binary on the forwarded socket", () => {
		expect(script).toContain(
			"exec '/home/dev/.devhub-server/devhub/0123456789ab/bin/devhub' \"$@\"",
		);
		expect(script).toContain(
			"DEVHUB_CONTROL_SOCKET='/home/dev/.devhub/terminal/control-abcdef.sock'",
		);
	});

	/**
	 * Without this a host's `/srv/app` is matched against a Workspace of the
	 * same name on this Mac, and the file opens off the wrong disk.
	 */
	it("says which machine the paths typed into it are paths on", () => {
		expect(script).toContain("DEVHUB_MACHINE='ssh:build-host'");
	});

	/**
	 * Its absence is the truth, not an omission: DevHub runs on the machine
	 * the window is on, and nothing over there can start it.
	 */
	it("records no way to start DevHub, because there is none from there", () => {
		expect(script).not.toContain("DEVHUB_LAUNCH_COMMAND");
	});

	/** A missing binary says which file, rather than `exec: not found`. */
	it("names the binary it cannot find rather than failing as a shell", () => {
		expect(script).toContain(
			"if [ ! -x '/home/dev/.devhub-server/devhub/0123456789ab/bin/devhub' ]; then",
		);
	});

	it("is a POSIX shell script, because a host may have no bash", () => {
		expect(script.startsWith("#!/bin/sh\n")).toBe(true);
	});
});
