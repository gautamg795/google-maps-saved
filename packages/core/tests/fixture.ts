import {
  ADAPTER_REVISION,
  SCHEMA_VERSION,
  SNAPSHOT_FORMAT,
  coordinateIdentity,
  feature,
  validateSnapshot,
  type Snapshot,
} from "../src/snapshot.js";

export const ACCOUNT_ID = "100000000000000000001";

export type MemberSpec = {
  name: string;
  note?: string;
  address?: string;
  latitude?: number | null;
  longitude?: number | null;
} & (
  | { kind: "feature"; parts: [string, string] }
  | { kind: "coordinate"; latitude: number; longitude: number }
);

export type ListSpec = {
  id: string;
  type: number;
  title: string;
  members: MemberSpec[];
};

/** Build a snapshot candidate from specs and return it after `validateSnapshot`. */
export async function buildSnapshot(lists: ListSpec[]): Promise<Snapshot> {
  const memberships: Record<string, unknown>[] = [];
  for (const list of lists) {
    const listKey = `${list.type}:${list.id}`;
    for (const [position, spec] of list.members.entries()) {
      const base = {
        listKey,
        identityKind: spec.kind,
        name: spec.name,
        note: spec.note ?? "",
        address: spec.address ?? "",
        latitude: spec.latitude ?? null,
        longitude: spec.longitude ?? null,
        position,
      };
      if (spec.kind === "feature") {
        const f = feature(spec.parts);
        memberships.push({
          ...base,
          identity: f.featureId,
          featureParts: f.featureParts,
          featureId: f.featureId,
          cid: f.cid,
          mapsUrl: `https://www.google.com/maps?cid=${f.cid}`,
        });
      } else {
        memberships.push({
          ...base,
          identity: await coordinateIdentity(
            spec.latitude,
            spec.longitude,
            spec.name,
          ),
          featureParts: null,
          featureId: null,
          cid: null,
          mapsUrl: `https://www.google.com/maps/search/?api=1&query=${spec.latitude},${spec.longitude}`,
        });
      }
    }
  }
  const candidate = {
    format: SNAPSHOT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    adapterRevision: ADAPTER_REVISION,
    captureId: "capture-0001",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:05.000Z",
    googleAccountId: ACCOUNT_ID,
    inventoryComplete: true,
    requestedGroups: ["owned"],
    inventory: lists.map((list) => ({
      key: `${list.type}:${list.id}`,
      id: list.id,
      type: list.type,
      ownerAccountId: ACCOUNT_ID,
      relationship: "owned",
      title: list.title,
      description: "",
      emoji: "",
      visibility: "private",
      reportedCount: list.members.length,
      modifiedMarker: null,
    })),
    selectedListKeys: lists.map((list) => `${list.type}:${list.id}`),
    lists: lists.map((list) => ({
      key: `${list.type}:${list.id}`,
      reportedCount: list.members.length,
      retrievedCount: list.members.length,
      complete: true,
    })),
    memberships,
  };
  return validateSnapshot(candidate);
}

/** The two-list snapshot behind `fixtures/sample-snapshot.json`. */
export function sampleSnapshot(): Promise<Snapshot> {
  return buildSnapshot([
    {
      id: "SampleWantToGo01",
      type: 1,
      title: "Want to go",
      members: [
        {
          kind: "feature",
          parts: ["6924438266345614603", "-8072706868340591205"],
          name: "Example Fish Market",
          note: "Go early.\nTry the \"tamagoyaki\", then coffee.",
          address: "1 Example Street, Sample City",
          latitude: 35.6655,
          longitude: 139.7707,
        },
        {
          kind: "coordinate",
          latitude: 35.6586,
          longitude: 139.7454,
          name: "Dropped pin",
        },
        {
          kind: "feature",
          parts: ["1311768467294899695", "-81986143110479071"],
          name: "テスト喫茶 / Test Café, Annex?",
          note: " leading space",
          address: "",
          latitude: null,
          longitude: null,
        },
      ],
    },
    {
      id: "SampleCoffee02",
      type: 3,
      title: "Coffee: Best / Worst?",
      members: [
        {
          kind: "feature",
          parts: ["0", "1520413420215773735"],
          name: "Placeholder Roasters",
          address: "2 Fake Avenue",
          latitude: 52.52,
          longitude: 13.405,
        },
      ],
    },
  ]);
}
