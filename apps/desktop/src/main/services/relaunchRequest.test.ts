import { describe, expect, it } from "vitest";
import type { NativeParsedArgs } from "code-oss-dev/out/vs/platform/environment/common/argv.js";
import { readRelaunchRequest } from "./relaunchRequest.js";

const args = (extra: Partial<NativeParsedArgs> = {}): NativeParsedArgs =>
	({ _: [], ...extra }) as NativeParsedArgs;

describe("what a workbench means when it asks to relaunch", () => {
	it("takes a plain restart as a question for the person, not a reload", () => {
		// `hostService.restart()`: a display-language change, a setting that
		// needs a new process. No reload can deliver it, so the answer is the
		// one that costs every other workspace — and DevHub asks first.
		expect(readRelaunchRequest(undefined, args())).toEqual({
			kind: "restart-devhub",
		});
		expect(readRelaunchRequest({}, args())).toEqual({ kind: "restart-devhub" });
		expect(
			readRelaunchRequest({ addArgs: [], removeArgs: [] }, args()),
		).toEqual({ kind: "restart-devhub" });
	});

	it("takes an argument change as a reload of the workbench world", () => {
		const request = readRelaunchRequest(
			{ addArgs: ["--inspect-extensions=9229"] },
			args(),
		);
		expect(request.kind).toBe("reload-workbenches");
		if (request.kind !== "reload-workbenches") return;
		expect(request.cli["inspect-extensions"]).toBe("9229");
	});

	it("keeps the command line DevHub was started with", () => {
		const request = readRelaunchRequest(
			{ addArgs: ["--trace"] },
			args({
				"extensions-dir": "/somewhere/extensions",
			}),
		);
		if (request.kind !== "reload-workbenches") throw new Error("wrong kind");
		expect(request.cli["extensions-dir"]).toBe("/somewhere/extensions");
		expect(request.cli.trace).toBe(true);
	});

	it("removes a flag the caller had added", () => {
		const request = readRelaunchRequest(
			{ removeArgs: ["--prof-startup"] },
			args({ "prof-startup": true }),
		);
		if (request.kind !== "reload-workbenches") throw new Error("wrong kind");
		expect(request.cli["prof-startup"]).toBeUndefined();
	});

	it("removes a bare path, which is how the startup profiler asks", () => {
		const request = readRelaunchRequest(
			{ removeArgs: ["/profiles/startup.cpuprofile"] },
			args({ _: ["/work/repo", "/profiles/startup.cpuprofile"] }),
		);
		if (request.kind !== "reload-workbenches") throw new Error("wrong kind");
		expect(request.cli._).toEqual(["/work/repo"]);
	});

	it("leaves what to open out of it, however the caller wrote the request", () => {
		const request = readRelaunchRequest(
			{ addArgs: ["--trace", "/some/folder"] },
			args({ _: ["/work/repo"] }),
		);
		if (request.kind !== "reload-workbenches") throw new Error("wrong kind");
		expect(request.cli._).toEqual(["/work/repo"]);
	});

	it("does not touch the arguments DevHub itself was given", () => {
		const original = args({ _: ["/work/repo"], "prof-startup": true });
		readRelaunchRequest(
			{ removeArgs: ["--prof-startup", "/work/repo"] },
			original,
		);
		expect(original["prof-startup"]).toBe(true);
		expect(original._).toEqual(["/work/repo"]);
	});

	it("refuses a request it has not read, instead of guessing", () => {
		// A VS Code bump that grows `IRelaunchOptions` a third field lands
		// here. Both answers would be wrong for something, and one failure
		// naming the field is cheaper than either.
		expect(() =>
			readRelaunchRequest({ preserveWindows: true } as never, args()),
		).toThrow(/preserveWindows/u);
	});
});
