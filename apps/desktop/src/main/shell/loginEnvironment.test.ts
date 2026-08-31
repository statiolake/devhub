import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	launchEnvironment,
	loginEnvironmentSummary,
	resolveLoginEnvironment,
} from "./loginEnvironment.js";
import { resolveRuntimes } from "./runtimes.js";
import { runtimeUnavailableMessage } from "../../ipc/settings.js";

/**
 * The environment a Finder-launched macOS app inherits from launchd, and the
 * whole of the production defect: nothing a developer installed is on it.
 */
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * A stand-in login shell.
 *
 * The real one is the user's, which is neither reproducible nor safe to run in
 * a test. What matters is only that DevHub honours the contract it asks for:
 * run this shell as a login shell with one command, and read the JSON it
 * prints. A script that does exactly that is a truthful shell for this purpose.
 */
function fakeShell(body: string): string {
	const directory = mkdtempSync(join(tmpdir(), "devhub-loginenv-"));
	const path = join(directory, "fakeshell");
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

/** Prints the environment the way the real printer command would. */
const PRINTS_ENVIRONMENT = `
last=""
for arg in "$@"; do last="$arg"; done
mark=$(printf '%s' "$last" | sed -e 's/.*"\\(.*\\)" + JSON.*/\\1/')
printf '%s{"PATH":"/opt/tools/bin:/usr/bin","EXTRA":"yes"}%s\\n' "$mark" "$mark"
`;

describe("resolveLoginEnvironment", () => {
	it("imports the login shell's environment when the option is on", async () => {
		const shell = fakeShell(PRINTS_ENVIRONMENT);
		const login = await resolveLoginEnvironment({
			enabled: true,
			platform: "darwin",
			processEnvironment: { PATH: LAUNCHD_PATH, SHELL: shell },
		});
		expect(login).toEqual({
			kind: "imported",
			shell,
			variables: { PATH: "/opt/tools/bin:/usr/bin", EXTRA: "yes" },
		});
	});

	it("asks the shell from an environment with none of DevHub's own in it", async () => {
		// The login shell is a *child of DevHub*. Asked from DevHub's own
		// environment it inherits `VSCODE_DEV`, reacts to it — the reported
		// `.zshrc` runs the real VS Code CLI on exactly this — and prints it
		// straight back, which would undo the strip on the way through.
		const shell = fakeShell(`
last=""
for arg in "$@"; do last="$arg"; done
mark=$(printf '%s' "$last" | sed -e 's/.*"\\(.*\\)" + JSON.*/\\1/')
printf '%s{"SAW_VSCODE_DEV":"'"\${VSCODE_DEV:-no}"'","SAW_NODE_ENV":"'"\${NODE_ENV:-no}"'","PATH":"/opt/tools/bin"}%s\\n' "$mark" "$mark"
`);
		const login = await resolveLoginEnvironment({
			enabled: true,
			platform: "darwin",
			processEnvironment: {
				PATH: LAUNCHD_PATH,
				SHELL: shell,
				VSCODE_DEV: "1",
				NODE_ENV: "development",
			},
		});
		expect(login.kind).toBe("imported");
		if (login.kind !== "imported") return;
		expect(login.variables["SAW_VSCODE_DEV"]).toBe("no");
		expect(login.variables["SAW_NODE_ENV"]).toBe("no");
	});

	it("does not go out to a shell at all when the option is off", async () => {
		const login = await resolveLoginEnvironment({
			enabled: false,
			platform: "darwin",
			// A shell that would fail loudly if it were ever run.
			processEnvironment: { SHELL: "/nonexistent/shell" },
		});
		expect(login).toEqual({ kind: "disabled" });
	});

	it("reports a shell that exits with a failure, rather than pretending", async () => {
		const shell = fakeShell("exit 3");
		const login = await resolveLoginEnvironment({
			enabled: true,
			platform: "darwin",
			processEnvironment: { PATH: LAUNCHD_PATH, SHELL: shell },
		});
		expect(login.kind).toBe("failed");
		expect(loginEnvironmentSummary(login)).toContain("exited with code 3");
		expect(loginEnvironmentSummary(login)).toContain(shell);
	});

	it("reports a shell that prints nothing recognisable", async () => {
		const shell = fakeShell("echo hello");
		const login = await resolveLoginEnvironment({
			enabled: true,
			platform: "darwin",
			processEnvironment: { PATH: LAUNCHD_PATH, SHELL: shell },
		});
		expect(login.kind).toBe("failed");
		expect(loginEnvironmentSummary(login)).toContain("printed no environment");
	});

	it("gives up on a shell that never answers, and says so", async () => {
		const shell = fakeShell("sleep 30");
		const login = await resolveLoginEnvironment({
			enabled: true,
			platform: "darwin",
			timeoutMs: 200,
			processEnvironment: { PATH: LAUNCHD_PATH, SHELL: shell },
		});
		expect(login.kind).toBe("failed");
		expect(loginEnvironmentSummary(login)).toContain("did not answer");
	});

	it("reports a SHELL that names nothing runnable", async () => {
		const login = await resolveLoginEnvironment({
			enabled: true,
			platform: "darwin",
			processEnvironment: { PATH: LAUNCHD_PATH, SHELL: "/nonexistent/shell" },
		});
		expect(login.kind).toBe("failed");
		expect(loginEnvironmentSummary(login)).toContain("could not be started");
	});
});

describe("launchEnvironment", () => {
	it("lets the login shell's values win over the launch context's", async () => {
		const shell = fakeShell(PRINTS_ENVIRONMENT);
		const login = await resolveLoginEnvironment({
			enabled: true,
			platform: "darwin",
			processEnvironment: { PATH: LAUNCHD_PATH, SHELL: shell },
		});
		const environment = launchEnvironment(
			{ PATH: LAUNCHD_PATH, XDG_CONFIG_HOME: "/config" },
			login,
		);
		expect(environment["PATH"]).toBe("/opt/tools/bin:/usr/bin");
		// A variable only the launch context has survives: the shell never
		// mentioned it, so there is nothing to override it with.
		expect(environment["XDG_CONFIG_HOME"]).toBe("/config");
	});

	it("is exactly the process environment when the import is off", () => {
		const environment = launchEnvironment(
			{ PATH: LAUNCHD_PATH },
			{ kind: "disabled" },
		);
		expect(environment).toEqual({ PATH: LAUNCHD_PATH });
	});

	/**
	 * The environment a `dev.sh` run really has, plus what Electron and
	 * Chromium add to it. Every one of these is a true statement about DevHub's
	 * own process and a false one about the shell the user is about to type
	 * into — a `.zshrc` that believes `VSCODE_DEV` goes looking for the real
	 * VS Code CLI.
	 */
	const POISONED_PARENT = {
		PATH: LAUNCHD_PATH,
		HOME: "/home/testuser",
		SHELL: "/bin/zsh",
		LANG: "en_US.UTF-8",
		VSCODE_DEV: "1",
		VSCODE_CLI: "1",
		VSCODE_NLS_CONFIG: "{}",
		VSCODE_IPC_HOOK: "/run/vscode.sock",
		NODE_ENV: "development",
		ELECTRON_RUN_AS_NODE: "1",
		ELECTRON_ENABLE_LOGGING: "1",
		ELECTRON_ENABLE_STACK_DUMPING: "1",
		CHROME_DESKTOP: "code-oss.desktop",
		DEVHUB_CONTROL_SOCKET: "/run/devhub/control.sock",
	} as const;

	it("hands a child none of DevHub's own runtime variables", () => {
		const environment = launchEnvironment(POISONED_PARENT, {
			kind: "disabled",
		});
		// The families, not a list of the names that broke something once.
		for (const name of Object.keys(environment)) {
			expect(name).not.toMatch(/^(?:VSCODE_|ELECTRON_|CHROME_|DEVHUB_)/u);
		}
		expect(environment["NODE_ENV"]).toBeUndefined();
		// What is left is the user's session, untouched.
		expect(environment).toEqual({
			PATH: LAUNCHD_PATH,
			HOME: "/home/testuser",
			SHELL: "/bin/zsh",
			LANG: "en_US.UTF-8",
		});
	});

	it("strips the same variables whether or not the import ran", () => {
		// The packaged app sets fewer of these than `dev.sh` does, and a
		// packaged run has the import on. Neither is a separate case.
		const imported = launchEnvironment(POISONED_PARENT, {
			kind: "imported",
			shell: "/bin/zsh",
			variables: { PATH: "/opt/tools/bin", EXTRA: "yes" },
		});
		expect(imported["VSCODE_DEV"]).toBeUndefined();
		expect(imported["ELECTRON_RUN_AS_NODE"]).toBeUndefined();
		expect(imported["NODE_ENV"]).toBeUndefined();
		// Login-imported values survive, and still win over the launch context.
		expect(imported["PATH"]).toBe("/opt/tools/bin");
		expect(imported["EXTRA"]).toBe("yes");
		expect(imported["HOME"]).toBe("/home/testuser");
	});

	it("keeps a value the user's own profile exports, whatever it is named", () => {
		// Where a value came from is the whole rule: the strip is on the
		// process layer, so a variable the login shell printed is the user's
		// and DevHub has no business deleting it.
		const environment = launchEnvironment(POISONED_PARENT, {
			kind: "imported",
			shell: "/bin/zsh",
			variables: { NODE_ENV: "production", VSCODE_PORTABLE: "/opt/vscode" },
		});
		expect(environment["NODE_ENV"]).toBe("production");
		expect(environment["VSCODE_PORTABLE"]).toBe("/opt/vscode");
	});
});

describe("runtime resolution in the imported environment", () => {
	const runtimes = {
		shell: "/bin/sh",
		git: "git",
		tmux: "tmux",
		tmux_socket_name: "devhub",
		tmux_args: [],
	};

	it("names the executable and the directories it looked in", async () => {
		const resolved = await resolveRuntimes(runtimes, LAUNCHD_PATH);
		expect(resolved.tmux.kind).toBe("unavailable");
		if (resolved.tmux.kind !== "unavailable") return;
		expect(runtimeUnavailableMessage(resolved.tmux)).toBe(
			"DevHub could not find 'tmux' on PATH (looked in: /usr/bin, /bin, /usr/sbin, /sbin).",
		);
	});

	it("names the path a configured path pointed at", async () => {
		const resolved = await resolveRuntimes(
			{ ...runtimes, tmux: "/opt/nothing/bin/tmux" },
			LAUNCHD_PATH,
		);
		expect(resolved.tmux.kind).toBe("unavailable");
		if (resolved.tmux.kind !== "unavailable") return;
		expect(runtimeUnavailableMessage(resolved.tmux)).toBe(
			"DevHub could not find '/opt/nothing/bin/tmux' at /opt/nothing/bin/tmux.",
		);
	});

	it("says so when there is no PATH to search at all", async () => {
		const resolved = await resolveRuntimes(runtimes, "");
		expect(resolved.tmux.kind).toBe("unavailable");
		if (resolved.tmux.kind !== "unavailable") return;
		expect(runtimeUnavailableMessage(resolved.tmux)).toBe(
			"DevHub could not find 'tmux' on PATH (PATH is empty).",
		);
	});

	it("finds an executable the login shell's PATH reaches and launchd's does not", async () => {
		const directory = mkdtempSync(join(tmpdir(), "devhub-loginenv-bin-"));
		const tool = join(directory, "tmux");
		writeFileSync(tool, "#!/bin/sh\nexit 0\n");
		chmodSync(tool, 0o755);

		expect((await resolveRuntimes(runtimes, LAUNCHD_PATH)).tmux.kind).toBe(
			"unavailable",
		);
		const imported = await resolveRuntimes(
			runtimes,
			`${directory}:${LAUNCHD_PATH}`,
		);
		expect(imported.tmux).toEqual({ kind: "absolute_path", value: tool });
	});
});
