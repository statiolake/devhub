/**
 * The metadata kept per CLI session once its Agent is stopped or closed:
 * the bounds, and what the file reads back.
 */

import { describe, expect, it } from "vitest";
import {
  boundedSessionMeta,
  decodeSessionMeta,
  encodeSessionMeta,
  rememberSessionMeta,
  SESSION_META_LIMIT,
  SESSION_META_MAX_AGE_MS,
  SessionMetaRefused,
  type SessionMetaRecord,
} from "./sessionMeta.js";

const DAY = 24 * 60 * 60 * 1000;

function record(
  session: string,
  at: number,
  meta: Record<string, string> = { parent: "orch" },
): SessionMetaRecord {
  return { kind: "claude", session, meta, at };
}

describe("session metadata", () => {
  it("keeps one entry per session, newest first, and none for no pairs", () => {
    let records = rememberSessionMeta([], record("s1", 1));
    records = rememberSessionMeta(records, record("s2", 2));
    records = rememberSessionMeta(records, record("s1", 3, { role: "x" }));
    expect(records.map((one) => [one.session, one.meta])).toEqual([
      ["s1", { role: "x" }],
      ["s2", { parent: "orch" }],
    ]);
    expect(rememberSessionMeta(records, record("s2", 9))).toBe(records);
    expect(rememberSessionMeta(records, record("s9", 9, {}))).toBe(records);
    expect(
      rememberSessionMeta(records, record("s1", 4, {})).map(
        (one) => one.session,
      ),
    ).toEqual(["s2"]);
    // The same id of the other CLI is another session.
    expect(
      rememberSessionMeta(records, { ...record("s1", 5), kind: "codex" }),
    ).toHaveLength(3);
  });

  it("is capped by count and by age", () => {
    const now = 1000 * DAY;
    const many = Array.from({ length: SESSION_META_LIMIT + 20 }, (_, index) =>
      record(`s${String(index)}`, now - index),
    );
    const kept = boundedSessionMeta(many, now);
    expect(kept).toHaveLength(SESSION_META_LIMIT);
    expect(kept.at(-1)?.session).toBe(`s${String(SESSION_META_LIMIT - 1)}`);
    const aged = boundedSessionMeta(
      [
        record("fresh", now - DAY),
        record("stale", now - SESSION_META_MAX_AGE_MS - 1),
      ],
      now,
    );
    expect(aged.map((one) => one.session)).toEqual(["fresh"]);
    // A new entry pushes out the oldest one past the limit.
    const full = boundedSessionMeta(many, now);
    const next = rememberSessionMeta(full, record("new", now + 1));
    expect(next).toHaveLength(SESSION_META_LIMIT);
    expect(next[0]?.session).toBe("new");
    expect(next.some((one) => one.session === full.at(-1)?.session)).toBe(
      false,
    );
  });

  it("reads back what it wrote, and leaves out an entry that does not read", () => {
    const records: SessionMetaRecord[] = [
      {
        kind: "codex",
        session: "thread-1",
        meta: { parent: "a", issue: "12" },
        name: "Reviewer",
        named: true,
        at: 20,
      },
      {
        kind: "claude",
        session: "c-1",
        meta: { k: "v" },
        name: "Claude 2",
        at: 10,
      },
    ];
    const text = encodeSessionMeta(records);
    expect(JSON.parse(text)).toMatchObject({ version: 1 });
    expect(decodeSessionMeta(JSON.parse(text), 30)).toEqual(records);
    const document = JSON.parse(text) as { sessions: unknown[] };
    document.sessions.push(
      { kind: "shell", session: "x", meta: { k: "v" }, at: 1 },
      { kind: "claude", session: "bad id", meta: { k: "v" }, at: 1 },
      { kind: "claude", session: "c-2", meta: { "1bad": "v" }, at: 1 },
      { kind: "claude", session: "c-3", meta: { k: "a\nb" }, at: 1 },
      { kind: "claude", session: "c-4", meta: {}, at: 1 },
      { kind: "claude", session: "c-5", meta: { k: 1 }, at: 1 },
      "nothing",
    );
    expect(decodeSessionMeta(document, 30)).toEqual(records);
    expect(() => decodeSessionMeta({ version: 2, sessions: [] }, 0)).toThrow(
      SessionMetaRefused,
    );
    expect(() => decodeSessionMeta([], 0)).toThrow(SessionMetaRefused);
  });
});
