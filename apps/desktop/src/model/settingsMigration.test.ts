import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfigText } from "./config.js";
import {
  mergeSettings,
  migrateLocalSettings,
  migratedText,
  type MigrationIo,
} from "./settingsMigration.js";
import { makeScratchDir, removeScratchDir } from "./testScratch.js";

describe("mergeSettings", () => {
  it("keeps what only one side says", () => {
    expect(mergeSettings({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("gives the local side the last word", () => {
    expect(mergeSettings({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("merges tables key by key, all the way down", () => {
    expect(
      mergeSettings(
        { appearance: { size: 12, family: "SF Mono", nested: { a: 1, b: 2 } } },
        { appearance: { size: 20, nested: { b: 3 } } },
      ),
    ).toEqual({
      appearance: { size: 20, family: "SF Mono", nested: { a: 1, b: 3 } },
    });
  });

  it("replaces arrays whole rather than merging them", () => {
    expect(mergeSettings({ args: ["a", "b", "c"] }, { args: ["z"] })).toEqual({
      args: ["z"],
    });
    expect(
      mergeSettings({ agent_actions: [{ id: "a" }] }, { agent_actions: [] }),
    ).toEqual({ agent_actions: [] });
  });

  it("lets either side replace a table with a scalar and back", () => {
    expect(mergeSettings({ a: { b: 1 } }, { a: 2 })).toEqual({ a: 2 });
    expect(mergeSettings({ a: 2 }, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
  });

  it("shares no object with either side", () => {
    const shared = { appearance: { size: 12 } };
    const merged = mergeSettings(shared, {}) as {
      appearance: { size: number };
    };
    merged.appearance.size = 99;
    expect(shared.appearance.size).toBe(12);
  });
});

describe("migratedText", () => {
  it("keeps the comments and grouping of the file it writes over", () => {
    const text = migratedText(
      "# Do not reformat.\nversion = 1\n\n[appearance]\nterminal_font_size = 12\n",
      "[appearance]\nterminal_font_size = 20\n",
      parseConfigText,
    );
    expect(text).toContain("# Do not reformat.");
    expect(text).toContain("terminal_font_size = 20");
    expect(text).not.toContain("terminal_font_size = 12");
  });

  it("writes the local file's whole word when there is nothing to write over", () => {
    const text = migratedText(
      "",
      'version = 1\n[runtimes]\nshell = "/bin/bash"\n',
      parseConfigText,
    );
    expect(parseConfigText(text)).toEqual({
      version: 1,
      runtimes: { shell: "/bin/bash" },
    });
  });
});

describe("migrateLocalSettings", () => {
  let directory: string;
  let file: string;
  let local: string;
  let written: string[];
  let io: MigrationIo;

  beforeEach(() => {
    directory = makeScratchDir("settings-migration");
    file = join(directory, "settings.toml");
    local = join(directory, "settings.local.toml");
    written = [];
    io = {
      parse: parseConfigText,
      write: async (path, text) => {
        written.push(path);
        await writeFile(path, text);
      },
    };
  });

  afterEach(() => {
    removeScratchDir(directory);
  });

  it("does nothing when the local file is absent", async () => {
    await writeFile(file, "version = 1\n");
    expect(await migrateLocalSettings(file, local, io)).toEqual({
      kind: "nothing-to-migrate",
    });
    expect(written).toEqual([]);
    expect(await readFile(file, "utf8")).toBe("version = 1\n");
  });

  it("merges the local file in and renames it away", async () => {
    await writeFile(
      file,
      'version = 1\n[appearance]\nterminal_font_size = 12\nsidebar_density = "comfortable"\n',
    );
    await writeFile(local, "[appearance]\nterminal_font_size = 20\n");

    const outcome = await migrateLocalSettings(file, local, io);
    expect(outcome).toEqual({
      kind: "migrated",
      from: local,
      to: `${local}.migrated`,
    });
    expect(parseConfigText(await readFile(file, "utf8"))).toEqual({
      version: 1,
      appearance: { terminal_font_size: 20, sidebar_density: "comfortable" },
    });
    await expect(readFile(local, "utf8")).rejects.toThrow();
    expect(await readFile(`${local}.migrated`, "utf8")).toContain("20");
  });

  it("leaves the local file in place when the write fails", async () => {
    await writeFile(file, "version = 1\n");
    await writeFile(local, "[appearance]\nterminal_font_size = 20\n");
    const failing: MigrationIo = {
      parse: parseConfigText,
      write: () => Promise.reject(new Error("read-only")),
    };
    await expect(migrateLocalSettings(file, local, failing)).rejects.toThrow(
      "read-only",
    );
    // Still there, so the next start can try again rather than losing it.
    expect(await readFile(local, "utf8")).toContain("20");
  });

  it("does nothing a second time, because the file is now .migrated", async () => {
    await writeFile(file, "version = 1\n");
    await writeFile(local, "[appearance]\nterminal_font_size = 20\n");
    await migrateLocalSettings(file, local, io);
    written.length = 0;

    expect(await migrateLocalSettings(file, local, io)).toEqual({
      kind: "nothing-to-migrate",
    });
    expect(written).toEqual([]);
  });
});
