import { describe, expect, it, vi } from "vitest";
import {
  ADAPTER_REVISION,
  SNAPSHOT_FORMAT,
  coordinateIdentity,
  feature,
  validateSnapshot,
} from "../src/snapshot.js";
import {
  decodeInventory,
  decodeList,
  decodeMember,
  decodePage,
  decodeResponse,
} from "../src/decode.js";
import { GoogleReader } from "../src/collect.js";

function listRow(
  id = "list_A",
  type = 1,
  total = 1,
  owner = "123456789012345678901",
  title = "Saved list",
) {
  const r: unknown[] = [];
  r[0] = [id, type];
  r[3] = [null, null, owner];
  r[4] = title;
  r[5] = "";
  r[8] = [];
  r[11] = [1700000000, 0];
  r[12] = total;
  r[17] = "";
  return r;
}
function inventory(
  rows: unknown[] = [listRow()],
  collaborators: unknown[] = [],
) {
  const r: unknown[] = [];
  r[29] = [null, null, null, rows];
  r[43] = [null, null, null, collaborators];
  r[30] = [null, null, null, []];
  return r;
}
function member(index = 0, coordinateOnly = false) {
  const p: unknown[] = [];
  p[1] = [
    null,
    null,
    "Name/address",
    null,
    "Address",
    [null, null, 35, 139],
    coordinateOnly ? null : ["1", String(index + 1)],
  ];
  p[2] = `Place ${index}`;
  p[3] = "My source note";
  return p;
}
function page(total: number, size: number, offset = 0, cursor = ""): unknown[] {
  const l = listRow("list_A", 1, total);
  l[8] = Array.from({ length: size }, (_, i) => member(offset + i));
  return [l, cursor];
}
const response = (v: unknown) =>
  new Response(")]}'\n" + JSON.stringify(v), { status: 200 });
function readOptions(fetcher: typeof fetch) {
  return {
    slot: 0,
    followed: false,
    expectedAccountId: "123456789012345678901",
    signal: new AbortController().signal,
    fetcher,
  };
}

describe("Google positional decoder", () => {
  it("strips XSSI and never evaluates executable response text", () => {
    expect(decodeResponse(')]}\'\n[null,1]/*""*/')).toEqual([null, 1]);
    expect(() => decodeResponse("window.alert('no')")).toThrow();
    expect(() => decodeResponse("<html>Sign in</html>")).toThrow();
  });
  it("binds only consistent owned IDs, not a collaborative owner's account", () => {
    const d = decodeInventory(
      inventory([listRow()], [listRow("collab", 1, 0, "999")]),
      false,
    );
    expect(d.googleAccountId).toBe("123456789012345678901");
    expect(d.inventory).toHaveLength(2);
    expect(() =>
      decodeInventory(inventory([], [listRow("collab", 1, 0, "999")]), false),
    ).toThrow("account");
    expect(() =>
      decodeInventory(inventory([listRow(), listRow("B", 1, 1, "999")]), false),
    ).toThrow("account");
  });
  it("fails on missing groups and unverified inventory pagination", () => {
    expect(() => decodeInventory([], false)).toThrow();
    expect(() =>
      decodeInventory(
        inventory(Array.from({ length: 500 }, (_, i) => listRow(`L_${i}`))),
        false,
      ),
    ).toThrow("pagination");
  });
  it("rejects protobuf delimiter injection in identifiers", () => {
    expect(() =>
      decodeInventory(inventory([listRow("valid!4i1000")]), false),
    ).toThrow("identifier");
  });
  it("maps evidenced private/shared values without treating collaboration as public", () => {
    const privateRow = listRow(),
      sharedRow = listRow(),
      collaborativeRow = listRow();
    privateRow[2] = [1];
    sharedRow[2] = [2];
    collaborativeRow[2] = [3];
    expect(decodeList(privateRow, "owned").visibility).toBe("private");
    expect(decodeList(sharedRow, "owned").visibility).toBe("shared");
    expect(decodeList(collaborativeRow, "collaborative").visibility).toBe(
      "unknown",
    );
  });
  it("preserves signed IDs above Number precision and converts modulo uint64", () => {
    expect(feature(["9223372036854775807", "-1"]).cid).toBe(
      "18446744073709551615",
    );
    expect(() => feature([1, 2])).toThrow();
    expect(() => feature(["1", "18446744073709551615"])).toThrow("int64");
  });
  it("keeps coordinate-only saves with explicitly weak identities", async () => {
    const p = await decodeMember(member(3, true), "1:list_A", 0);
    expect(p.identityKind).toBe("coordinate");
    expect(p.cid).toBeNull();
    expect(p.identity).toBe(await coordinateIdentity(35, 139, "Place 3"));
    expect(p.mapsUrl).toBe(
      "https://www.google.com/maps/search/?api=1&query=35,139",
    );
  });
  it("normalizes empty unmaterialized defaults and an empty group container", () => {
    const row = listRow("ignored", 6, 0);
    (row[0] as unknown[])[0] = null;
    const root = inventory([row]);
    root[43] = [];
    const decoded = decodeInventory(root, false);
    expect(decoded.inventory[0]).toMatchObject({
      id: "unmaterialized-default-123456789012345678901",
      key: "6:unmaterialized-default-123456789012345678901",
      reportedCount: 0,
      relationship: "owned",
    });
    expect(decoded.requestedGroups).toEqual(["owned", "collaborative"]);
    const nonempty = listRow("ignored", 6, 1);
    (nonempty[0] as unknown[])[0] = null;
    expect(() => decodeList(nonempty, "owned")).toThrow();
    expect(() => decodeList(row, "collaborative")).toThrow();
  });
  it("rejects application errors and mismatched content IDs despite HTTP 200", async () => {
    const list = decodeInventory(inventory(), false).inventory[0];
    await expect(decodePage([null, null, 5], list, 0)).rejects.toThrow(
      "rejected",
    );
    const wrong = page(1, 1);
    (wrong[0] as unknown[])[0] = ["other", 1];
    await expect(decodePage(wrong, list, 0)).rejects.toThrow("identity");
  });
});

describe("sequential account-checked capture", () => {
  it("honors a future HTTP-date Retry-After rather than retrying early", async () => {
    const fetcher: typeof fetch = vi.fn(
      async () =>
        new Response("busy", {
          status: 429,
          headers: {
            "retry-after": new Date(Date.now() + 60000).toUTCString(),
          },
        }),
    );
    await expect(
      new GoogleReader(readOptions(fetcher)).inventory(),
    ).rejects.toThrow("retry later");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not retry malformed UTF-8 as a network failure", async () => {
    const fetcher: typeof fetch = vi.fn(
      async () => new Response(new Uint8Array([0xc3, 0x28])),
    );
    await expect(
      new GoogleReader(readOptions(fetcher)).inventory(),
    ).rejects.toThrow("UTF-8");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { label: "empty-string", cursor: "", omit: false, invalid: false },
    { label: "null", cursor: null, omit: false, invalid: false },
    { label: "omitted", cursor: "", omit: true, invalid: false },
    { label: "numeric", cursor: 7, omit: false, invalid: true },
  ])(
    "uses the opaque bytes cursor and handles the $label terminal cursor",
    async ({ cursor, omit, invalid }) => {
      const seen: URL[] = [];
      const terminal = page(590, 90, 500);
      if (omit) terminal.length = 1;
      else terminal[1] = cursor;
      const fetcher: typeof fetch = vi.fn(async (input) => {
        const url = new URL(String(input));
        seen.push(url);
        if (url.pathname.endsWith("/mas"))
          return response(inventory([listRow("list_A", 1, 590)]));
        return response(
          url.searchParams.get("pb")?.includes("!5B")
            ? terminal
            : page(590, 500, 0, "a+b/=="),
        );
      });
      const capture = new GoogleReader(readOptions(fetcher)).collect();
      if (invalid) {
        await expect(capture).rejects.toThrow("rows array(90); cursor number");
        return;
      }
      const result = await capture;
      expect(result.memberships).toHaveLength(590);
      expect(result.lists[0].complete).toBe(true);
      expect(
        seen.some((u) => u.searchParams.get("pb")?.endsWith("!5Ba-b_")),
      ).toBe(true);
      expect(seen.every((u) => u.origin === "https://www.google.com")).toBe(
        true,
      );
    },
  );
  it("blocks a changed account before any content request", async () => {
    const fetcher = vi.fn(async () =>
      response(inventory([listRow("list_A", 1, 1, "999")])),
    );
    await expect(
      new GoogleReader(readOptions(fetcher)).collect(),
    ).rejects.toThrow("different account");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("aborts when the account switches between pages", async () => {
    let inventories = 0;
    const fetcher: typeof fetch = vi.fn(async (input) => {
      if (new URL(String(input)).pathname.endsWith("/mas"))
        return response(
          inventory([
            listRow(
              "list_A",
              1,
              590,
              ++inventories >= 3 ? "999" : "123456789012345678901",
            ),
          ]),
        );
      return response(page(590, 500, 0, "next"));
    });
    await expect(
      new GoogleReader(readOptions(fetcher)).collect(),
    ).rejects.toThrow("different account");
  });
  it.each([
    {
      label: "a short terminal page",
      size: 1,
      cursor: "",
      nullRows: false,
      error: "every entry",
    },
    {
      label: "an empty page with a continuation",
      size: 0,
      cursor: "next",
      nullRows: true,
      error: "empty continuation page",
    },
  ])(
    "rejects an incomplete list instead of exporting pages with $label",
    async ({ size, cursor, nullRows, error }) => {
      const fetcher: typeof fetch = vi.fn(async (input) => {
        if (new URL(String(input)).pathname.endsWith("/mas"))
          return response(inventory([listRow("list_A", 1, 2)]));
        const next = page(2, size, 0, cursor);
        if (nullRows) (next[0] as unknown[])[8] = null;
        return response(next);
      });
      await expect(
        new GoogleReader(readOptions(fetcher)).collect(),
      ).rejects.toThrow(error);
    },
  );
  it("skips content requests for unmaterialized zero-count defaults but fences materialization", async () => {
    const row = listRow("ignored", 6, 0);
    (row[0] as unknown[])[0] = null;
    const fetcher: typeof fetch = vi.fn(async (input) => {
      expect(new URL(String(input)).pathname).toContain("/mas");
      return response(inventory([row]));
    });
    const captured = await new GoogleReader(readOptions(fetcher)).collect();
    expect(captured.lists).toEqual([
      {
        key: "6:unmaterialized-default-123456789012345678901",
        reportedCount: 0,
        retrievedCount: 0,
        complete: true,
      },
    ]);
    expect(captured.memberships).toEqual([]);
    let reads = 0;
    const materialized: typeof fetch = vi.fn(async () =>
      response(inventory([++reads === 1 ? row : listRow("real_list", 6, 0)])),
    );
    await expect(
      new GoogleReader(readOptions(materialized)).collect(),
    ).rejects.toThrow("inventory changed");
  });
  it("re-resolves the same stable account when its routing slot changes", async () => {
    let slot = 0;
    const seen: number[] = [];
    const fetcher: typeof fetch = vi.fn(async (input) => {
      const u = new URL(String(input));
      seen.push(Number(u.searchParams.get("authuser")));
      return response(
        u.pathname.endsWith("/mas")
          ? inventory([listRow("list_A", 1, 0)])
          : page(0, 0),
      );
    });
    const resolveSlot = vi.fn(async () => (slot++ === 0 ? 0 : 1));
    await new GoogleReader({ ...readOptions(fetcher), resolveSlot }).collect();
    expect(seen[0]).toBe(0);
    expect(seen.slice(1).every((s) => s === 1)).toBe(true);
  });
  it("supports an evidenced empty list with null or omitted repeated rows", async () => {
    const fetcher: typeof fetch = vi.fn(async (input) => {
      if (new URL(String(input)).pathname.endsWith("/mas"))
        return response(inventory([listRow("list_A", 1, 0)]));
      const empty = page(0, 0);
      (empty[0] as unknown[])[8] = null;
      return response(empty);
    });
    const captured = await new GoogleReader(readOptions(fetcher)).collect();
    expect(captured.memberships).toEqual([]);
    expect(captured.lists[0]).toMatchObject({
      reportedCount: 0,
      retrievedCount: 0,
      complete: true,
    });
    const list = decodeInventory(inventory([listRow("list_A", 1, 0)]), false)
      .inventory[0];
    const omitted = page(0, 0)[0] as unknown[];
    delete omitted[8];
    await expect(decodePage([omitted], list, 0)).resolves.toMatchObject({
      members: [],
      cursor: "",
    });
  });
});

describe("normalized snapshot validation", () => {
  async function fixture() {
    const i = decodeInventory(inventory(), false),
      p = await decodeMember(member(), "1:list_A", 0);
    return {
      format: SNAPSHOT_FORMAT,
      schemaVersion: 1,
      adapterRevision: ADAPTER_REVISION,
      captureId: "test",
      startedAt: "2026-10-11T00:00:00Z",
      finishedAt: "2026-10-11T00:00:01Z",
      ...i,
      inventoryComplete: true,
      selectedListKeys: ["1:list_A"],
      lists: [
        {
          key: "1:list_A",
          reportedCount: 1,
          retrievedCount: 1,
          complete: true,
        },
      ],
      memberships: [p],
    };
  }
  it("rejects a claimed account that disagrees with owned inventory", async () => {
    await expect(
      validateSnapshot({ ...(await fixture()), googleAccountId: "999" }),
    ).rejects.toThrow("bound Google account");
  });
  it("rejects tampered URLs, IDs, incomplete counts and duplicate keys", async () => {
    const f = await fixture();
    await expect(
      validateSnapshot({
        ...f,
        memberships: [
          { ...f.memberships[0], mapsUrl: "https://evil.invalid/" },
        ],
      }),
    ).rejects.toThrow("inconsistent");
    await expect(
      validateSnapshot({ ...f, lists: [{ ...f.lists[0], retrievedCount: 0 }] }),
    ).rejects.toThrow("complete");
    await expect(
      validateSnapshot({ ...f, inventory: [...f.inventory, ...f.inventory] }),
    ).rejects.toThrow("Duplicate");
  });
  it("rejects reserved placeholder IDs with a different owner, type, relationship or nonzero count", async () => {
    const f = await fixture();
    const empty = {
      ...f.inventory[0],
      id: "unmaterialized-default-123456789012345678901",
      key: "6:unmaterialized-default-123456789012345678901",
      type: 6,
      reportedCount: 0,
    };
    const value = {
      ...f,
      inventory: [empty],
      selectedListKeys: [empty.key],
      lists: [
        { key: empty.key, reportedCount: 0, retrievedCount: 0, complete: true },
      ],
      memberships: [],
    };
    await expect(validateSnapshot(value)).resolves.toMatchObject({
      inventory: [empty],
    });
    for (const changed of [
      { ownerAccountId: "999" },
      { type: 1, key: "1:" + empty.id },
      { relationship: "followed" },
      { reportedCount: 1 },
    ])
      await expect(
        validateSnapshot({ ...value, inventory: [{ ...empty, ...changed }] }),
      ).rejects.toThrow("empty default");
  });
  it("drops unallowlisted credential or edit-link fields from normalized output", async () => {
    const f = await fixture();
    const normalized = await validateSnapshot({
      ...f,
      cookie: "must-not-travel",
      editUrl: "must-not-travel",
    });
    expect(JSON.stringify(normalized)).not.toContain("must-not-travel");
  });
});
