import { describe, expect, it } from "vitest";
import { contains, expandPath, workspaceRootFor } from "./resolve.js";

describe("which workspace a path belongs to", () => {
	const roots = ["/work/alpha", "/work/beta", "/work/alpha/nested"];

	it("claims a file under a workspace root", () => {
		expect(workspaceRootFor("/work/alpha/src/main.ts", roots)).toBe(
			"/work/alpha",
		);
	});

	it("claims the root itself", () => {
		expect(workspaceRootFor("/work/beta", roots)).toBe("/work/beta");
	});

	it("gives a nested workspace the file inside it, not its parent", () => {
		expect(workspaceRootFor("/work/alpha/nested/deep/file.txt", roots)).toBe(
			"/work/alpha/nested",
		);
	});

	it("leaves a file outside every workspace to the Scratch editor", () => {
		expect(workspaceRootFor("/elsewhere/file.txt", roots)).toBeUndefined();
	});

	it("does not mistake a sibling whose name starts the same", () => {
		expect(workspaceRootFor("/work/alpha-two/file.txt", roots)).toBeUndefined();
		expect(contains("/work/alpha", "/work/alpha-two")).toBe(false);
	});

	it("has no workspace to offer when none are open", () => {
		expect(workspaceRootFor("/work/alpha/file.txt", [])).toBeUndefined();
	});
});

describe("expanding what was typed", () => {
	it("resolves a relative path against the caller's directory", () => {
		expect(expandPath("src/main.ts", "/work/alpha", "/home/dev")).toBe(
			"/work/alpha/src/main.ts",
		);
	});

	it("expands a leading tilde, and only a leading one", () => {
		expect(expandPath("~", "/work", "/home/dev")).toBe("/home/dev");
		expect(expandPath("~/notes.md", "/work", "/home/dev")).toBe(
			"/home/dev/notes.md",
		);
		expect(expandPath("./~weird", "/work", "/home/dev")).toBe("/work/./~weird");
	});

	it("leaves an absolute path alone", () => {
		expect(expandPath("/etc/hosts", "/work", "/home/dev")).toBe("/etc/hosts");
	});
});
