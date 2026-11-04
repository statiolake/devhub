import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureOrchestratorRoot, expandOrchestratorRoot } from "./root.js";

const home = () => mkdtempSync(join(tmpdir(), "devhub-orchestrator-root-"));

describe("the orchestrator's folder", () => {
	it("expands ~ against the home folder", () => {
		expect(expandOrchestratorRoot("~/orchestrator", "/Users/me")).toBe(
			"/Users/me/orchestrator",
		);
		expect(expandOrchestratorRoot("~", "/Users/me")).toBe("/Users/me");
		expect(expandOrchestratorRoot("/srv/o", "/Users/me")).toBe("/srv/o");
	});

	it("is made by the window's Start when it is missing", () => {
		const me = home();
		const path = ensureOrchestratorRoot("~/orchestrator", {
			create: true,
			home: me,
		});
		expect(path).toBe(join(me, "orchestrator"));
		expect(statSync(path).isDirectory()).toBe(true);
		// Its parents too.
		const deep = ensureOrchestratorRoot("~/workspace/work/ai", {
			create: true,
			home: me,
		});
		expect(statSync(deep).isDirectory()).toBe(true);
	});

	it("is never made for a command line, and a file is not a folder", () => {
		const me = home();
		expect(() =>
			ensureOrchestratorRoot("~/missing", { create: false, home: me }),
		).toThrow(/is not a folder on this Mac/u);
		writeFileSync(join(me, "file"), "x");
		expect(() =>
			ensureOrchestratorRoot("~/file", { create: true, home: me }),
		).toThrow(/is not a folder/u);
	});
});
