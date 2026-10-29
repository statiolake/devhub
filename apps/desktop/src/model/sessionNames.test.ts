import { describe, expect, it } from "vitest";
import {
  decodeSessionNames,
  rememberSessionName,
  sessionNameOf,
  SESSION_NAMES_LIMIT,
  type SessionNameRecord,
} from "./sessionNames.js";

const record = (
  session: string,
  name: string,
  kind: SessionNameRecord["kind"] = "claude",
): SessionNameRecord => ({ kind, session, name, at: 1 });

describe("the names sessions' Agents were given", () => {
  it("keeps the newest name of a session, newest first", () => {
    let names = rememberSessionName([], record("s1", "Docs"));
    names = rememberSessionName(names, record("s2", "Parser"));
    names = rememberSessionName(names, record("s1", "Docs, again"));
    expect(names.map((each) => [each.session, each.name])).toEqual([
      ["s1", "Docs, again"],
      ["s2", "Parser"],
    ]);
    expect(sessionNameOf(names, "claude", "s1")).toBe("Docs, again");
  });

  it("tells Claude's session from Codex's thread of the same id", () => {
    const names = rememberSessionName(
      [record("same", "Claude's")],
      record("same", "Codex's", "codex"),
    );
    expect(sessionNameOf(names, "claude", "same")).toBe("Claude's");
    expect(sessionNameOf(names, "codex", "same")).toBe("Codex's");
    expect(sessionNameOf(names, "codex", "other")).toBeUndefined();
  });

  it("answers the same list when nothing changes, so there is nothing to save", () => {
    const names = [record("s1", "Docs")];
    expect(rememberSessionName(names, record("s1", "Docs"))).toBe(names);
  });

  it("forgets the oldest beyond its bound", () => {
    let names: SessionNameRecord[] = [];
    for (let at = 0; at < SESSION_NAMES_LIMIT + 5; at += 1) {
      names = rememberSessionName(names, record(`s${String(at)}`, "n"));
    }
    expect(names).toHaveLength(SESSION_NAMES_LIMIT);
    expect(names[0]!.session).toBe(`s${String(SESSION_NAMES_LIMIT + 4)}`);
    expect(sessionNameOf(names, "claude", "s0")).toBeUndefined();
  });

  it("reads a state file leniently: absent is none, and an entry that does not read is left out", () => {
    expect(decodeSessionNames(undefined)).toEqual([]);
    expect(decodeSessionNames("nonsense")).toEqual([]);
    expect(
      decodeSessionNames([
        { kind: "claude", session: "s1", name: "Docs", at: 5 },
        { kind: "cursor", session: "s2", name: "x", at: 5 },
        { kind: "codex", session: "../etc", name: "x", at: 5 },
        { kind: "codex", session: "t1", name: " ", at: 5 },
        { kind: "codex", session: "t2", name: "Parser" },
        null,
      ]),
    ).toEqual([{ kind: "claude", session: "s1", name: "Docs", at: 5 }]);
  });
});
