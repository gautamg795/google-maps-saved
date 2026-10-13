import { LIMITS, type Relationship, type SourceList } from "google-maps-saved";
import { describe, expect, it } from "vitest";
import { carrySelection, selectionProblem } from "../src/selection.js";

function list(id: string, relationship: Relationship, reportedCount = 1): SourceList {
  return {
    key: `1:${id}`,
    id,
    type: 1,
    ownerAccountId: "1",
    relationship,
    title: id,
    description: "",
    emoji: "",
    visibility: "private",
    reportedCount,
    modifiedMarker: null,
  };
}

describe("default selection", () => {
  it("keeps known choices and gives new lists the default", () => {
    const before = [list("a", "owned"), list("b", "owned")];
    const after = [...before, list("c", "followed"), list("d", "collaborative")];
    expect([...carrySelection(before, new Set(["1:b"]), after)]).toEqual(["1:b", "1:d"]);
  });
});

describe("selectionProblem", () => {
  it("requires at least one list", () => {
    expect(selectionProblem([])).toBe("Select at least one list.");
  });

  it("accepts a selection at the limits", () => {
    const lists = Array.from({ length: LIMITS.lists }, (_, i) =>
      list(`l${i}`, "owned", LIMITS.memberships / LIMITS.lists),
    );
    expect(selectionProblem(lists)).toBeNull();
  });

  it("rejects too many lists", () => {
    const lists = Array.from({ length: LIMITS.lists + 1 }, (_, i) => list(`l${i}`, "owned", 0));
    expect(selectionProblem(lists)).toBe("Select at most 100 lists. You selected 101.");
  });

  it("rejects too many entries", () => {
    expect(selectionProblem([list("a", "owned", 4000), list("b", "owned", 1001)])).toBe(
      "The selected lists have 5,001 entries. The limit is 5,000. Select fewer lists.",
    );
  });
});
