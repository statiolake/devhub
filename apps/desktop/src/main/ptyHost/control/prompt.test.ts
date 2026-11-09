import { describe, expect, it } from "vitest";
import { PromptSession, promptOf, type PromptEnvironment } from "./prompt.js";

const ENV: PromptEnvironment = {
	vi: false,
	separators: "!\"#$%&'()*+,-./:;<=>?@[\\]^`{|}~",
	history: ["split-window", "new-window"],
	paste: "pasted\nsecond line",
	commands: ["rename-window", "renamew", "resize-pane", "new-window"],
	options: ["status-keys"],
	sessions: [
		{
			name: "devhub",
			id: 0,
			windows: [
				{ index: 0, name: "nvim" },
				{ index: 1, name: "api" },
				{ index: 12, name: "web" },
			],
		},
		{ name: "dotfiles", id: 3, windows: [{ index: 0, name: "zsh" }] },
	],
	session: "devhub",
};

function session(binding: string, env: Partial<PromptEnvironment> = {}) {
	const args = promptOf(binding);
	if (args === undefined) throw new Error(`not a prompt: ${binding}`);
	return new PromptSession(
		args,
		args.prompts.map((p) => ({
			prompt: p.prompt,
			input: p.input.replace("#W", "server"),
		})),
		{ ...ENV, ...env },
	);
}

function type(s: PromptSession, ...keys: string[]) {
	return keys.map((k) => s.key(k)).at(-1);
}

describe("a command-prompt binding", () => {
	it("is read as tmux reads it, prompts and inputs split on commas", () => {
		const rename = promptOf('command-prompt -I "#W" { rename-window -- "%%" }');
		expect(rename).toMatchObject({
			replay: 'command-prompt -b -I "#W" { rename-window -- "%%" }',
			prompts: [{ prompt: '(rename-window -- "%%") ', input: "#W" }],
			type: "command",
			mode: "line",
			bare: false,
		});
		expect(promptOf("command-prompt")).toMatchObject({
			prompts: [{ prompt: ":", input: "" }],
			bare: true,
		});
		expect(
			promptOf('command-prompt -p "a,b" -I "1,2" "x %1 %2"')?.prompts,
		).toEqual([
			{ prompt: "a ", input: "1" },
			{ prompt: "b ", input: "2" },
		]);
		expect(promptOf('command-prompt -l -p "a,b" "x"')?.prompts).toEqual([
			{ prompt: "a,b ", input: "" },
		]);
		expect(promptOf("command-prompt -1 -p x 'y %%'")?.mode).toBe("single");
		expect(
			promptOf('command-prompt -k -p key { list-keys -1N "%%" }')?.mode,
		).toBe("key");
		expect(
			promptOf(
				'command-prompt -T window-target -p index { select-window -t ":%%" }',
			)?.type,
		).toBe("window-target");
		// Not one prompt alone: tmux's to refuse, as before.
		expect(promptOf("command-prompt ; kill-pane")).toBeUndefined();
		expect(promptOf("command-prompt -t client-1")).toBeUndefined();
		expect(promptOf("command-prompt -T nonsense")).toBeUndefined();
	});

	it("reads confirm-before with tmux's prompt, key and -y", () => {
		expect(
			promptOf('confirm-before -p "kill this session? (y/n)" kill-session'),
		).toMatchObject({
			command: "confirm-before",
			replay: 'confirm-before -b -p "kill this session? (y/n)" kill-session',
			prompts: [{ prompt: "kill this session? (y/n) ", input: "" }],
			mode: "single",
		});
		expect(promptOf("confirm -c Y kill-pane")?.prompts[0].prompt).toBe(
			"Confirm 'kill-pane'? (Y/n) ",
		);
	});
});

describe("a prompt's keys, as tmux's status line takes them", () => {
	it("edits with the emacs table and types the answer into tmux's prompt", () => {
		const s = session('command-prompt -I "#W" { rename-window -- "%%" }');
		expect(s.view()).toMatchObject({ input: "server", cursor: 6 });
		type(s, "C-a", "M-f", "C-w");
		expect(s.view().input).toBe("");
		type(s, "a", ";", "Space", "#", "C-b", "C-t");
		// C-t before the end swaps the characters around the cursor, as tmux's.
		expect(s.view()).toMatchObject({ input: "a;# ", cursor: 4 });
		// C-y puts back what C-w took.
		type(s, "C-a", "C-k", "C-y");
		expect(s.view().input).toBe("server");
		type(s, "Space", "#", ";");
		expect(s.key("Enter")).toEqual({
			kind: "done",
			keys: [["C-u"], ["-l", "server #;"], ["Enter"]],
		});
	});

	it("walks tmux's history, newest first, and back to an empty line", () => {
		const s = session("command-prompt");
		type(s, "Up");
		expect(s.view().input).toBe("new-window");
		type(s, "Up", "Up");
		expect(s.view().input).toBe("split-window");
		type(s, "Down", "Down");
		expect(s.view().input).toBe("");
	});

	it("completes a command at the start, by the common prefix when several match", () => {
		const s = session("command-prompt");
		type(s, "r", "e", "Tab");
		expect(s.view().input).toBe("re");
		// Nothing longer in common: tmux's menu, which Escape closes.
		expect(s.view().completion?.items.map((i) => i.word)).toEqual([
			"rename-window",
			"renamew",
			"resize-pane",
		]);
		type(s, "Escape");
		expect(s.view().completion).toBeUndefined();
		type(s, "n", "Tab");
		expect(s.view().input).toBe("rename");
		type(s, "-", "Tab");
		expect(s.view().input).toBe("rename-window ");
	});

	it("opens tmux's menu on Tab, moved by Tab and BTab, chosen by Enter or its digit", () => {
		const s = session("command-prompt");
		type(s, "r", "e", "Tab");
		expect(s.view().completion).toMatchObject({ choice: 0, column: 0 });
		expect(s.view().completion?.items[0]).toEqual({
			word: "rename-window",
			kind: "command",
		});
		type(s, "Tab", "Tab");
		expect(s.view().completion?.choice).toBe(2);
		// A key the menu does not take does nothing while it is open.
		expect(s.key("x")).toEqual({ kind: "unchanged" });
		type(s, "BTab", "Enter");
		// Put in as tmux's menu does: the word, no space after it.
		expect(s.view()).toMatchObject({ input: "renamew", cursor: 7 });
		expect(s.view().completion).toBeUndefined();
		type(s, "C-u", "r", "e", "Tab", "2");
		expect(s.view().input).toBe("resize-pane");
		// Tab past the last item closes the menu and keeps the word.
		type(s, "C-u", "r", "e", "Tab", "Tab", "Tab", "Tab");
		expect(s.view()).toMatchObject({ input: "re" });
		expect(s.view().completion).toBeUndefined();
	});

	it("completes options and layouts past the first word", () => {
		const s = session("command-prompt");
		type(s, "s", "e", "t", " ", "s", "t", "Tab");
		expect(s.view().input).toBe("set status-keys ");
	});

	it("completes -t to a session, then shows the session's windows", () => {
		const s = session("command-prompt");
		type(s, ..."kill-window -td".split(""), "Tab");
		// devhub: and dotfiles: share no more than "d".
		expect(s.view().completion?.items).toEqual([
			{ word: "devhub:", kind: "session" },
			{ word: "dotfiles:", kind: "session" },
		]);
		expect(s.view().completion?.column).toBe(14);
		type(s, "Enter");
		expect(s.view().input).toBe("kill-window -tdevhub:");
		type(s, "1", "Tab");
		// 1 and 12 both start with 1.
		expect(s.view().completion?.items).toEqual([
			{ word: "devhub:1", kind: "window", extra: "api" },
			{ word: "devhub:12", kind: "window", extra: "web" },
		]);
		type(s, "Down", "Enter");
		expect(s.view().input).toBe("kill-window -tdevhub:12");
		const one = session("command-prompt");
		type(one, ..."select-window -tdo".split(""), "Tab");
		expect(one.view().input).toBe("select-window -tdotfiles:");
		type(one, "Tab");
		expect(one.view().input).toBe("select-window -tdotfiles:0");
	});

	it("shows the windows in a window-target prompt and puts the index in", () => {
		const s = session(
			"command-prompt -T window-target { select-window -t '%%' }",
		);
		type(s, "Tab");
		expect(s.view().completion?.items.map((i) => i.word)).toEqual([
			"0",
			"1",
			"12",
		]);
		type(s, "End", "Enter");
		expect(s.view().input).toBe("12");
	});

	it("takes the vi table when status-keys is vi", () => {
		const s = session('command-prompt -I "#W" { rename-window -- "%%" }', {
			vi: true,
		});
		type(s, "Escape");
		expect(s.view()).toMatchObject({ command: true, cursor: 5 });
		type(s, "0", "x", "x");
		expect(s.view().input).toBe("rver");
		type(s, "A", "!");
		expect(s.view()).toMatchObject({ input: "rver!", command: false });
		// C-b is no key of insert mode's: typed, and a control key types nothing.
		expect(s.key("C-b")).toEqual({ kind: "unchanged" });
		type(s, "Escape");
		expect(s.key("q")).toEqual({ kind: "cancel" });
	});

	it("asks each of several prompts, then types all the answers", () => {
		const s = session('command-prompt -p "first,second" "x %1 %2"');
		type(s, "a", "Enter");
		expect(s.view().prompt).toBe("second ");
		expect(type(s, "b", "Enter")).toEqual({
			kind: "done",
			keys: [["C-u"], ["-l", "a"], ["Enter"], ["C-u"], ["-l", "b"], ["Enter"]],
		});
	});

	it("passes a single key, a key name or digits on as tmux's prompt takes them", () => {
		const confirm = session('confirm-before -p "kill? (y/n)" kill-session');
		expect(confirm.key("Up")).toEqual({ kind: "unchanged" });
		expect(confirm.key("n")).toEqual({ kind: "done", keys: [["n"]] });
		expect(
			session("command-prompt -k -p key 'list-keys %%'").key("C-Left"),
		).toEqual({
			kind: "done",
			keys: [["C-Left"]],
		});
		const numeric = session("command-prompt -N -p n 'select-window -t %%'");
		type(numeric, "1", "2");
		expect(numeric.view().input).toBe("12");
		expect(numeric.key("Enter")).toEqual({
			kind: "done",
			keys: [["-l", "12"], ["Enter"]],
		});
	});

	it("closes on Backspace at an empty line with -e, and on Escape", () => {
		const s = session("command-prompt -e -p x 'y %%'");
		expect(s.key("BSpace")).toEqual({ kind: "cancel" });
		expect(session("command-prompt").key("Escape")).toEqual({ kind: "cancel" });
	});
});
