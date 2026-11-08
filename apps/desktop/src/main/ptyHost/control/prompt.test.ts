import { describe, expect, it } from "vitest";
import { PromptSession, promptOf, type PromptEnvironment } from "./prompt.js";

const ENV: PromptEnvironment = {
	vi: false,
	separators: "!\"#$%&'()*+,-./:;<=>?@[\\]^`{|}~",
	history: ["split-window", "new-window"],
	paste: "pasted\nsecond line",
	commands: ["rename-window", "renamew", "resize-pane", "new-window"],
	options: ["status-keys"],
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
		type(s, "n", "Tab");
		expect(s.view().input).toBe("rename");
		type(s, "-", "Tab");
		expect(s.view().input).toBe("rename-window ");
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
