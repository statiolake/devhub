import { describe, expect, it } from "vitest";
import { parseWorkspacePickerEvent } from "./client";

describe("workspace picker event boundary", () => {
  it("accepts bounded safe candidate events", () => {
    const event = parseWorkspacePickerEvent({
      operationId: "picker-1",
      sequence: 3,
      kind: "candidate",
      label: "devhub",
      searchText: "devhub /tmp/devhub",
      path: "/tmp/devhub",
      score: 100,
    });
    expect(event.kind === "candidate" ? event.path : undefined).toBe(
      "/tmp/devhub",
    );
  });

  it("rejects unsafe sequence and unknown fields", () => {
    expect(() =>
      parseWorkspacePickerEvent({
        operationId: "picker-1",
        sequence: Number.MAX_SAFE_INTEGER + 1,
        kind: "started",
      }),
    ).toThrow();
    expect(() =>
      parseWorkspacePickerEvent({
        operationId: "picker-1",
        sequence: 1,
        kind: "started",
        secret: "nope",
      }),
    ).toThrow();
  });

  it("enforces each progress variant shape and bounded operation identity", () => {
    const base = { operationId: "picker-1", sequence: 1 };
    expect(parseWorkspacePickerEvent({ ...base, kind: "started" }).kind).toBe(
      "started",
    );
    expect(
      parseWorkspacePickerEvent({
        ...base,
        kind: "source-completed",
        sourceId: "local",
        candidateCount: 0,
        errorCount: 0,
        stderrBytes: 0,
      }).kind,
    ).toBe("source-completed");
    expect(
      parseWorkspacePickerEvent({
        ...base,
        kind: "cancelled",
      }).kind,
    ).toBe("cancelled");
    expect(
      parseWorkspacePickerEvent({
        ...base,
        kind: "completed",
        candidateCount: 0,
        errorCount: 0,
        stderrBytes: 0,
        cancelled: true,
        truncated: false,
      }).kind,
    ).toBe("completed");
    expect(() =>
      parseWorkspacePickerEvent({
        ...base,
        kind: "candidate",
        label: "x",
        searchText: "x",
        path: "/tmp/x",
        score: 1,
        sourceId: "irrelevant",
      }),
    ).toThrow();
    expect(() =>
      parseWorkspacePickerEvent({ ...base, kind: "started", operationId: "" }),
    ).toThrow();
    expect(() =>
      parseWorkspacePickerEvent({
        ...base,
        kind: "started",
        operationId: "x".repeat(129),
      }),
    ).toThrow();
    expect(
      parseWorkspacePickerEvent({
        ...base,
        kind: "cancelled",
        sourceId: null,
      }).kind,
    ).toBe("cancelled");
    expect(() =>
      parseWorkspacePickerEvent({
        ...base,
        kind: "cancelled",
        sourceId: 7,
      }),
    ).toThrow();
  });
});
