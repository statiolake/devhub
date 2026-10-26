import { describe, expect, it } from "vitest";
import {
  NOTICE_CENTER_LIMIT,
  noticeRemoved,
  noticesEnded,
  noticeShown,
  noticesRead,
  unreadCount,
  type NoticeCenter,
} from "./noticeCenter.js";

interface Said {
  readonly identity: string;
  readonly words: string;
}

const said = (identity: string, words = identity): Said => ({
  identity,
  words,
});

describe("the notice center", () => {
  it("keeps what reached the screen newest first, unread and current", () => {
    let center: NoticeCenter<Said> = [];
    center = noticeShown(center, said("a"), 1, 0);
    center = noticeShown(center, said("b"), 2, 1);
    expect(center.map((entry) => entry.notice.identity)).toEqual(["b", "a"]);
    expect(center.every((entry) => !entry.read && entry.current)).toBe(true);
    expect(unreadCount(center)).toBe(2);
  });

  it("is one entry for a notice whose words moved while it stood", () => {
    let center = noticeShown([], said("a", "one"), 1, 0);
    center = noticeShown(center, said("a", "two"), 5, 1);
    expect(center).toHaveLength(1);
    expect(center[0]).toMatchObject({
      key: 0,
      at: 1,
      notice: { words: "two" },
    });
  });

  it("is a new entry once the last one of that notice is over", () => {
    let center = noticeShown([], said("a"), 1, 0);
    center = noticesEnded(center, (notice) => notice.identity === "a");
    expect(center[0]?.current).toBe(false);
    center = noticeShown(center, said("a"), 2, 1);
    expect(center.map((entry) => entry.key)).toEqual([1, 0]);
  });

  it("keeps the last hundred", () => {
    let center: NoticeCenter<Said> = [];
    for (let i = 0; i < NOTICE_CENTER_LIMIT + 5; i += 1) {
      center = noticeShown(center, said(String(i)), i, i);
    }
    expect(center).toHaveLength(NOTICE_CENTER_LIMIT);
    expect(center[0]?.notice.identity).toBe("104");
    expect(center[center.length - 1]?.notice.identity).toBe("5");
  });

  it("reads one notice, or everything", () => {
    let center = noticeShown([], said("a"), 1, 0);
    center = noticeShown(center, said("b"), 2, 1);
    center = noticesRead(center, "a");
    expect(unreadCount(center)).toBe(1);
    center = noticesRead(center);
    expect(unreadCount(center)).toBe(0);
    // Nothing to change is the same list, so a render does not loop on it.
    expect(noticesRead(center)).toBe(center);
  });

  it("removes one entry by its key", () => {
    let center = noticeShown([], said("a"), 1, 0);
    center = noticeShown(center, said("b"), 2, 1);
    expect(noticeRemoved(center, 0).map((entry) => entry.key)).toEqual([1]);
  });
});
