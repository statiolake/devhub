import { describe, expect, it } from "vitest";
import { orderWorkspaces } from "./workspaceOrder.js";

interface Row {
  readonly id: string;
  readonly label: string;
  readonly key: string;
  readonly main?: string;
}

const order = (rows: readonly Row[]) =>
  orderWorkspaces(rows, (row) => row.main).map((row) => row.label);

describe("the order workspaces appear in", () => {
  it("keeps a repository's worktrees with it, the repository first", () => {
    // Opened in an order nobody would choose to read them in.
    expect(
      order([
        { id: "1", label: "zebra", key: "/z", main: "/z" },
        {
          id: "2",
          label: "widget_b",
          key: "/w_b",
          main: "/w",
        },
        { id: "3", label: "widget", key: "/w", main: "/w" },
        { id: "4", label: "alpha", key: "/a", main: "/a" },
        {
          id: "5",
          label: "widget_a",
          key: "/w_a",
          main: "/w",
        },
      ]),
    ).toEqual(["alpha", "widget", "widget_a", "widget_b", "zebra"]);
  });

  it("groups worktrees whose repository is not open, under the first of them", () => {
    expect(
      order([
        { id: "1", label: "zebra", key: "/z", main: "/z" },
        { id: "2", label: "widget_b", key: "/w_b", main: "/w" },
        { id: "3", label: "widget_a", key: "/w_a", main: "/w" },
      ]),
    ).toEqual(["widget_a", "widget_b", "zebra"]);
  });

  it("leaves a workspace whose git could not be read standing alone", () => {
    // Two rows with nothing known about them must not merge into one group.
    expect(
      order([
        { id: "1", label: "beta", key: "/b" },
        { id: "2", label: "alpha", key: "/a" },
      ]),
    ).toEqual(["alpha", "beta"]);
  });

  it("sorts names the way a reader reads them, digits and all", () => {
    expect(
      order([
        { id: "1", label: "app-10", key: "/10" },
        { id: "2", label: "app-2", key: "/2" },
      ]),
    ).toEqual(["app-2", "app-10"]);
  });

  it("keeps two independent clones of one repository apart", () => {
    // Same name, different main worktree: two repositories, not one group.
    expect(
      order([
        { id: "1", label: "widget — b", key: "/b/widget", main: "/b/widget" },
        { id: "2", label: "widget — a", key: "/a/widget", main: "/a/widget" },
      ]),
    ).toEqual(["widget — a", "widget — b"]);
  });
});

describe("workspaces on other machines", () => {
  it("does not fold two machines' identical paths into one group", () => {
    // Grouping is an identity question, and `/srv/api` on two hosts is two
    // workspaces. Keyed on the path this was one group of two, with one row
    // arbitrarily made the head of the other.
    expect(
      order([
        { id: "1", label: "api — staging", key: "ssh://staging/srv/api" },
        { id: "2", label: "api — build", key: "ssh://build/srv/api" },
      ]),
    ).toEqual(["api — build", "api — staging"]);
  });

  it("leaves a local folder's grouping exactly where it was", () => {
    // A local workspace's key *is* its canonical path, so a key still matches
    // the main worktree git named.
    expect(
      order([
        { id: "1", label: "widget_a", key: "/w_a", main: "/w" },
        { id: "2", label: "widget", key: "/w", main: "/w" },
        { id: "3", label: "api", key: "ssh://build/srv/api" },
      ]),
    ).toEqual(["api", "widget", "widget_a"]);
  });
});
