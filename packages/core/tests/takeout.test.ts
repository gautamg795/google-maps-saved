import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { describe, expect, test } from "vitest";
import { validateSnapshot, type Membership, type Snapshot } from "../src/snapshot.js";
import {
  takeoutCsv,
  takeoutFileName,
  takeoutFiles,
  takeoutPlaceUrl,
  toTakeoutZip,
} from "../src/takeout.js";
import { buildSnapshot, sampleSnapshot } from "./fixture.js";

const GOLDEN_DATE = new Date("2026-01-01T00:00:00Z");

/** Split CSV text into records of fields (RFC 4180, LF or CRLF). */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

function memberNamed(snapshot: Snapshot, name: string): Membership {
  const member = snapshot.memberships.find((m) => m.name === name);
  if (member === undefined) throw new Error(`No member named ${name}`);
  return member;
}

describe("takeoutPlaceUrl", () => {
  test("builds a place URL whose !1s token gives the member CID", async () => {
    const snapshot = await sampleSnapshot();
    const member = memberNamed(snapshot, "Example Fish Market");
    const url = takeoutPlaceUrl(member);
    expect(url).toBe(
      "https://www.google.com/maps/place/Example+Fish+Market/data=!4m2!3m1!1s0x60188bea7ea6ed0b:0x8ff7fbdfd0b3f59b",
    );
    expect(BigInt(member.featureId!.split(":")[1]).toString()).toBe(member.cid);
  });

  test("percent-encodes reserved and non-ASCII characters in the name", async () => {
    const snapshot = await sampleSnapshot();
    const member = memberNamed(snapshot, "テスト喫茶 / Test Café, Annex?");
    const url = takeoutPlaceUrl(member);
    const parsed = new URL(url);
    expect(parsed.search).toBe("");
    expect(parsed.pathname.split("/")).toEqual([
      "",
      "maps",
      "place",
      "%E3%83%86%E3%82%B9%E3%83%88%E5%96%AB%E8%8C%B6+%2F+Test+Caf%C3%A9%2C+Annex%3F",
      `data=!4m2!3m1!1s${member.featureId}`,
    ]);
    expect(decodeURIComponent(parsed.pathname.split("/")[3].replaceAll("+", " "))).toBe(
      member.name,
    );
  });

  test("uses Saved+place when the trimmed name is empty", async () => {
    const snapshot = await buildSnapshot([
      {
        id: "Blank",
        type: 1,
        title: "Blank",
        members: [{ kind: "feature", parts: ["1", "2"], name: "   " }],
      },
    ]);
    expect(takeoutPlaceUrl(snapshot.memberships[0])).toBe(
      "https://www.google.com/maps/place/Saved+place/data=!4m2!3m1!1s0x1:0x2",
    );
  });

});

describe("takeoutFileName", () => {
  test("replaces unsafe characters and collapses whitespace", () => {
    expect(takeoutFileName('a/b\\c:d*e?f"g<h>i|j', new Set())).toBe("a b c d e f g h i j");
    expect(takeoutFileName("  tab\there \u0001 ctl  ", new Set())).toBe("tab here ctl");
    expect(takeoutFileName("Trip...", new Set())).toBe("Trip");
    expect(takeoutFileName("Notes . ..", new Set())).toBe("Notes");
    expect(takeoutFileName("東京 カフェ", new Set())).toBe("東京 カフェ");
  });

  test("uses Saved list for an empty result", () => {
    expect(takeoutFileName("", new Set())).toBe("Saved list");
    expect(takeoutFileName(" /?. ", new Set())).toBe("Saved list");
  });

  test("adds numbered suffixes for duplicates, ignoring case", () => {
    const used = new Set<string>();
    expect(takeoutFileName("Favorites", used)).toBe("Favorites");
    expect(takeoutFileName("Favorites", used)).toBe("Favorites (2)");
    expect(takeoutFileName("FAVORITES", used)).toBe("FAVORITES (3)");
    expect(takeoutFileName("favorites (2)", used)).toBe("favorites (2) (2)");
    expect([...used]).toEqual(["Favorites", "Favorites (2)", "FAVORITES (3)", "favorites (2) (2)"]);
  });
});

describe("takeoutCsv", () => {
  test("writes the exact header and one row per member in position order", async () => {
    const snapshot = await sampleSnapshot();
    const list = snapshot.inventory[0];
    const members = snapshot.memberships.filter((m) => m.listKey === list.key);
    const shuffled = [members[2], members[0], members[1]];
    const csv = takeoutCsv(list, shuffled);
    expect(shuffled.map((m) => m.position)).toEqual([2, 0, 1]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Title,Note,URL,Comment");
    const records = parseCsv(csv);
    expect(records.map((r) => r[0])).toEqual([
      "Title",
      "Example Fish Market",
      "Dropped pin",
      "テスト喫茶 / Test Café, Annex?",
    ]);
    expect(records.every((r) => r.length === 4)).toBe(true);
    expect(records[1][3]).toBe("");
  });

  test("adds extended columns only when requested", async () => {
    const snapshot = await sampleSnapshot();
    const list = snapshot.inventory[0];
    const members = snapshot.memberships.filter((m) => m.listKey === list.key);
    expect(takeoutCsv(list, members, { extended: false }).split("\n")[0]).toBe(
      "Title,Note,URL,Comment",
    );
    const records = parseCsv(takeoutCsv(list, members, { extended: true }));
    expect(records[0]).toEqual([
      "Title",
      "Note",
      "URL",
      "Comment",
      "Latitude",
      "Longitude",
      "Address",
    ]);
    expect(records[1].slice(4)).toEqual(["35.6655", "139.7707", "1 Example Street, Sample City"]);
    expect(records[3].slice(4)).toEqual(["", "", ""]);
  });

  test("gives a header-only CSV for an empty list", async () => {
    const snapshot = await buildSnapshot([
      { id: "Empty", type: 1, title: "Empty", members: [] },
    ]);
    expect(takeoutCsv(snapshot.inventory[0], [])).toBe("Title,Note,URL,Comment\n");
    expect(takeoutCsv(snapshot.inventory[0], [], { extended: true })).toBe(
      "Title,Note,URL,Comment,Latitude,Longitude,Address\n",
    );
  });
});

describe("takeoutFiles", () => {
  test("follows selectedListKeys order and throws for a missing list", async () => {
    const snapshot = await sampleSnapshot();
    expect(takeoutFiles(snapshot).map((f) => f.path)).toEqual([
      "Takeout/Saved/Want to go.csv",
      "Takeout/Saved/Coffee Best Worst.csv",
    ]);
    const reversed = { ...snapshot, selectedListKeys: [...snapshot.selectedListKeys].reverse() };
    expect(takeoutFiles(reversed).map((f) => f.path)).toEqual([
      "Takeout/Saved/Coffee Best Worst.csv",
      "Takeout/Saved/Want to go.csv",
    ]);
    const broken = { ...snapshot, selectedListKeys: ["1:Missing"] };
    expect(() => takeoutFiles(broken)).toThrow(Error);
  });
});

describe("toTakeoutZip", () => {
  test("round-trips through jszip with Takeout paths and suffixed duplicates", async () => {
    const snapshot = await buildSnapshot([
      {
        id: "First",
        type: 1,
        title: "Ramen",
        members: [{ kind: "feature", parts: ["6924438266345614603", "-8072706868340591205"], name: "Sample Noodle Bar" }],
      },
      {
        id: "Second",
        type: 2,
        title: "ramen",
        members: [{ kind: "coordinate", latitude: 1.5, longitude: -2.25, name: "Pin" }],
      },
    ]);
    const zip = await JSZip.loadAsync(toTakeoutZip(snapshot, { date: GOLDEN_DATE }), {
      checkCRC32: true,
    });
    const names = Object.values(zip.files)
      .filter((f) => !f.dir)
      .map((f) => f.name);
    expect(names).toEqual(["Takeout/Saved/Ramen.csv", "Takeout/Saved/ramen (2).csv"]);

    const first = parseCsv((await zip.file("Takeout/Saved/Ramen.csv")?.async("string")) ?? "");
    expect(first[0]).toEqual(["Title", "Note", "URL", "Comment"]);
    expect(first[1][2]).toBe(
      "https://www.google.com/maps/place/Sample+Noodle+Bar/data=!4m2!3m1!1s0x60188bea7ea6ed0b:0x8ff7fbdfd0b3f59b",
    );

    const second = parseCsv((await zip.file("Takeout/Saved/ramen (2).csv")?.async("string")) ?? "");
    expect(second[1][2]).toBe("https://www.google.com/maps/search/?api=1&query=1.5,-2.25");
  });

  test("matches the committed golden ZIP", async () => {
    const json: unknown = JSON.parse(
      readFileSync(new URL("./fixtures/sample-snapshot.json", import.meta.url), "utf8"),
    );
    const snapshot = await validateSnapshot(json);
    const golden = new Uint8Array(
      readFileSync(new URL("./fixtures/sample-takeout.zip", import.meta.url)),
    );
    const bytes = toTakeoutZip(snapshot, { extended: true, date: GOLDEN_DATE });
    expect(bytes).toEqual(golden);
    expect(snapshot).toEqual(await sampleSnapshot());
  });
});
