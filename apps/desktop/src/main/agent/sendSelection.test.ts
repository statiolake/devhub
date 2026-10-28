import { describe, expect, it } from "vitest";
import {
	agentPath,
	fenced,
	fenceLanguage,
	parseSendSelection,
	reference,
	referenceStyle,
	selectionInsertion,
	type SendSelection,
} from "./sendSelection.js";

const ROOT = "/Users/me/src/app";

function selection(overrides: Partial<SendSelection> = {}): SendSelection {
	return {
		uri: `file://${ROOT}/src/a.ts`,
		path: `${ROOT}/src/a.ts`,
		languageId: "typescript",
		ranges: [
			{
				startLine: 12,
				endLine: 14,
				text: "const a = 1;\nconst b = 2;\nf(a, b);",
			},
		],
		...overrides,
	};
}

describe("which reference an Agent reads", () => {
	it("is the conversation's Markdown link for a GUI Agent, Claude's @ mention for its terminal, a plain path for any other", () => {
		expect(referenceStyle("gui", "claude")).toBe("markdown");
		expect(referenceStyle("gui", "codex")).toBe("markdown");
		expect(referenceStyle("tui", "claude")).toBe("claude");
		expect(referenceStyle("tui", "codex")).toBe("plain");
		expect(referenceStyle("tui", "cursor")).toBe("plain");
		expect(referenceStyle("tui", "custom")).toBe("plain");
	});

	it("names a range, or a single line, in each form", () => {
		const range = { startLine: 12, endLine: 20 };
		const line = { startLine: 7, endLine: 7 };
		expect(reference("src/a.ts", range, "markdown")).toBe(
			"[src/a.ts:12-20](src/a.ts#L12-L20)",
		);
		expect(reference("src/a.ts", line, "markdown")).toBe(
			"[src/a.ts:7](src/a.ts#L7)",
		);
		expect(reference("src/a.ts", range, "claude")).toBe("@src/a.ts#L12-20");
		expect(reference("src/a.ts", line, "claude")).toBe("@src/a.ts#L7");
		expect(reference("src/a.ts", range, "plain")).toBe("src/a.ts:12-20");
		expect(reference("src/a.ts", line, "plain")).toBe("src/a.ts:7");
	});

	it("keeps a path with a space whole: an angle-bracketed link target, a quoted mention", () => {
		const line = { startLine: 3, endLine: 3 };
		expect(reference("docs/my file.md", line, "markdown")).toBe(
			"[docs/my file.md:3](<docs/my file.md#L3>)",
		);
		expect(reference("docs/my file.md", line, "claude")).toBe(
			'@"docs/my file.md#L3"',
		);
		expect(reference("a[1].ts", line, "markdown")).toBe(
			"[a\\[1\\].ts:3](a[1].ts#L3)",
		);
	});
});

describe("the path", () => {
	it("is relative to the Agent's working directory inside it, absolute outside", () => {
		expect(agentPath(`${ROOT}/src/a.ts`, ROOT)).toBe("src/a.ts");
		expect(agentPath(`${ROOT}/src/a.ts`, `${ROOT}/`)).toBe("src/a.ts");
		expect(agentPath("/Users/me/src/other/b.ts", ROOT)).toBe(
			"/Users/me/src/other/b.ts",
		);
		// A sibling whose name starts the same is not inside.
		expect(agentPath(`${ROOT}-2/b.ts`, ROOT)).toBe(`${ROOT}-2/b.ts`);
	});
});

describe("the fence's language", () => {
	it("is VS Code's language id under the name a fence knows it by", () => {
		expect(fenceLanguage("typescript", "/a.ts")).toBe("typescript");
		expect(fenceLanguage("typescriptreact", "/a.tsx")).toBe("tsx");
		expect(fenceLanguage("javascriptreact", "/a.jsx")).toBe("jsx");
		expect(fenceLanguage("shellscript", "/a.sh")).toBe("sh");
		expect(fenceLanguage("python", "/a.py")).toBe("python");
		expect(fenceLanguage("rust", "/a.rs")).toBe("rust");
		expect(fenceLanguage("objective-c", "/a.m")).toBe("objc");
	});

	it("is none for plain text, and the file's extension when VS Code named none", () => {
		expect(fenceLanguage("plaintext", "/notes.txt")).toBe("");
		expect(fenceLanguage("", "/a.py")).toBe("python");
		expect(fenceLanguage("", "/Makefile")).toBe("");
		expect(fenceLanguage("", undefined)).toBe("");
		expect(fenceLanguage("not a language!", "/a.ts")).toBe("");
	});

	it("fences text with more backticks than any run in it", () => {
		expect(fenced("a\n", "ts")).toBe("```ts\na\n```");
		expect(fenced("a", "")).toBe("```\na\n```");
		expect(fenced("x ```js\ny\n```", "md")).toBe(
			"````md\nx ```js\ny\n```\n````",
		);
	});
});

describe("what goes in the input box", () => {
	it("is the reference, then the text fenced in its language, ending on a new line", () => {
		expect(
			selectionInsertion(selection(), { style: "markdown", root: ROOT }),
		).toBe(
			"[src/a.ts:12-14](src/a.ts#L12-L14)\n```typescript\nconst a = 1;\nconst b = 2;\nf(a, b);\n```\n",
		);
		expect(
			selectionInsertion(selection(), { style: "claude", root: ROOT }),
		).toBe(
			"@src/a.ts#L12-14\n```typescript\nconst a = 1;\nconst b = 2;\nf(a, b);\n```\n",
		);
		expect(
			selectionInsertion(selection(), { style: "plain", root: ROOT }),
		).toBe(
			"src/a.ts:12-14\n```typescript\nconst a = 1;\nconst b = 2;\nf(a, b);\n```\n",
		);
	});

	it("is each range in turn, a blank line between them", () => {
		const two = selection({
			ranges: [
				{ startLine: 1, endLine: 1, text: "import a;" },
				{ startLine: 9, endLine: 10, text: "b();\nc();" },
			],
		});
		expect(selectionInsertion(two, { style: "claude", root: ROOT })).toBe(
			"@src/a.ts#L1\n```typescript\nimport a;\n```\n\n@src/a.ts#L9-10\n```typescript\nb();\nc();\n```\n",
		);
	});

	it("is the file and the cursor's line alone for an empty selection", () => {
		const cursor = selection({
			ranges: [{ startLine: 42, endLine: 42, text: "" }],
		});
		expect(selectionInsertion(cursor, { style: "markdown", root: ROOT })).toBe(
			"[src/a.ts:42](src/a.ts#L42)\n",
		);
		expect(selectionInsertion(cursor, { style: "claude", root: ROOT })).toBe(
			"@src/a.ts#L42\n",
		);
	});

	it("is the text alone for a document that is no file, and nothing when that has nothing selected", () => {
		const untitled = selection({ uri: "untitled:Untitled-1", path: undefined });
		expect(selectionInsertion(untitled, { style: "claude", root: ROOT })).toBe(
			"```typescript\nconst a = 1;\nconst b = 2;\nf(a, b);\n```\n",
		);
		expect(
			selectionInsertion(
				{ ...untitled, ranges: [{ startLine: 1, endLine: 1, text: "" }] },
				{ style: "claude", root: ROOT },
			),
		).toBeUndefined();
	});

	it("is an absolute path for a file outside the Agent's directory", () => {
		const outside = selection({ path: "/etc/hosts", languageId: "plaintext" });
		expect(selectionInsertion(outside, { style: "plain", root: ROOT })).toBe(
			"/etc/hosts:12-14\n```\nconst a = 1;\nconst b = 2;\nf(a, b);\n```\n",
		);
	});
});

describe("the workbench's payload", () => {
	const payload = {
		version: 1,
		uri: "file:///r/a.ts",
		path: "/r/a.ts",
		languageId: "typescript",
		ranges: [{ startLine: 1, endLine: 2, text: "a\nb" }],
	};

	it("is read as it is sent", () => {
		expect(parseSendSelection(payload)).toEqual({
			uri: "file:///r/a.ts",
			path: "/r/a.ts",
			languageId: "typescript",
			ranges: [{ startLine: 1, endLine: 2, text: "a\nb" }],
		});
		expect(parseSendSelection({ ...payload, path: undefined }).path).toBe(
			undefined,
		);
	});

	it("is refused when it is not one", () => {
		expect(() => parseSendSelection(null)).toThrow();
		expect(() => parseSendSelection({ ...payload, version: 2 })).toThrow(
			/version 2/u,
		);
		expect(() => parseSendSelection({ ...payload, path: "a.ts" })).toThrow();
		expect(() => parseSendSelection({ ...payload, ranges: [] })).toThrow();
		expect(() =>
			parseSendSelection({
				...payload,
				ranges: [{ startLine: 3, endLine: 2, text: "" }],
			}),
		).toThrow();
		expect(() =>
			parseSendSelection({
				...payload,
				ranges: [{ startLine: 0, endLine: 1, text: "" }],
			}),
		).toThrow();
	});
});
