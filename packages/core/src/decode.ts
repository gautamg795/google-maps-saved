import {
  MapsError,
  accountId,
  coordinate,
  coordinateIdentity,
  count,
  feature,
  listKey,
  text,
  type Membership,
  type Relationship,
  type SourceList,
} from "./snapshot.js";

/**
 * Top-level positions of each list group in the Maps inventory (`/mas`)
 * response. These positions come from captured responses.
 */
export const GROUP_POSITIONS = {
  owned: 29,
  collaborative: 43,
  followed: 30,
} as const;

/**
 * Reads a nested positional value. Returns `undefined` when a step on the
 * path is not an array.
 */
export function at(value: unknown, ...path: number[]): unknown {
  for (const i of path) {
    if (!Array.isArray(value)) return undefined;
    value = value[i];
  }
  return value;
}

/**
 * Parses a Maps response body as JSON. Removes the `)]}'` XSSI prefix and the
 * `/*""*\/` suffix, and unwraps a `{ d: string }` envelope. Throws
 * `MapsError` "schema" when the result is not an array.
 */
export function decodeResponse(body: string): unknown {
  let source = body.trimStart();
  if (source.startsWith(")]}'")) source = source.slice(4).trimStart();
  if (source.trimEnd().endsWith('/*""*/'))
    source = source.trimEnd().slice(0, -6);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new MapsError(
      "schema",
      "Google returned a response this connector cannot decode.",
    );
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    "d" in parsed &&
    typeof parsed.d === "string"
  )
    return decodeResponse(parsed.d);
  if (!Array.isArray(parsed))
    throw new MapsError("schema", "Google returned an unsupported response.");
  return parsed;
}

function optionalText(value: unknown, label: string, bytes = 4096): string {
  return value === null || value === undefined ? "" : text(value, label, bytes);
}

function marker(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((n) => typeof n !== "number" || !Number.isSafeInteger(n))
  )
    throw new MapsError("schema", "Invalid Google revision marker.");
  return JSON.stringify(value);
}

/**
 * Decodes one inventory row into a `SourceList`. An owned default list
 * (type 2, 3, 5 or 6) with a null ID and a count of zero gets the ID
 * `unmaterialized-default-<accountId>`. Throws `MapsError` on an invalid row.
 */
export function decodeList(
  row: unknown,
  relationship: Relationship,
): SourceList {
  const type = count(at(row, 0, 1), "Google list type");
  const rawId = at(row, 0, 0);
  const id =
    rawId === null &&
    relationship === "owned" &&
    [2, 3, 5, 6].includes(type) &&
    at(row, 12) === 0
      ? `unmaterialized-default-${accountId(at(row, 3, 2))}`
      : text(rawId, "Google list ID", 256);
  // Sharing enum values from captures:
  // 1: anonymous reads failed on the private sample.
  // 2: matches the Maps UI "Shared" label. Anonymous reads succeeded.
  // 3: seen on a collaborative list. It does not show that the list is public.
  const sharing = at(row, 2, 0);
  const visibility =
    sharing === 1 ? "private" : sharing === 2 ? "shared" : "unknown";
  return {
    key: listKey(id, type),
    id,
    type,
    ownerAccountId: accountId(at(row, 3, 2)),
    relationship,
    title: text(at(row, 4), "Google list title"),
    description: optionalText(at(row, 5), "List description", 16384),
    emoji: optionalText(at(row, 17), "Emoji", 256),
    visibility,
    reportedCount: count(at(row, 12), "List count"),
    modifiedMarker: marker(at(row, 11)),
  };
}

/**
 * Decodes the Maps inventory (`/mas`) response. Reads the owned and
 * collaborative groups, and the followed group when `followed` is true.
 * The account ID comes from the owners of the owned lists, which must all be
 * the same account. Throws `MapsError` when a group is missing, when a group
 * has 500 or more rows (pagination is not supported), or when list keys repeat.
 */
export function decodeInventory(
  root: unknown,
  followed: boolean,
): {
  googleAccountId: string;
  inventory: SourceList[];
  requestedGroups: Relationship[];
} {
  const requestedGroups: Relationship[] = followed
    ? ["owned", "collaborative", "followed"]
    : ["owned", "collaborative"];
  const inventory: SourceList[] = [];
  for (const group of requestedGroups) {
    const container = at(root, GROUP_POSITIONS[group]);
    const rows =
      Array.isArray(container) && container.length === 0
        ? []
        : at(container, 3);
    if (!Array.isArray(rows))
      throw new MapsError(
        "account_unknown",
        "Google did not return a complete account inventory. Check your sign-in and retry.",
      );
    if (rows.length >= 500)
      throw new MapsError(
        "incomplete",
        "Inventory pagination beyond 500 lists is not supported.",
      );
    inventory.push(...rows.map((r) => decodeList(r, group)));
  }
  const owners = new Set(
    inventory
      .filter((l) => l.relationship === "owned")
      .map((l) => l.ownerAccountId),
  );
  if (owners.size !== 1)
    throw new MapsError(
      "account_unknown",
      "The selected Google account cannot be established from its owned lists.",
    );
  if (new Set(inventory.map((l) => l.key)).size !== inventory.length)
    throw new MapsError("schema", "Google returned duplicate collection keys.");
  return { googleAccountId: [...owners][0], inventory, requestedGroups };
}

/**
 * Decodes one saved entry of a list page into a `Membership`. `position` is
 * the zero-based index of the entry in its list. An entry with a feature ID
 * gets a feature identity. An entry with only coordinates gets a weaker
 * coordinate identity. Throws `MapsError` when the entry has neither.
 */
export async function decodeMember(
  raw: unknown,
  key: string,
  position: number,
): Promise<Membership> {
  const name = text(at(raw, 2), "Saved place name");
  const latitude = coordinate(at(raw, 1, 5, 2), "latitude");
  const longitude = coordinate(at(raw, 1, 5, 3), "longitude");
  const parts = at(raw, 1, 6);
  let identity: string;
  let identityKind: Membership["identityKind"];
  let featureParts: Membership["featureParts"] = null;
  let featureId: string | null = null;
  let cid: string | null = null;
  let mapsUrl: string;
  if (parts !== null && parts !== undefined) {
    const f = feature(parts);
    featureParts = f.featureParts;
    featureId = f.featureId;
    cid = f.cid;
    identity = featureId;
    identityKind = "feature";
    mapsUrl = `https://www.google.com/maps?cid=${cid}`;
  } else if (latitude !== null && longitude !== null) {
    identity = await coordinateIdentity(latitude, longitude, name);
    identityKind = "coordinate";
    mapsUrl = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
  } else
    throw new MapsError(
      "unsupported_place",
      "A saved entry has neither a Google place identity nor coordinates.",
    );
  return {
    listKey: key,
    identity,
    identityKind,
    featureParts,
    featureId,
    cid,
    name,
    note: optionalText(at(raw, 3), "Saved note", 49152),
    address: optionalText(at(raw, 1, 4), "Saved address", 16384),
    latitude,
    longitude,
    mapsUrl,
    position,
  };
}

/**
 * Decodes one `getlist` response page. `offset` is the number of entries in
 * earlier pages of the same list. The list ID, type and count in the page must
 * match `list`. A page has at most 500 rows. `cursor` is "" on the last page.
 * Throws `MapsError` on a mismatch or an invalid page.
 */
export async function decodePage(
  root: unknown,
  list: SourceList,
  offset: number,
): Promise<{
  members: Membership[];
  cursor: string;
  modifiedMarker: string | null;
}> {
  const raw = at(root, 0);
  if (!Array.isArray(raw))
    throw new MapsError(
      "google_access",
      "Google rejected this list read. Check the account and retry.",
    );
  if (
    at(raw, 0, 0) !== list.id ||
    at(raw, 0, 1) !== list.type ||
    at(raw, 12) !== list.reportedCount
  )
    throw new MapsError(
      "changed",
      "The list identity or count changed while it was read.",
    );
  const rawRows = at(raw, 8);
  const rawCursor = at(root, 1);
  const rows = rawRows === null || rawRows === undefined ? [] : rawRows;
  const rowShape =
    rawRows === null
      ? "null"
      : rawRows === undefined
        ? "undefined"
        : Array.isArray(rawRows)
          ? `array(${rawRows.length})`
          : typeof rawRows;
  const cursorType =
    rawCursor === null
      ? "null"
      : Array.isArray(rawCursor)
        ? "array"
        : typeof rawCursor;
  if (
    !Array.isArray(rows) ||
    (rawCursor !== null &&
      rawCursor !== undefined &&
      typeof rawCursor !== "string") ||
    rows.length > 500 ||
    (typeof rawCursor === "string" && rawCursor.length > 16384)
  ) {
    throw new MapsError(
      "schema",
      `Invalid Google list page (rows ${rowShape}; cursor ${cursorType}).`,
    );
  }
  const cursor = typeof rawCursor === "string" ? rawCursor : "";
  return {
    members: await Promise.all(
      rows.map((p, i) => decodeMember(p, list.key, offset + i)),
    ),
    cursor,
    modifiedMarker: marker(at(raw, 11)),
  };
}
