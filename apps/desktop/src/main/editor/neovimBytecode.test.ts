import { describe, expect, it } from "vitest";
import { SetupLua, luaDigest, type CompiledLua } from "./neovimBytecode.js";

const LUA = "return 1";
const BYTES = Uint8Array.from([0x1b, 0x4c, 0x4a, 2, 8]);
const compiled = (nvimVersion = "0.12.6", lua = LUA): CompiledLua => ({
	nvimVersion,
	bytecode: { [luaDigest(lua)]: Buffer.from(BYTES).toString("base64") },
});

describe("SetupLua", () => {
	it("sends the bytecode compiled from exactly this source, for exactly that Neovim", () => {
		const setup = new SetupLua(() => compiled());
		expect(setup.code(LUA, "0.12.6")).toEqual(BYTES);
		// Another Neovim, another source (edited since the build): the source.
		expect(setup.code(LUA, "0.12.7")).toBe(LUA);
		expect(setup.code("return 2", "0.12.6")).toBe("return 2");
	});

	it("sends the source with no compiled file", () => {
		let loads = 0;
		const setup = new SetupLua(() => {
			loads += 1;
			return undefined;
		});
		expect(setup.code(LUA, "0.12.6")).toBe(LUA);
		expect(setup.code(LUA, "0.12.6")).toBe(LUA);
		// Looked for once.
		expect(loads).toBe(1);
	});

	it("sends a Neovim version that refused the bytecode the source from then on", () => {
		const setup = new SetupLua(() => compiled());
		setup.bytecodeRefused("0.12.6");
		expect(setup.code(LUA, "0.12.6")).toBe(LUA);
	});
});
