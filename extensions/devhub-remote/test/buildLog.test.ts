import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
  LogFollower,
  showLog,
  type LogFiles,
  type LogOutput,
} from "../src/buildLog";

/** A file system with one file that can be replaced and grown. */
function files() {
  let file: { ino: number; bytes: Uint8Array } | undefined;
  let next = 1;
  const fs: LogFiles = {
    stat: () =>
      Promise.resolve(
        file === undefined
          ? undefined
          : { ino: file.ino, size: file.bytes.byteLength },
      ),
    read: (_path, from, to) =>
      Promise.resolve((file?.bytes ?? new Uint8Array()).slice(from, to)),
  };
  return {
    fs,
    /** A new file, as a bring-up begins one. */
    replace: (text: string | Uint8Array) => {
      file = {
        ino: next++,
        bytes: typeof text === "string" ? Buffer.from(text, "utf8") : text,
      };
    },
    grow: (text: string | Uint8Array) => {
      if (file === undefined) throw new Error("no file to grow");
      const more = typeof text === "string" ? Buffer.from(text, "utf8") : text;
      file = { ino: file.ino, bytes: Buffer.concat([file.bytes, more]) };
    },
  };
}

function output() {
  const events: string[] = [];
  let text = "";
  const out: LogOutput = {
    clear: () => {
      events.push("clear");
      text = "";
    },
    append: (more) => {
      text += more;
    },
    show: (preserveFocus) => {
      events.push(preserveFocus ? "show quietly" : "show");
    },
  };
  return { out, events, text: () => text };
}

test("the previous bring-up's log is not shown as this one's", async () => {
  const disk = files();
  disk.replace("yesterday's build\n");
  const shown = output();
  const follower = await LogFollower.start("/log", shown.out, disk.fs);
  disk.grow("more of yesterday\n");
  await follower.poll();
  // A container DevHub only had to adopt writes nothing: nothing is shown.
  deepStrictEqual(shown.events, []);
  strictEqual(shown.text(), "");
});

test("a new bring-up's log appears as it is written, in the output that shows it", async () => {
  const disk = files();
  disk.replace("yesterday's build\n");
  const shown = output();
  const follower = await LogFollower.start("/log", shown.out, disk.fs);
  disk.replace("$ devcontainer up\n");
  await follower.poll();
  disk.grow("[1/2] pulling\n");
  await follower.poll();
  disk.grow("[2/2] postCreateCommand\n");
  await follower.poll();
  deepStrictEqual(shown.events, ["clear", "show quietly"]);
  strictEqual(
    shown.text(),
    "$ devcontainer up\n[1/2] pulling\n[2/2] postCreateCommand\n",
  );
});

test("a character split across two looks is not broken", async () => {
  const disk = files();
  const shown = output();
  const follower = await LogFollower.start("/log", shown.out, disk.fs);
  const bytes = Buffer.from("ビルド\n", "utf8");
  disk.replace(bytes.subarray(0, 4));
  await follower.poll();
  disk.grow(bytes.subarray(4));
  await follower.poll();
  strictEqual(shown.text(), "ビルド\n");
});

test("Show Build Log shows the whole file, and says when there is none", async () => {
  const disk = files();
  const shown = output();
  strictEqual(await showLog("/log", shown.out, disk.fs), false);
  disk.replace("$ devcontainer up\nERROR: no such image\n");
  strictEqual(await showLog("/log", shown.out, disk.fs), true);
  strictEqual(shown.text(), "$ devcontainer up\nERROR: no such image\n");
  deepStrictEqual(shown.events, ["clear", "show"]);
});
