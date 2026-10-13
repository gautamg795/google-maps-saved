import { LIMITS, type SourceList } from "google-maps-saved";

/** Returns the keys of the lists that are selected by default: all lists that are not followed. */
export function defaultSelectedKeys(lists: readonly SourceList[]): Set<string> {
  return new Set(
    lists.filter((list) => list.relationship !== "followed").map((list) => list.key),
  );
}

/**
 * Returns the selection for a new inventory. A list that was in `previous`
 * keeps its checked state. A new list gets the default state.
 */
export function carrySelection(
  previous: readonly SourceList[],
  checked: ReadonlySet<string>,
  next: readonly SourceList[],
): Set<string> {
  const known = new Set(previous.map((list) => list.key));
  const defaults = defaultSelectedKeys(next);
  return new Set(
    next
      .filter((list) => (known.has(list.key) ? checked.has(list.key) : defaults.has(list.key)))
      .map((list) => list.key),
  );
}

const number = (n: number) => n.toLocaleString("en-US");

/**
 * Returns a user-facing message when the selection cannot be exported, or
 * null when it is in the limits of `LIMITS`.
 */
export function selectionProblem(selected: readonly SourceList[]): string | null {
  if (selected.length === 0) {
    return "Select at least one list.";
  }
  if (selected.length > LIMITS.lists) {
    return `Select at most ${number(LIMITS.lists)} lists. You selected ${number(selected.length)}.`;
  }
  const entries = selected.reduce((sum, list) => sum + list.reportedCount, 0);
  if (entries > LIMITS.memberships) {
    return `The selected lists have ${number(entries)} entries. The limit is ${number(LIMITS.memberships)}. Select fewer lists.`;
  }
  return null;
}
