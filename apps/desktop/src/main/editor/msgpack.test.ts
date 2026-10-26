import { describe, expect, it } from "vitest";
import { decode, encode, MsgpackExt, MsgpackIncomplete } from "./msgpack.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("msgpack, as the specification lays it out", () => {
	it("encodes each type in its smallest form", () => {
		expect(hex(encode(null))).toBe("c0");
		expect(hex(encode(undefined))).toBe("c0");
		expect(hex(encode(true))).toBe("c3");
		expect(hex(encode(false))).toBe("c2");
		expect(hex(encode(0))).toBe("00");
		expect(hex(encode(127))).toBe("7f");
		expect(hex(encode(128))).toBe("cc80");
		expect(hex(encode(256))).toBe("cd0100");
		expect(hex(encode(65_536))).toBe("ce00010000");
		expect(hex(encode(2 ** 32))).toBe("cf0000000100000000");
		expect(hex(encode(-1))).toBe("ff");
		expect(hex(encode(-32))).toBe("e0");
		expect(hex(encode(-33))).toBe("d0df");
		expect(hex(encode(-129))).toBe("d1ff7f");
		expect(hex(encode(-40_000))).toBe("d2ffff63c0");
		expect(hex(encode(1.5))).toBe("cb3ff8000000000000");
		expect(hex(encode("a"))).toBe("a161");
		expect(hex(encode("x".repeat(32)))).toBe(`d920${"78".repeat(32)}`);
		expect(hex(encode([1, 2]))).toBe("920102");
		expect(hex(encode({ a: 1 }))).toBe("81a16101");
		expect(hex(encode(Uint8Array.from([1, 2])))).toBe("c4020102");
	});

	it("round-trips what Neovim's RPC carries", () => {
		const message = [
			0,
			42,
			"nvim_exec_lua",
			[
				"return ...",
				["/tmp/a file with ' and |.ts", 12, null, "日本語"],
				{ nested: [true, false, -7, 3.25] },
			],
		];
		const { value, length } = decode(encode(message));
		expect(value).toEqual(message);
		expect(length).toBe(encode(message).byteLength);
	});

	it("round-trips long strings, arrays and maps in their 16- and 32-bit forms", () => {
		const long = "y".repeat(70_000);
		const array = Array.from({ length: 20 }, (_, index) => index);
		const map = Object.fromEntries(
			Array.from({ length: 20 }, (_, index) => [`k${String(index)}`, index]),
		);
		expect(decode(encode(long)).value).toBe(long);
		expect(decode(encode(array)).value).toEqual(array);
		expect(decode(encode(map)).value).toEqual(map);
	});

	it("reads an ext value — how Neovim sends a Buffer handle — as itself", () => {
		// fixext1, type 0 (Buffer), payload 0x01.
		const { value } = decode(Uint8Array.from([0xd4, 0x00, 0x01]));
		expect(value).toBeInstanceOf(MsgpackExt);
		expect((value as MsgpackExt).type).toBe(0);
		expect([...(value as MsgpackExt).data]).toEqual([1]);
	});

	it("says a value is incomplete rather than misreading it", () => {
		const whole = encode(["abc", 1234]);
		for (let cut = 0; cut < whole.byteLength; cut += 1) {
			expect(() => decode(whole.subarray(0, cut))).toThrow(MsgpackIncomplete);
		}
	});

	it("refuses integers past 2^53 rather than rounding them", () => {
		expect(() => encode(2 ** 60)).toThrow(RangeError);
		expect(() =>
			decode(
				Uint8Array.from([0xcf, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
			),
		).toThrow(RangeError);
	});
});
