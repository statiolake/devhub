import { describe, expect, it } from "vitest";
import {
  laneColorToken,
  parseProjectLanes,
  primaryLane,
  projectsTooltip,
  statusLetter,
} from "./projectStatus.js";

describe("statusLetter", () => {
  it("takes the first letter of the last word", () => {
    expect(statusLetter("Todo")).toBe("T");
    expect(statusLetter("In Progress")).toBe("P");
    expect(statusLetter("In Review")).toBe("R");
    expect(statusLetter("done")).toBe("D");
  });

  it("skips emoji and punctuation", () => {
    expect(statusLetter("🚧 In Progress")).toBe("P");
    expect(statusLetter("✅ Done!")).toBe("D");
    expect(statusLetter("(Blocked) - waiting...")).toBe("W");
    expect(statusLetter("🎉")).toBeUndefined();
  });

  it("takes the first character of a Japanese name", () => {
    expect(statusLetter("進行中")).toBe("進");
    expect(statusLetter("レビュー待ち")).toBe("レ");
    expect(statusLetter("対応中 レビュー")).toBe("レ");
  });

  it("has no letter for nothing", () => {
    expect(statusLetter(undefined)).toBeUndefined();
    expect(statusLetter("  ")).toBeUndefined();
  });
});

describe("parseProjectLanes", () => {
  it("reads boards, statuses and colours", () => {
    expect(
      parseProjectLanes({
        nodes: [
          {
            project: { title: "DevHub Roadmap" },
            fieldValueByName: { name: "In Review", color: "yellow" },
          },
          { project: { title: "Triage" }, fieldValueByName: {} },
          { project: null },
          null,
        ],
      }),
    ).toEqual([
      { project: "DevHub Roadmap", status: "In Review", color: "YELLOW" },
      { project: "Triage" },
    ]);
  });

  it("is empty for nothing", () => {
    expect(parseProjectLanes(undefined)).toEqual([]);
    expect(parseProjectLanes({ nodes: null })).toEqual([]);
  });
});

describe("primaryLane", () => {
  const lanes = [
    { project: "Triage" },
    { project: "Other", status: "Todo" },
    { project: "widget", status: "Done" },
  ];
  it("prefers the board named like the repository", () => {
    expect(primaryLane(lanes, "Widget")?.status).toBe("Done");
  });
  it("else the first with a status", () => {
    expect(primaryLane(lanes)?.project).toBe("Other");
    expect(primaryLane([{ project: "Triage" }])).toBeUndefined();
  });
});

describe("projectsTooltip", () => {
  it("lists every board with its lane", () => {
    expect(
      projectsTooltip([
        { project: "DevHub Roadmap", status: "In Review" },
        { project: "Triage" },
      ]),
    ).toBe("Projects: DevHub Roadmap — In Review; Triage");
  });
});

describe("laneColorToken", () => {
  it("maps known colours and leaves the rest muted", () => {
    expect(laneColorToken("GREEN")).toBe("--status-idle");
    expect(laneColorToken("GRAY")).toBeUndefined();
    expect(laneColorToken(undefined)).toBeUndefined();
  });
});
