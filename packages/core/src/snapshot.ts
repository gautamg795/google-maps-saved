export const SNAPSHOT_FORMAT = "google-maps-saved" as const;
export const SCHEMA_VERSION = 1 as const;
export const ADAPTER_REVISION = "maps-web-20261011.1";
export const LIMITS = {
  bytes: 10 * 1024 * 1024,
  memberships: 5000,
  lists: 100,
  rowBytes: 64 * 1024,
} as const;
export type Relationship = "owned" | "collaborative" | "followed";
export type Visibility = "private" | "shared" | "public" | "unknown";
export type SourceList = {
  key: string;
  id: string;
  type: number;
  ownerAccountId: string;
  relationship: Relationship;
  title: string;
  description: string;
  emoji: string;
  visibility: Visibility;
  reportedCount: number;
  modifiedMarker: string | null;
};
export type Membership = {
  listKey: string;
  identity: string;
  identityKind: "feature" | "coordinate";
  featureParts: [string, string] | null;
  featureId: string | null;
  cid: string | null;
  name: string;
  note: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  mapsUrl: string;
  position: number;
};
export type Snapshot = {
  format: typeof SNAPSHOT_FORMAT;
  schemaVersion: typeof SCHEMA_VERSION;
  adapterRevision: string;
  captureId: string;
  startedAt: string;
  finishedAt: string;
  googleAccountId: string;
  inventoryComplete: true;
  requestedGroups: Relationship[];
  inventory: SourceList[];
  selectedListKeys: string[];
  lists: {
    key: string;
    reportedCount: number;
    retrievedCount: number;
    complete: true;
  }[];
  memberships: Membership[];
};
export class MapsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MapsError";
  }
}
export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;
export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MapsError("schema", `${label} is not an object.`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, bytes = 4096): string {
  if (typeof value !== "string" || utf8Bytes(value) > bytes)
    throw new MapsError("schema", `${label} is missing or too large.`);
  return value;
}
export function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new MapsError("schema", `${label} is not a safe count.`);
  return value;
}
export function accountId(value: unknown): string {
  const id = text(value, "Google account ID", 32);
  if (!/^\d{1,32}$/.test(id))
    throw new MapsError(
      "account_unknown",
      "The Google account could not be verified.",
    );
  return id;
}
export function listKey(id: string, type: number): string {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(id) || ![1, 2, 3, 5, 6].includes(type))
    throw new MapsError(
      "unsupported_list",
      "This list uses an unsupported Google list identifier or type.",
    );
  return `${type}:${id}`;
}
export function coordinate(
  value: unknown,
  axis: "latitude" | "longitude",
): number | null {
  if (value === null || value === undefined) return null;
  const max = axis === "latitude" ? 90 : 180;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > max
  )
    throw new MapsError("schema", `Invalid ${axis}.`);
  return Object.is(value, -0) ? 0 : value;
}
export function feature(parts: unknown): {
  featureParts: [string, string];
  featureId: string;
  cid: string;
} {
  if (!Array.isArray(parts) || parts.length !== 2)
    throw new MapsError("schema", "Invalid Google feature identity.");
  const signed = parts.map((v) => {
    const s = text(v, "Feature identity", 21);
    if (!/^-?\d{1,20}$/.test(s))
      throw new MapsError("schema", "Invalid Google feature identity.");
    const n = BigInt(s);
    if (n < -(1n << 63n) || n >= 1n << 63n)
      throw new MapsError("schema", "Feature identity exceeds int64.");
    return n;
  });
  const unsigned = signed.map((n) => BigInt.asUintN(64, n));
  return {
    featureParts: signed.map(String) as [string, string],
    featureId: `0x${unsigned[0].toString(16)}:0x${unsigned[1].toString(16)}`,
    cid: String(unsigned[1]),
  };
}
export async function digest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes).buffer;
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", copy)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function coordinateIdentity(
  latitude: number,
  longitude: number,
  name: string,
): Promise<string> {
  return `coordinate:${await digest(new TextEncoder().encode(JSON.stringify([latitude, longitude, name])))}`;
}
export function readSourceList(value: unknown): SourceList {
  const v = object(value, "Source list");
  const id = text(v.id, "List ID", 256),
    type = count(v.type, "List type"),
    key = listKey(id, type);
  if (
    v.key !== key ||
    !["owned", "collaborative", "followed"].includes(String(v.relationship))
  )
    throw new MapsError("schema", "Invalid source list key or relationship.");
  if (
    !["private", "shared", "public", "unknown"].includes(String(v.visibility))
  )
    throw new MapsError("schema", "Invalid source visibility.");
  // A reserved ID marks an owned default list that Google has never
  // materialized. It is not a real collection ID, and getlist cannot read it.
  if (
    id.startsWith("unmaterialized-default-") &&
    (v.relationship !== "owned" ||
      ![2, 3, 5, 6].includes(type) ||
      v.reportedCount !== 0 ||
      id !== `unmaterialized-default-${accountId(v.ownerAccountId)}`)
  )
    throw new MapsError("schema", "Invalid empty default list identity.");
  return {
    key,
    id,
    type,
    ownerAccountId: accountId(v.ownerAccountId),
    relationship: v.relationship as Relationship,
    title: text(v.title, "List title"),
    description: text(v.description, "List description", 16384),
    emoji: text(v.emoji, "Emoji", 256),
    visibility: v.visibility as Visibility,
    reportedCount: count(v.reportedCount, "Declared count"),
    modifiedMarker:
      v.modifiedMarker === null
        ? null
        : text(v.modifiedMarker, "Modification marker", 128),
  };
}
export async function validateSnapshot(value: unknown): Promise<Snapshot> {
  const v = object(value, "Snapshot");
  if (
    v.format !== SNAPSHOT_FORMAT ||
    v.schemaVersion !== SCHEMA_VERSION ||
    v.inventoryComplete !== true
  )
    throw new MapsError("schema", "Unsupported or incomplete snapshot.");
  const googleAccountId = accountId(v.googleAccountId);
  if (
    !Array.isArray(v.requestedGroups) ||
    !v.requestedGroups.includes("owned") ||
    v.requestedGroups.some(
      (g) => !["owned", "collaborative", "followed"].includes(g),
    ) ||
    new Set(v.requestedGroups).size !== v.requestedGroups.length
  )
    throw new MapsError("schema", "Invalid requested groups.");
  if (!Array.isArray(v.inventory) || v.inventory.length >= 1500)
    throw new MapsError("incomplete", "Inventory exceeds supported bounds.");
  const inventory = v.inventory.map(readSourceList),
    byKey = new Map(inventory.map((l) => [l.key, l]));
  if (
    byKey.size !== inventory.length ||
    inventory.some(
      (l) => !(v.requestedGroups as string[]).includes(l.relationship),
    )
  )
    throw new MapsError("schema", "Duplicate or out-of-scope inventory.");
  const own = inventory.filter((l) => l.relationship === "owned");
  if (!own.length || own.some((l) => l.ownerAccountId !== googleAccountId))
    throw new MapsError(
      "account_mismatch",
      "Owned lists do not establish the bound Google account.",
    );
  for (const group of v.requestedGroups)
    if (inventory.filter((l) => l.relationship === group).length >= 500)
      throw new MapsError(
        "incomplete",
        "Google inventory reached the unverified pagination limit.",
      );
  if (
    !Array.isArray(v.selectedListKeys) ||
    v.selectedListKeys.length > LIMITS.lists ||
    v.selectedListKeys.some((k) => typeof k !== "string" || !byKey.has(k)) ||
    new Set(v.selectedListKeys).size !== v.selectedListKeys.length
  )
    throw new MapsError("schema", "Invalid list selection.");
  if (
    !Array.isArray(v.lists) ||
    v.lists.length !== v.selectedListKeys.length ||
    !Array.isArray(v.memberships) ||
    v.memberships.length > LIMITS.memberships
  )
    throw new MapsError("schema", "Invalid snapshot contents.");
  const selected = new Set(v.selectedListKeys as string[]),
    seen = new Set<string>(),
    perList = new Map<string, number>();
  const memberships: Membership[] = [];
  for (const raw of v.memberships) {
    const p = object(raw, "Membership"),
      key = text(p.listKey, "List key", 260);
    if (!selected.has(key))
      throw new MapsError(
        "schema",
        "Membership is outside the selected lists.",
      );
    const name = text(p.name, "Place name"),
      latitude = coordinate(p.latitude, "latitude"),
      longitude = coordinate(p.longitude, "longitude");
    let identity: string,
      featureParts: [string, string] | null = null,
      featureId: string | null = null,
      cid: string | null = null,
      mapsUrl: string;
    if (p.identityKind === "feature") {
      const f = feature(p.featureParts);
      featureParts = f.featureParts;
      featureId = f.featureId;
      cid = f.cid;
      identity = featureId;
      mapsUrl = `https://www.google.com/maps?cid=${cid}`;
    } else if (
      p.identityKind === "coordinate" &&
      latitude !== null &&
      longitude !== null &&
      p.featureParts === null &&
      p.featureId === null &&
      p.cid === null
    ) {
      identity = await coordinateIdentity(latitude, longitude, name);
      mapsUrl = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
    } else
      throw new MapsError("schema", "Membership has no supported identity.");
    if (
      p.identity !== identity ||
      p.featureId !== featureId ||
      p.cid !== cid ||
      p.mapsUrl !== mapsUrl
    )
      throw new MapsError(
        "schema",
        "Source identity or Maps URL is inconsistent.",
      );
    const memberKey = `${key}\u0000${identity}`;
    if (seen.has(memberKey))
      throw new MapsError("schema", "Duplicate saved entry identity.");
    seen.add(memberKey);
    const position = count(p.position, "Position"),
      expectedPosition = perList.get(key) ?? 0;
    if (position !== expectedPosition)
      throw new MapsError("schema", "Membership order is incomplete.");
    perList.set(key, expectedPosition + 1);
    const member: Membership = {
      listKey: key,
      identity,
      identityKind: p.identityKind as Membership["identityKind"],
      featureParts,
      featureId,
      cid,
      name,
      note: text(p.note, "Source note", 49152),
      address: text(p.address, "Address", 16384),
      latitude,
      longitude,
      mapsUrl,
      position,
    };
    if (utf8Bytes(JSON.stringify(member)) > LIMITS.rowBytes)
      throw new MapsError(
        "too_large",
        "A saved entry exceeds the supported size.",
      );
    memberships.push(member);
  }
  const completeKeys = new Set<string>();
  const lists = v.lists.map((raw) => {
    const l = object(raw, "List completion"),
      key = text(l.key, "List key", 260),
      reportedCount = count(l.reportedCount, "Reported count"),
      retrievedCount = count(l.retrievedCount, "Retrieved count");
    if (
      !selected.has(key) ||
      completeKeys.has(key) ||
      l.complete !== true ||
      byKey.get(key)?.reportedCount !== reportedCount ||
      retrievedCount !== reportedCount ||
      (perList.get(key) ?? 0) !== retrievedCount
    )
      throw new MapsError("incomplete", "A selected list is not complete.");
    completeKeys.add(key);
    return { key, reportedCount, retrievedCount, complete: true as const };
  });
  const result: Snapshot = {
    format: SNAPSHOT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    adapterRevision: text(v.adapterRevision, "Adapter version", 128),
    captureId: text(v.captureId, "Capture ID", 128),
    startedAt: text(v.startedAt, "Start time", 64),
    finishedAt: text(v.finishedAt, "Finish time", 64),
    googleAccountId,
    inventoryComplete: true,
    requestedGroups: v.requestedGroups as Relationship[],
    inventory,
    selectedListKeys: [...selected],
    lists,
    memberships,
  };
  if (utf8Bytes(JSON.stringify(result)) > LIMITS.bytes)
    throw new MapsError("too_large", "Snapshot exceeds 10 MiB.");
  return result;
}
