/**
 * Which mounts a dev container gets so git works in a worktree's folder.
 *
 * The decision is pure — what git said about the folder, and where the
 * definition puts it — so it is tested here without a repository, a CLI or
 * docker. The layouts are the ones from the field: a custom `/workspace`
 * mount, the CLI's default `/workspaces/<name>`, and an absolute link.
 */

import { describe, expect, it } from "vitest";
import {
	CONTAINER_GIT_ROOT,
	CONTAINER_OVERRIDE_FILE,
	configArguments,
	mainCheckout,
	overrideFileCommand,
	parseJsonc,
	planWorkspace,
	containerCommonDir,
	containerLayout,
	dotGitFileCommand,
	gitdirLink,
	hasMount,
	missingMountAdvice,
	parseRevParse,
	planWorktreeMount,
	upArguments,
	type WorktreeFacts,
} from "./worktreeMount.js";

const MAIN = "/Users/me/src/vscode-pahcer-ui";
const COMMON = `${MAIN}/.git`;
const WORKTREE = "/Users/me/src/vscode-pahcer-ui_5";
const RECORD = `${COMMON}/worktrees/vscode-pahcer-ui_5`;

function worktree(dotGit: string | undefined): WorktreeFacts {
	return { toplevel: WORKTREE, gitDir: RECORD, commonDir: COMMON, dotGit };
}

const RELATIVE = worktree(
	"gitdir: ../vscode-pahcer-ui/.git/worktrees/vscode-pahcer-ui_5\n",
);
const ABSOLUTE = worktree(`gitdir: ${RECORD}\n`);
const FIXED = containerCommonDir(COMMON);

describe("reading git's answer", () => {
	it("reads the three absolute paths rev-parse prints", () => {
		expect(parseRevParse(`${WORKTREE}\n${RECORD}\n${COMMON}/\n`)).toEqual({
			toplevel: WORKTREE,
			gitDir: RECORD,
			// Normalised, so it compares equal to a mount's source.
			commonDir: COMMON,
		});
	});

	it("refuses anything that is not three absolute paths", () => {
		expect(parseRevParse("--path-format=absolute\n/a\n.git\n")).toBeUndefined();
		expect(parseRevParse("")).toBeUndefined();
	});

	it("reads the link out of a worktree's .git file", () => {
		expect(gitdirLink("gitdir: ../w/.git/worktrees/x\n")).toBe(
			"../w/.git/worktrees/x",
		);
		expect(gitdirLink("not a link")).toBeUndefined();
	});
});

describe("the fixed path of a common dir", () => {
	it("names the repository and a hash of where it is", () => {
		expect(FIXED).toMatch(
			new RegExp(
				`^${CONTAINER_GIT_ROOT}/vscode-pahcer-ui-[0-9a-f]{12}\\.git$`,
				"u",
			),
		);
		expect(containerCommonDir("/elsewhere/vscode-pahcer-ui/.git")).not.toBe(
			FIXED,
		);
		expect(containerCommonDir("/x/my repo,1/.git")).toMatch(/\/my_repo_1-/u);
	});
});

describe("a custom /workspace mount and a relative link", () => {
	// Inside, git said:
	// fatal: not a git repository: /workspace/../vscode-pahcer-ui/.git/worktrees/vscode-pahcer-ui_5
	const layout = containerLayout(
		WORKTREE,
		WORKTREE,
		{
			workspaceMount:
				"source=${localWorkspaceFolder},target=/workspace,type=bind,consistency=cached",
			workspaceFolder: "/workspace",
		},
		"/workspace",
	);

	it("finds the worktree at the mount's target", () => {
		expect(layout).toEqual({ kind: "single", containerToplevel: "/workspace" });
	});

	it("mounts the common dir at the fixed path and a .git file over the worktree's", () => {
		const mount = planWorktreeMount(RELATIVE, layout);
		expect(mount).toEqual({
			kind: "overlay",
			commonDir: COMMON,
			containerCommonDir: FIXED,
			dotGitFile: `${RECORD}/devhub-container-gitdir`,
			dotGitContent: `gitdir: ${FIXED}/worktrees/vscode-pahcer-ui_5\n`,
			containerDotGit: "/workspace/.git",
		});
		expect(upArguments(mount)).toEqual([
			"--mount",
			`type=bind,source=${COMMON},target=${FIXED}`,
			"--mount",
			`type=bind,source=${RECORD}/devhub-container-gitdir,target=/workspace/.git,readonly`,
		]);
	});

	it("works however deep the relative path goes", () => {
		// `../../../x/.git` from `/workspace` would escape `/`; the fixed path
		// does not care.
		const deep: WorktreeFacts = {
			toplevel: "/Users/me/a/b/c/wt",
			gitDir: "/Users/me/x/.git/worktrees/wt",
			commonDir: "/Users/me/x/.git",
			dotGit: "gitdir: ../../../../x/.git/worktrees/wt\n",
		};
		const mount = planWorktreeMount(
			deep,
			containerLayout(
				deep.toplevel,
				deep.toplevel,
				{
					workspaceMount: `source=${deep.toplevel},target=/workspace,type=bind`,
				},
				"/workspace",
			),
		);
		expect(mount.kind).toBe("overlay");
		if (mount.kind !== "overlay") return;
		expect(mount.containerDotGit).toBe("/workspace/.git");
		expect(mount.containerCommonDir).toBe(
			containerCommonDir("/Users/me/x/.git"),
		);
	});

	it("tells the person to recreate a container made without the mounts", () => {
		const mount = planWorktreeMount(RELATIVE, layout);
		const before = [{ source: WORKTREE, destination: "/workspace" }];
		expect(hasMount(mount, before)).toBe(false);
		expect(missingMountAdvice("the container", "c0ffee", mount)).toContain(
			"docker rm -f c0ffee",
		);
		// The common dir at its host path (the old absolute fallback) is not it.
		expect(
			hasMount(mount, [...before, { source: COMMON, destination: COMMON }]),
		).toBe(false);
		expect(
			hasMount(mount, [
				...before,
				{ source: `${COMMON}/`, destination: FIXED },
				{
					source: `${RECORD}/devhub-container-gitdir`,
					destination: "/workspace/.git",
				},
			]),
		).toBe(true);
	});

	it("writes the .git file only when it is not there", () => {
		const command = dotGitFileCommand(planWorktreeMount(RELATIVE, layout));
		expect(command?.slice(0, 3)).toEqual([
			"sh",
			"-c",
			'[ -f "$1" ] || printf "%s" "$2" > "$1"',
		]);
		expect(dotGitFileCommand({ kind: "none" })).toBeUndefined();
	});
});

describe("the CLI's default /workspaces mount", () => {
	it("puts the .git file over /workspaces/<name>/.git", () => {
		const layout = containerLayout(WORKTREE, WORKTREE, {}, undefined);
		expect(layout).toEqual({
			kind: "single",
			containerToplevel: "/workspaces/vscode-pahcer-ui_5",
		});
		const mount = planWorktreeMount(RELATIVE, layout);
		expect(mount.kind === "overlay" && mount.containerDotGit).toBe(
			"/workspaces/vscode-pahcer-ui_5/.git",
		);
	});

	it("follows read-configuration's workspaceFolder when it is given", () => {
		expect(
			containerLayout(WORKTREE, WORKTREE, {}, "/workspaces/vscode-pahcer-ui_5"),
		).toEqual({
			kind: "single",
			containerToplevel: "/workspaces/vscode-pahcer-ui_5",
		});
	});
});

describe("an absolute link", () => {
	it("gets the same two mounts", () => {
		const layout = containerLayout(WORKTREE, WORKTREE, {}, "/workspaces/w");
		expect(planWorktreeMount(ABSOLUTE, layout)).toEqual(
			planWorktreeMount(RELATIVE, layout),
		);
	});
});

describe("what is left alone or only said", () => {
	const layout = { kind: "single", containerToplevel: "/w" } as const;

	it("adds nothing for the main checkout or an unreadable worktree", () => {
		expect(planWorktreeMount({ ...ABSOLUTE, gitDir: COMMON }, layout)).toEqual({
			kind: "none",
		});
		expect(planWorktreeMount(undefined, layout)).toEqual({ kind: "none" });
		expect(planWorktreeMount(worktree(undefined), layout)).toEqual({
			kind: "none",
		});
	});

	it("says what a Docker Compose definition needs", () => {
		const compose = containerLayout(
			WORKTREE,
			WORKTREE,
			{ dockerComposeFile: "compose.yml" },
			"/workspace",
		);
		expect(compose).toEqual({ kind: "compose" });
		for (const facts of [RELATIVE, ABSOLUTE]) {
			const mount = planWorktreeMount(facts, compose);
			expect(mount.kind).toBe("unsupported");
			expect(upArguments(mount)).toEqual([]);
			expect(missingMountAdvice("x", "a", mount)).toContain(FIXED);
		}
	});

	it("says, rather than guesses, when the layout is unknown", () => {
		expect(planWorktreeMount(RELATIVE, undefined).kind).toBe("unsupported");
		expect(missingMountAdvice("x", "a", { kind: "none" })).toBeUndefined();
	});

	it("quotes a path with a comma the way the CLI does", () => {
		const mount = planWorktreeMount(
			{
				toplevel: "/a,b/wt",
				gitDir: "/a,b/r/.git/worktrees/wt",
				commonDir: "/a,b/r/.git",
				dotGit: "gitdir: ../r/.git/worktrees/wt\n",
			},
			layout,
		);
		expect(upArguments(mount)[1]).toContain('source="/a,b/r/.git"');
	});
});

describe("a worktree goes where its main checkout would", () => {
	const plan = (raw: Record<string, unknown>, host = WORKTREE) =>
		planWorkspace(raw, host, WORKTREE, MAIN, RECORD);
	const written = (
		result: ReturnType<typeof plan>,
	): Record<string, unknown> => {
		if ("unsupported" in result) throw new Error(result.unsupported);
		return JSON.parse(result.content) as Record<string, unknown>;
	};

	it("finds the main checkout from the common dir", () => {
		expect(mainCheckout(COMMON)).toBe(MAIN);
		expect(mainCheckout("/srv/bare.git")).toBeUndefined();
	});

	it("uses /workspaces/<main checkout's name> by default", () => {
		const result = plan({ image: "x" });
		expect(result).toMatchObject({
			containerToplevel: "/workspaces/vscode-pahcer-ui",
			mounts: [],
			file: `${RECORD}/${CONTAINER_OVERRIDE_FILE}`,
		});
		expect(written(result)).toEqual({
			image: "x",
			workspaceMount: `type=bind,source=${WORKTREE},target=/workspaces/vscode-pahcer-ui,consistency=cached`,
			workspaceFolder: "/workspaces/vscode-pahcer-ui",
		});
	});

	it("keeps a subfolder below the main checkout's place", () => {
		const result = plan({}, `${WORKTREE}/packages/a`);
		expect(written(result)["workspaceFolder"]).toBe(
			"/workspaces/vscode-pahcer-ui/packages/a",
		);
	});

	it("resolves the folder variables as the main checkout's", () => {
		const result = plan({
			workspaceMount:
				"source=${localWorkspaceFolder},target=/src/${localWorkspaceFolderBasename},type=bind",
			workspaceFolder: "/src/${localWorkspaceFolderBasename}",
		});
		expect(result).toMatchObject({
			containerToplevel: "/src/vscode-pahcer-ui",
			mounts: [],
		});
		expect(written(result)).toEqual({
			workspaceMount: `source=${WORKTREE},target=/src/vscode-pahcer-ui,type=bind`,
			workspaceFolder: "/src/vscode-pahcer-ui",
		});
	});

	it("mounts the parent as for the main checkout, and the worktree over its place", () => {
		const result = plan({
			workspaceMount:
				"source=${localWorkspaceFolder}/..,target=/workspace,type=bind",
			workspaceFolder: "/workspace/${localWorkspaceFolderBasename}",
		});
		expect(result).toMatchObject({
			containerToplevel: "/workspace/vscode-pahcer-ui",
			mounts: [
				`type=bind,source=${WORKTREE},target=/workspace/vscode-pahcer-ui`,
			],
		});
		expect(written(result)).toEqual({
			workspaceMount: `source=${MAIN}/..,target=/workspace,type=bind`,
			workspaceFolder: "/workspace/vscode-pahcer-ui",
		});
		const mount = planWorktreeMount(
			RELATIVE,
			{ kind: "single", containerToplevel: "/workspace/vscode-pahcer-ui" },
			result,
		);
		expect(mount.kind === "overlay" && mount.containerDotGit).toBe(
			"/workspace/vscode-pahcer-ui/.git",
		);
		expect(configArguments(mount)).toEqual([
			"--override-config",
			`${RECORD}/${CONTAINER_OVERRIDE_FILE}`,
		]);
		expect(upArguments(mount).slice(0, 2)).toEqual([
			"--mount",
			`type=bind,source=${WORKTREE},target=/workspace/vscode-pahcer-ui`,
		]);
		expect(overrideFileCommand(mount)?.at(-2)).toBe(
			`${RECORD}/${CONTAINER_OVERRIDE_FILE}`,
		);
	});

	it("leaves a volume or an unrelated source alone, and says so", () => {
		expect(
			plan({ workspaceMount: "source=vol,target=/w,type=volume" }),
		).toHaveProperty("unsupported");
		expect(
			plan({ workspaceMount: "source=/elsewhere,target=/w,type=bind" }),
		).toHaveProperty("unsupported");
		const mount = planWorktreeMount(
			RELATIVE,
			{ kind: "single", containerToplevel: "/w" },
			{ unsupported: "why" },
		);
		expect(mount).toMatchObject({ kind: "overlay", note: "why" });
		expect(configArguments(mount)).toEqual([]);
	});

	it("reads JSON with comments and trailing commas", () => {
		expect(
			parseJsonc(
				'{\n // a comment\n "a": "http://x", /* b */ "b": [1, 2,],\n}\n',
			),
		).toEqual({ a: "http://x", b: [1, 2] });
		expect(parseJsonc('{"a": ",}"}')).toEqual({ a: ",}" });
		expect(parseJsonc("[1]")).toBeUndefined();
		expect(parseJsonc("{")).toBeUndefined();
	});
});
