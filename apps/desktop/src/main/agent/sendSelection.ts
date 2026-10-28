/**
 * What "Send to Agent…" puts in an Agent's input box: a reference to the file
 * and lines, in the form that Agent reads, and the selected text.
 *
 * The workbench half (`patches/vscode-overlay/…/devhubSendToAgent/`) sends
 * the file, its language and each selected range (`vscode:devhubSendToAgent`,
 * read here by `parseSendSelection`); `main/shell/sendToAgent.ts` picks the
 * Agent and puts this text in it. Nothing is sent to the Agent's CLI: the
 * person reads it, adds their question and sends it themselves.
 *
 * **The reference is in the form each reader resolves.**
 *
 * - A GUI Agent's conversation draws the person's words and links a Markdown
 *   link to a local path to the file (`pathOfHref` in
 *   `shell/conversation/textLinks.ts`, the form `linkInstructions.ts` asks
 *   the Agents for): `[src/a.ts:12-20](src/a.ts#L12-L20)`. Either CLI reads
 *   the path in it.
 * - Claude Code in a terminal attaches a file named by an `@` mention, and
 *   reads a line range after it as `#L12-20` — the form its own editor
 *   integrations insert (`@src/a.ts#L12-20`, `@src/a.ts#L12`); a path with a
 *   space is quoted whole, `@"my dir/a.ts#L3"`.
 * - Codex's terminal (and every other CLI) takes a path as words: its `@`
 *   is a file search that inserts the path as plain text, so the path is
 *   written plainly, `src/a.ts:12-20`.
 *
 * The path is relative to the Agent's working directory (its Workspace's
 * root) when the file is inside it, absolute otherwise.
 *
 * After each reference comes the selected text as a fenced block in the
 * file's language. A bare cursor sends the reference to its line alone; a
 * document that is no file (an untitled editor) sends the text alone.
 */

import type {
	AgentPresentation,
	AgentProfileKind,
} from "../../model/domain.js";

/** One selected range: one-based, inclusive lines, and the text (empty for a bare cursor). */
export interface SelectedRange {
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
}

/** What a workbench sent: `SendToAgentPayload` in the overlay. */
export interface SendSelection {
	readonly uri: string;
	/** The file's path on its machine; none for a document that is no file. */
	readonly path: string | undefined;
	readonly languageId: string;
	readonly ranges: readonly SelectedRange[];
}

/** How many ranges one send may carry, and how much text: an editor's selections, not a dump. */
const MAX_RANGES = 64;
const MAX_TEXT = 1024 * 1024;

/** The workbench's payload, checked; a refusal names what was wrong with it. */
export function parseSendSelection(raw: unknown): SendSelection {
	const payload = raw as Partial<Record<string, unknown>> | null;
	if (typeof payload !== "object" || payload === null)
		throw new Error("the editor sent no selection");
	if (payload.version !== 1)
		throw new Error(
			`the editor's selection is in a shape this DevHub does not read (version ${JSON.stringify(payload.version)})`,
		);
	const { uri, path, languageId, ranges } = payload;
	if (typeof uri !== "string")
		throw new Error("the selection names no document");
	if (path !== undefined && (typeof path !== "string" || !path.startsWith("/")))
		throw new Error(`${JSON.stringify(path)} is not a file's path`);
	if (typeof languageId !== "string")
		throw new Error("the selection names no language");
	if (
		!Array.isArray(ranges) ||
		ranges.length === 0 ||
		ranges.length > MAX_RANGES
	)
		throw new Error("the selection has no ranges, or too many");
	let size = 0;
	const parsed = ranges.map((range: unknown): SelectedRange => {
		const { startLine, endLine, text } = (range ?? {}) as Partial<
			Record<string, unknown>
		>;
		if (
			!Number.isSafeInteger(startLine) ||
			!Number.isSafeInteger(endLine) ||
			(startLine as number) < 1 ||
			(endLine as number) < (startLine as number) ||
			typeof text !== "string"
		)
			throw new Error(`${JSON.stringify(range)} is not a selected range`);
		size += text.length;
		return {
			startLine: startLine as number,
			endLine: endLine as number,
			text,
		};
	});
	if (size > MAX_TEXT)
		throw new Error(
			"the selection is too large to put in an Agent's input box",
		);
	return { uri, path, languageId, ranges: parsed };
}

/** Which of the three reference forms an Agent reads. */
export type ReferenceStyle = "markdown" | "claude" | "plain";

export function referenceStyle(
	presentation: AgentPresentation,
	kind: AgentProfileKind,
): ReferenceStyle {
	if (presentation === "gui") return "markdown";
	return kind === "claude" ? "claude" : "plain";
}

/**
 * The path as the Agent should read it: relative to `root`, its working
 * directory, when the file is inside it; absolute otherwise.
 */
export function agentPath(path: string, root: string): string {
	const base = root.endsWith("/") ? root.slice(0, -1) : root;
	if (
		base !== "" &&
		path.startsWith(`${base}/`) &&
		path.length > base.length + 1
	)
		return path.slice(base.length + 1);
	return path;
}

/**
 * VS Code's language ids that are not the name a Markdown fence (and the
 * conversation's highlighter) knows the language by.
 */
const FENCE_ALIASES: Readonly<Record<string, string>> = {
	typescriptreact: "tsx",
	javascriptreact: "jsx",
	shellscript: "sh",
	"objective-c": "objc",
	"objective-cpp": "objcpp",
	restructuredtext: "rst",
	snippets: "json",
	jsonl: "json",
	"code-text-binary": "",
	plaintext: "",
	"git-commit": "",
	"git-rebase": "",
	ignore: "",
	log: "",
};

/** A file's extension as a fence language, for a document whose language VS Code did not say. */
const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
	ts: "ts",
	mts: "ts",
	cts: "ts",
	tsx: "tsx",
	js: "js",
	mjs: "js",
	cjs: "js",
	jsx: "jsx",
	py: "python",
	rs: "rust",
	go: "go",
	rb: "ruby",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	hpp: "cpp",
	cs: "csharp",
	sh: "sh",
	bash: "sh",
	zsh: "sh",
	json: "json",
	toml: "toml",
	yaml: "yaml",
	yml: "yaml",
	md: "markdown",
	html: "html",
	css: "css",
	scss: "scss",
	sql: "sql",
	lua: "lua",
	vim: "vim",
};

/** The fence's language: VS Code's id under the name a fence knows it by. */
export function fenceLanguage(
	languageId: string,
	path: string | undefined,
): string {
	if (languageId !== "") {
		const alias = FENCE_ALIASES[languageId];
		if (alias !== undefined) return alias;
		return /^[A-Za-z0-9_+#.-]+$/u.test(languageId) ? languageId : "";
	}
	const extension = /\.([A-Za-z0-9]+)$/u.exec(path ?? "")?.[1]?.toLowerCase();
	return extension === undefined ? "" : (EXTENSION_LANGUAGES[extension] ?? "");
}

/** `text` fenced, with a fence longer than any run of backticks in it. */
export function fenced(text: string, language: string): string {
	const longest = Math.max(
		0,
		...[...text.matchAll(/`+/gu)].map((run) => run[0].length),
	);
	const fence = "`".repeat(Math.max(3, longest + 1));
	const body = text.endsWith("\n") ? text : `${text}\n`;
	return `${fence}${language}\n${body}${fence}`;
}

/** The reference to one range of `path`, in `style`. */
export function reference(
	path: string,
	range: Pick<SelectedRange, "startLine" | "endLine">,
	style: ReferenceStyle,
): string {
	const single = range.startLine === range.endLine;
	const lines = single
		? `${range.startLine}`
		: `${range.startLine}-${range.endLine}`;
	switch (style) {
		case "markdown": {
			const anchor = single
				? `#L${range.startLine}`
				: `#L${range.startLine}-L${range.endLine}`;
			const target = /[\s()<>]/u.test(path)
				? `<${path}${anchor}>`
				: `${path}${anchor}`;
			return `[${escapeLinkText(path)}:${lines}](${target})`;
		}
		case "claude": {
			const mention = `${path}#L${lines}`;
			return /\s/u.test(path) ? `@"${mention}"` : `@${mention}`;
		}
		case "plain":
			return `${path}:${lines}`;
	}
}

function escapeLinkText(text: string): string {
	return text.replaceAll(/[[\]\\]/gu, (character) => `\\${character}`);
}

/**
 * The whole insertion for one send: each range's reference and text, in
 * document order, a blank line between them, ending on a new line for the
 * person's own words. Nothing when there is nothing to say (an empty
 * selection in a document that is no file).
 */
export function selectionInsertion(
	selection: SendSelection,
	target: { readonly style: ReferenceStyle; readonly root: string },
): string | undefined {
	const path =
		selection.path === undefined
			? undefined
			: agentPath(selection.path, target.root);
	const language = fenceLanguage(selection.languageId, selection.path);
	const blocks = selection.ranges.flatMap((range) => {
		const parts = [
			...(path === undefined ? [] : [reference(path, range, target.style)]),
			...(range.text.trim() === "" ? [] : [fenced(range.text, language)]),
		];
		return parts.length === 0 ? [] : [parts.join("\n")];
	});
	if (blocks.length === 0) return undefined;
	return `${blocks.join("\n\n")}\n`;
}
