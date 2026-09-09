import { describe, expect, it } from "vitest";
import { orderWorkspaces } from "./workspaceOrder.js";

interface Row {
  readonly id: string;
  readonly label: string;
  readonly root: string;
  readonly main?: string;
}

const order = (rows: readonly Row[]) =>
  orderWorkspaces(rows, (row) => row.main).map((row) => row.label);

describe("the order workspaces appear in", () => {
  it("keeps a repository's worktrees with it, the repository first", () => {
    // Opened in an order nobody would choose to read them in.
    expect(
      order([
        { id: "1", label: "zebra", root: "/z", main: "/z" },
        {
          id: "2",
          label: "widget_b",
          root: "/w_b",
          main: "/w",
        },
        { id: "3", label: "widget", root: "/w", main: "/w" },
        { id: "4", label: "alpha", root: "/a", main: "/a" },
        {
          id: "5",
          label: "widget_a",
          root: "/w_a",
          main: "/w",
        },
      ]),
    ).toEqual(["alpha", "widget", "widget_a", "widget_b", "zebra"]);
  });

  it("groups worktrees whose repository is not open, under the first of them", () => {
    expect(
      order([
        { id: "1", label: "zebra", root: "/z", main: "/z" },
        { id: "2", label: "widget_b", root: "/w_b", main: "/w" },
        { id: "3", label: "widget_a", root: "/w_a", main: "/w" },
      ]),
    ).toEqual(["widget_a", "widget_b", "zebra"]);
  });

  it("leaves a workspace whose git could not be read standing alone", () => {
    // Two rows with nothing known about them must not merge into one group.
    expect(
      order([
        { id: "1", label: "beta", root: "/b" },
        { id: "2", label: "alpha", root: "/a" },
      ]),
    ).toEqual(["alpha", "beta"]);
  });

  it("sorts names the way a reader reads them, digits and all", () => {
    expect(
      order([
        { id: "1", label: "app-10", root: "/10" },
        { id: "2", label: "app-2", root: "/2" },
      ]),
    ).toEqual(["app-2", "app-10"]);
  });

  it("keeps two independent clones of one repository apart", () => {
    // Same name, different main worktree: two repositories, not one group.
    expect(
      order([
        { id: "1", label: "widget — b", root: "/b/widget", main: "/b/widget" },
        { id: "2", label: "widget — a", root: "/a/widget", main: "/a/widget" },
      ]),
    ).toEqual(["widget — a", "widget — b"]);
  });
});
