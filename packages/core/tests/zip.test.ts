import JSZip from "jszip";
import { describe, expect, test } from "vitest";
import { createStoredZip, type ZipEntry } from "../src/zip.js";

const encoder = new TextEncoder();
const DATE = new Date("2026-01-01T12:34:56Z");

function sampleEntries(): ZipEntry[] {
  return [
    { name: "Takeout/Saved/Want to go.csv", data: encoder.encode("Title\nA\n") },
    { name: "Takeout/Saved/東京 カフェ.csv", data: encoder.encode("Title\nテスト\n") },
    { name: "empty.txt", data: new Uint8Array(0) },
  ];
}

describe("createStoredZip", () => {
  test("round-trips names, contents, and CRCs through jszip", async () => {
    const zip = await JSZip.loadAsync(createStoredZip(sampleEntries(), { date: DATE }), {
      checkCRC32: true,
    });
    const files = Object.values(zip.files).filter((f) => !f.dir);
    expect(files.map((f) => f.name)).toEqual([
      "Takeout/Saved/Want to go.csv",
      "Takeout/Saved/東京 カフェ.csv",
      "empty.txt",
    ]);
    expect(await zip.file("Takeout/Saved/Want to go.csv")?.async("string")).toBe("Title\nA\n");
    expect(await zip.file("Takeout/Saved/東京 カフェ.csv")?.async("string")).toBe("Title\nテスト\n");
    expect(await zip.file("empty.txt")?.async("uint8array")).toEqual(new Uint8Array(0));
  });

  test("uses stored method and the UTF-8 name flag", () => {
    const bytes = createStoredZip(sampleEntries(), { date: DATE });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    expect(view.getUint16(8, true)).toBe(0);
  });

  test("writes the given date as DOS time in UTC", () => {
    const view = new DataView(createStoredZip(sampleEntries(), { date: DATE }).buffer);
    const time = view.getUint16(10, true);
    const date = view.getUint16(12, true);
    expect(time >> 11).toBe(12);
    expect((time >> 5) & 0x3f).toBe(34);
    expect((time & 0x1f) * 2).toBe(56);
    expect((date >> 9) + 1980).toBe(2026);
    expect((date >> 5) & 0x0f).toBe(1);
    expect(date & 0x1f).toBe(1);
  });

  test("clamps dates before 1980 to 1980-01-01", () => {
    const view = new DataView(
      createStoredZip(sampleEntries(), { date: new Date("1970-06-15T10:00:00Z") }).buffer,
    );
    expect(view.getUint16(10, true)).toBe(0);
    expect(view.getUint16(12, true)).toBe((1 << 5) | 1);
  });

  test("writes a valid empty archive", async () => {
    const bytes = createStoredZip([], { date: DATE });
    expect(bytes.length).toBe(22);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)).toEqual([]);
  });

  test.each(["", "/abs.csv", "a\\b.csv", "../up.csv", "a/../b.csv", "a/.."])(
    "rejects the name %j",
    (name) => {
      expect(() => createStoredZip([{ name, data: new Uint8Array(0) }])).toThrow(Error);
    },
  );

  test("accepts dots that are not a parent segment", () => {
    expect(() =>
      createStoredZip([{ name: "a/..b/c..csv", data: new Uint8Array(0) }]),
    ).not.toThrow();
  });

  test("rejects more than 65535 entries", () => {
    const data = new Uint8Array(0);
    const entries: ZipEntry[] = Array.from({ length: 65536 }, (_, i) => ({
      name: `f${i}`,
      data,
    }));
    expect(() => createStoredZip(entries)).toThrow(/65535/);
  });
});
