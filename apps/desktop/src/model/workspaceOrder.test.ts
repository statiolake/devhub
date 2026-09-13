import { describe, expect, it } from "vitest";
import {
  moveAgent,
  moveWorkspace,
  orderWorkspaces,
  placeAgent,
  placeWorkspace,
  type EntryOrder,
  type MoveDirection,
} from "./workspaceOrder.js";

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

/**
 * A repository, two of its worktrees, and two unrelated folders.
 *
 * The automatic order of it is `alpha`, `widget`, `widget_a`, `widget_b`,
 * `zebra` — one group of three between two groups of one — which is enough
 * shape to say every one of the rules about with a single fixture.
 */
const TREE: readonly Row[] = [
  { id: "z", label: "zebra", key: "/z", main: "/z" },
  { id: "wb", label: "widget_b", key: "/w_b", main: "/w" },
  { id: "w", label: "widget", key: "/w", main: "/w" },
  { id: "a", label: "alpha", key: "/a", main: "/a" },
  { id: "wa", label: "widget_a", key: "/w_a", main: "/w" },
];

const arranged = (explicit: readonly string[], rows: readonly Row[] = TREE) =>
  orderWorkspaces(rows, (row) => row.main, explicit).map((row) => row.label);

/** The rows as they are drawn, which is what a move is computed against. */
const drawn = (explicit: readonly string[] = [], rows: readonly Row[] = TREE) =>
  orderWorkspaces(rows, (row) => row.main, explicit);

const moved = (
  id: string,
  direction: MoveDirection,
  explicit: readonly string[] = [],
  rows: readonly Row[] = TREE,
) => moveWorkspace(drawn(explicit, rows), (row) => row.main, id, direction);

const labelsOf = (order: EntryOrder | undefined, rows: readonly Row[] = TREE) =>
  order?.map((id) => rows.find((row) => row.id === id)?.label);

describe("the order a person put the rows in", () => {
  it("is the automatic order when nobody has arranged anything", () => {
    expect(arranged([])).toEqual([
      "alpha",
      "widget",
      "widget_a",
      "widget_b",
      "zebra",
    ]);
  });

  it("comes back exactly as it was written down", () => {
    // Every row named, which is what a state file written after any drag
    // holds: the whole list, not a patch.
    expect(arranged(["z", "w", "wa", "wb", "a"])).toEqual([
      "zebra",
      "widget",
      "widget_a",
      "widget_b",
      "alpha",
    ]);
  });

  it("keeps a repository's worktrees with it when the repository moves", () => {
    // The arrangement names only the two group heads, in the other order. The
    // worktrees are not mentioned and go where their repository went.
    expect(arranged(["w", "a"])).toEqual([
      "widget",
      "widget_a",
      "widget_b",
      "zebra",
      "alpha",
    ]);
  });

  it("cannot be made to take a worktree out of its group", () => {
    // A state file that puts `alpha` between a repository and its worktree —
    // which no gesture can produce, and which an edited file can. The grouping
    // is re-imposed rather than refused: there is no order this cannot read.
    expect(arranged(["w", "a", "wa", "wb", "z"])).toEqual([
      "widget",
      "widget_a",
      "widget_b",
      "alpha",
      "zebra",
    ]);
  });

  it("puts the repository at the head of its group whatever the file says", () => {
    expect(arranged(["wb", "wa", "w", "a", "z"])).toEqual([
      "widget",
      "widget_b",
      "widget_a",
      "alpha",
      "zebra",
    ]);
  });

  it("lands a newly opened worktree under its repository, not at the end", () => {
    // `widget` was dragged to the top and `widget_a` opened afterwards, so the
    // arrangement predates it and says nothing about it.
    expect(arranged(["w", "wb", "z", "a"])).toEqual([
      "widget",
      "widget_a",
      "widget_b",
      "zebra",
      "alpha",
    ]);
  });

  it("lands a newly opened folder where its name would have put it", () => {
    // `beta` is new and sorts between `alpha` and `widget` automatically, so
    // that is where it goes — after `alpha`, which is what precedes it there.
    const rows = [...TREE, { id: "b", label: "beta", key: "/b", main: "/b" }];
    expect(arranged(["z", "a", "w", "wa", "wb"], rows)).toEqual([
      "zebra",
      "alpha",
      "beta",
      "widget",
      "widget_a",
      "widget_b",
    ]);
  });

  it("ignores an id whose workspace is not open", () => {
    // The row was closed. Its place is kept for if it comes back, and it does
    // not leave a hole or displace anything in the meantime.
    expect(arranged(["z", "gone", "a", "w", "wa", "wb"])).toEqual([
      "zebra",
      "alpha",
      "widget",
      "widget_a",
      "widget_b",
    ]);
  });
});

describe("moving one row a step", () => {
  it("moves a repository past the next group, worktrees and all", () => {
    expect(labelsOf(moved("w", 1))).toEqual([
      "alpha",
      "zebra",
      "widget",
      "widget_a",
      "widget_b",
    ]);
  });

  it("moves a repository back past the group above it", () => {
    expect(labelsOf(moved("w", -1))).toEqual([
      "widget",
      "widget_a",
      "widget_b",
      "alpha",
      "zebra",
    ]);
  });

  it("moves a worktree within its own group", () => {
    expect(labelsOf(moved("wa", 1))).toEqual([
      "alpha",
      "widget",
      "widget_b",
      "widget_a",
      "zebra",
    ]);
    expect(labelsOf(moved("wb", -1))).toEqual([
      "alpha",
      "widget",
      "widget_b",
      "widget_a",
      "zebra",
    ]);
  });

  it("will not lift a worktree over its own repository", () => {
    expect(moved("wa", -1)).toBeUndefined();
  });

  it("will not push a worktree out of the bottom of its group", () => {
    expect(moved("wb", 1)).toBeUndefined();
  });

  it("is a no-op at either end of the list", () => {
    expect(moved("a", -1)).toBeUndefined();
    expect(moved("z", 1)).toBeUndefined();
  });

  it("is a no-op for a row that is not there", () => {
    expect(moved("nobody", 1)).toBeUndefined();
  });

  it("lets a worktree take the head slot when the repository is not open", () => {
    // Two worktrees and no repository: the first is the group only by being
    // first, so the second may take its place — and then it is what moves the
    // group. The move is reversible, which is the whole test.
    const rows: readonly Row[] = [
      { id: "wa", label: "widget_a", key: "/w_a", main: "/w" },
      { id: "wb", label: "widget_b", key: "/w_b", main: "/w" },
      { id: "z", label: "zebra", key: "/z", main: "/z" },
    ];
    const once = moved("wb", -1, [], rows);
    expect(labelsOf(once, rows)).toEqual(["widget_b", "widget_a", "zebra"]);
    expect(
      labelsOf(
        moveWorkspace(drawn(once ?? [], rows), (row) => row.main, "wa", -1),
        rows,
      ),
    ).toEqual(["widget_a", "widget_b", "zebra"]);
  });

  it("writes down the whole list, so the rest of it stops moving on its own", () => {
    // A move names every open row, which is what makes the arrangement stick:
    // renaming one row afterwards must not re-sort the list around it.
    const order = moved("z", -1);
    expect(order).toEqual(["a", "z", "w", "wa", "wb"]);
    const renamed = TREE.map((row) =>
      row.id === "z" ? { ...row, label: "aardvark" } : row,
    );
    expect(arranged(order ?? [], renamed)).toEqual([
      "alpha",
      "aardvark",
      "widget",
      "widget_a",
      "widget_b",
    ]);
  });
});

describe("dropping a row somewhere", () => {
  const dropped = (id: string, before: string | undefined) =>
    labelsOf(placeWorkspace(drawn(), (row) => row.main, id, before));

  it("puts a group in front of the group it was dropped on", () => {
    expect(dropped("z", "w")).toEqual([
      "alpha",
      "zebra",
      "widget",
      "widget_a",
      "widget_b",
    ]);
  });

  it("puts a group last when it was dropped past the end", () => {
    expect(dropped("a", undefined)).toEqual([
      "widget",
      "widget_a",
      "widget_b",
      "zebra",
      "alpha",
    ]);
  });

  it("refuses a group dropped on something that is not a group head", () => {
    // `widget_a` is a worktree. There is no gap in front of it that a whole
    // group could occupy without splitting the one it is in.
    expect(
      placeWorkspace(drawn(), (row) => row.main, "z", "wa"),
    ).toBeUndefined();
  });

  it("refuses a worktree dropped outside its own group", () => {
    expect(
      placeWorkspace(drawn(), (row) => row.main, "wa", "z"),
    ).toBeUndefined();
    expect(
      placeWorkspace(drawn(), (row) => row.main, "wa", "w"),
    ).toBeUndefined();
  });

  it("refuses a drop that would change nothing", () => {
    expect(
      placeWorkspace(drawn(), (row) => row.main, "z", undefined),
    ).toBeUndefined();
    expect(
      placeWorkspace(drawn(), (row) => row.main, "z", "z"),
    ).toBeUndefined();
  });
});

describe("the Agents of one workspace", () => {
  const agents = ["one", "two", "three"];

  it("step one place, and stop at the ends", () => {
    expect(moveAgent(agents, "one", 1)).toEqual(["two", "one", "three"]);
    expect(moveAgent(agents, "three", -1)).toEqual(["one", "three", "two"]);
    expect(moveAgent(agents, "one", -1)).toBeUndefined();
    expect(moveAgent(agents, "three", 1)).toBeUndefined();
    expect(moveAgent(agents, "nobody", 1)).toBeUndefined();
  });

  it("drop in front of another, or at the end", () => {
    expect(placeAgent(agents, "three", "one")).toEqual(["three", "one", "two"]);
    expect(placeAgent(agents, "one", undefined)).toEqual([
      "two",
      "three",
      "one",
    ]);
    expect(placeAgent(agents, "one", "two")).toBeUndefined();
    expect(placeAgent(agents, "one", "one")).toBeUndefined();
    expect(placeAgent(agents, "one", "nobody")).toBeUndefined();
  });
});
