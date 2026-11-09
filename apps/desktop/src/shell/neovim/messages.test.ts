import { describe, expect, it } from "vitest";
import { routeMessages } from "./messages";
import type { MessageEvent, MsgShow } from "./redraw";

function show(
  kind: string,
  text: string,
  more: Partial<MsgShow> = {},
): MessageEvent {
  return {
    type: "show",
    msg: {
      kind,
      content: [{ attr: 0, text, hl: 0 }],
      replaceLast: false,
      history: true,
      append: false,
      id: "1",
      trigger: "",
      ...more,
    },
  };
}

const noHl = () => undefined;

describe("where Neovim's messages go", () => {
  it("puts an ordinary message in the corner, by level", () => {
    const routed = routeMessages(
      [
        show("echo", "hi"),
        show("emsg", "E492: Not an editor command: x"),
        show("wmsg", "search hit BOTTOM"),
      ],
      undefined,
      noHl,
    );
    expect(routed.pager).toBeUndefined();
    expect(routed.toasts.map((t) => [t.msg, t.level])).toEqual([
      ["hi", "info"],
      ["E492: Not an editor command: x", "error"],
      ["search hit BOTTOM", "warn"],
    ]);
  });

  it("knows an error by its highlight", () => {
    const routed = routeMessages(
      [show("echomsg", "careful")],
      undefined,
      () => ({
        groups: ["ErrorMsg"],
      }),
    );
    expect(routed.toasts[0]?.level).toBe("error");
  });

  it("collapses undo's reports and repeats into one line each", () => {
    const routed = routeMessages(
      [
        show("undo", "1 change; before #3"),
        show("undo", "1 change; before #2"),
        show("echo", "same"),
        show("echo", "same"),
      ],
      undefined,
      noHl,
    );
    expect(routed.toasts.map((t) => t.msg)).toEqual([
      "1 change; before #2",
      "same",
    ]);
    // Across batches the key is the same, so the corner replaces it.
    const next = routeMessages(
      [show("undo", "1 change; before #1")],
      undefined,
      noHl,
    );
    expect(next.toasts[0]?.key).toBe(routed.toasts[0]?.key);
  });

  it("opens a typed list in the pager, titled by its command", () => {
    const routed = routeMessages(
      [
        show("list_cmd", '  1 %a "a.txt"\n  2 #  "b.txt"', {
          trigger: "typed_cmd",
        }),
      ],
      ":ls",
      noHl,
    );
    expect(routed.toasts).toEqual([]);
    expect(routed.pager?.title).toBe(":ls");
    expect(
      routed.pager?.lines.map((l) => l.map((c) => c.text).join("")),
    ).toEqual(['  1 %a "a.txt"', '  2 #  "b.txt"']);
  });

  it("keeps a one-line answer in the corner", () => {
    const routed = routeMessages(
      [show("list_cmd", "  tabstop=8", { trigger: "typed_cmd" })],
      ":set ts?",
      noHl,
    );
    expect(routed.pager).toBeUndefined();
    expect(routed.toasts[0]?.msg).toBe("tabstop=8".padStart(11));
  });

  it("joins :!cmd's output and leaves its echo out", () => {
    const routed = routeMessages(
      [
        show("shell_cmd", ":!ls\r\n", { trigger: "typed_cmd" }),
        show("shell_out", "a\nb\n", { trigger: "typed_cmd", append: true }),
      ],
      ":!ls",
      noHl,
    );
    expect(
      routed.pager?.lines.map((l) => l.map((c) => c.text).join("")),
    ).toEqual(["a", "b"]);
    expect(routed.toasts).toEqual([]);
  });

  it("shows :messages in the pager", () => {
    const routed = routeMessages(
      [
        {
          type: "history",
          entries: [
            {
              kind: "echomsg",
              content: [{ attr: 0, text: "one\ntwo", hl: 4 }],
            },
          ],
        },
      ],
      ":messages",
      noHl,
    );
    expect(routed.pager).toMatchObject({
      source: "messages",
      title: "Messages",
    });
    expect(routed.pager?.lines).toHaveLength(2);
  });

  it("clips a long message that nobody typed for", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${String(i)}`).join(
      "\n",
    );
    const routed = routeMessages([show("lua_error", text)], undefined, noHl);
    expect(routed.pager).toBeUndefined();
    expect(routed.toasts[0]?.msg.split("\n")).toHaveLength(5);
    expect(routed.toasts[0]?.msg).toContain("6 more lines (:messages)");
  });
});
