import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUserDataDirectory } from "./userDataMigration.js";

let dataDirectory: string;

function write(path: string, contents: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, contents);
}

beforeEach(() => {
	dataDirectory = mkdtempSync(join(tmpdir(), "devhub-user-data-"));
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("migrateUserDataDirectory", () => {
	it("renames the legacy profile into place when the new path is absent", () => {
		write(join(dataDirectory, "user-data", "User", "settings.json"), '{"a":1}');
		write(join(dataDirectory, "user-data", "state.json"), "{}");

		migrateUserDataDirectory(join(dataDirectory, "editor"));

		expect(
			readFileSync(
				join(dataDirectory, "editor", "User", "settings.json"),
				"utf8",
			),
		).toBe('{"a":1}');
		expect(existsSync(join(dataDirectory, "editor", "state.json"))).toBe(true);
		expect(existsSync(join(dataDirectory, "user-data"))).toBe(false);
	});

	it("removes the web-era directory before taking its name", () => {
		write(join(dataDirectory, "editor", "server-data", "token"), "x");
		write(join(dataDirectory, "editor", "surface-registry.json"), "[]");
		write(join(dataDirectory, "user-data", "User", "settings.json"), "{}");

		migrateUserDataDirectory(join(dataDirectory, "editor"));

		expect(existsSync(join(dataDirectory, "editor", "server-data"))).toBe(
			false,
		);
		expect(
			existsSync(join(dataDirectory, "editor", "surface-registry.json")),
		).toBe(false);
		expect(existsSync(join(dataDirectory, "editor", "User"))).toBe(true);
	});

	it("replaces a web-era User directory rather than mistaking it for the profile", () => {
		write(join(dataDirectory, "editor", "User", "settings.json"), '{"web":1}');
		write(join(dataDirectory, "editor", "connection-token"), "t");
		write(
			join(dataDirectory, "user-data", "User", "settings.json"),
			'{"app":1}',
		);

		migrateUserDataDirectory(join(dataDirectory, "editor"));

		expect(
			readFileSync(
				join(dataDirectory, "editor", "User", "settings.json"),
				"utf8",
			),
		).toBe('{"app":1}');
		expect(existsSync(join(dataDirectory, "editor", "connection-token"))).toBe(
			false,
		);
		expect(existsSync(join(dataDirectory, "user-data"))).toBe(false);
	});

	it("does nothing when there is no legacy profile", () => {
		migrateUserDataDirectory(join(dataDirectory, "editor"));

		expect(existsSync(join(dataDirectory, "editor"))).toBe(false);
	});

	it("does nothing when the user-data directory is itself the target", () => {
		write(join(dataDirectory, "user-data", "User", "settings.json"), "{}");

		migrateUserDataDirectory(join(dataDirectory, "user-data"));

		expect(existsSync(join(dataDirectory, "user-data", "User"))).toBe(true);
	});
});
