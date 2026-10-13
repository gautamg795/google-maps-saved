import { encodeCsv } from "./csv.js";
import type { Membership, Snapshot, SourceList } from "./snapshot.js";
import { createStoredZip } from "./zip.js";

// LIMITS in snapshot.ts (100 lists, 5000 memberships, 64 KiB per row) must
// stay equal to the places-to-be import parser limits MAX_CSV_FILES,
// MAX_IMPORT_ROWS, and MAX_IMPORT_ROW_BYTES.

const TAKEOUT_HEADER = ["Title", "Note", "URL", "Comment"] as const;
const EXTENDED_HEADER = ["Latitude", "Longitude", "Address"] as const;
const UNSAFE_FILE_CHARACTERS = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;

/**
 * Return the Takeout-style Maps URL for one saved entry.
 * A feature entry gives `/maps/place/<name>/data=!4m2!3m1!1s<featureId>`.
 * Importers derive the CID from the second half of the `!1s` token.
 * A coordinate entry gives its `mapsUrl` unchanged.
 */
export function takeoutPlaceUrl(member: Membership): string {
  if (member.identityKind === "coordinate") {
    return member.mapsUrl;
  }
  if (member.featureId === null) {
    throw new Error("A feature entry has no feature ID.");
  }
  const name = member.name.trim();
  const segment =
    name === ""
      ? "Saved+place"
      : encodeURIComponent(name).replaceAll("%20", "+");
  return `https://www.google.com/maps/place/${segment}/data=!4m2!3m1!1s${member.featureId}`;
}

/**
 * Return a safe file base name (no extension) for a list title.
 * `used` holds the names already chosen, compared case-insensitively.
 * The function adds the chosen name to `used`. Use one `used` set per archive.
 */
export function takeoutFileName(title: string, used: Set<string>): string {
  const base =
    title
      .replace(UNSAFE_FILE_CHARACTERS, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/, "") || "Saved list";
  const taken = new Set([...used].map((name) => name.toLowerCase()));
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
    name = `${base} (${n})`;
  }
  used.add(name);
  return name;
}

/** Options for Takeout output. `extended` adds Latitude, Longitude, and Address columns. */
export type TakeoutOptions = { extended?: boolean; date?: Date };

/**
 * Return the Takeout CSV for one list.
 * `members` must belong to `list`. Rows are sorted by `position`; the input is
 * not changed. A list with no members gives a header-only CSV.
 */
export function takeoutCsv(
  list: SourceList,
  members: readonly Membership[],
  options?: TakeoutOptions,
): string {
  const extended = options?.extended === true;
  const header: string[] = [...TAKEOUT_HEADER];
  if (extended) {
    header.push(...EXTENDED_HEADER);
  }
  const rows: string[][] = [header];
  const sorted = [...members].sort((a, b) => a.position - b.position);
  for (const member of sorted) {
    if (member.listKey !== list.key) {
      throw new Error(`A member of list ${member.listKey} was given for list ${list.key}.`);
    }
    const row = [member.name, member.note, takeoutPlaceUrl(member), ""];
    if (extended) {
      row.push(
        member.latitude === null ? "" : String(member.latitude),
        member.longitude === null ? "" : String(member.longitude),
        member.address,
      );
    }
    rows.push(row);
  }
  return encodeCsv(rows);
}

/** One CSV file in a Takeout archive. `path` is relative to the archive root. */
export type TakeoutFile = { path: string; csv: string };

/**
 * Return one Takeout CSV per selected list, in `selectedListKeys` order, at
 * `Takeout/Saved/<name>.csv`. Throws if a selected key is not in `inventory`.
 */
export function takeoutFiles(
  snapshot: Snapshot,
  options?: TakeoutOptions,
): TakeoutFile[] {
  const byKey = new Map(snapshot.inventory.map((list) => [list.key, list]));
  const used = new Set<string>();
  return snapshot.selectedListKeys.map((key) => {
    const list = byKey.get(key);
    if (list === undefined) {
      throw new Error(`Selected list ${key} is not in the inventory.`);
    }
    const members = snapshot.memberships.filter((m) => m.listKey === key);
    return {
      path: `Takeout/Saved/${takeoutFileName(list.title, used)}.csv`,
      csv: takeoutCsv(list, members, options),
    };
  });
}

/**
 * Return a Google Takeout-compatible ZIP of the selected lists.
 * CSV text is UTF-8. `options.date` sets the entry timestamps (UTC).
 */
export function toTakeoutZip(
  snapshot: Snapshot,
  options?: TakeoutOptions,
): Uint8Array {
  const encoder = new TextEncoder();
  const entries = takeoutFiles(snapshot, options).map((file) => ({
    name: file.path,
    data: encoder.encode(file.csv),
  }));
  return createStoredZip(entries, { date: options?.date });
}
