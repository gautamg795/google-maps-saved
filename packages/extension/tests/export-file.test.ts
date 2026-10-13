import { describe, expect, it } from "vitest";
import { exportFile, exportFileName, exportMimeType } from "../src/export-file.js";
import { sampleSnapshot } from "../../core/tests/fixture.js";

const date = new Date(2026, 0, 5, 23, 30);

describe("export file", () => {
  it("names the file with the local date", () => {
    expect(exportFileName("zip", date)).toBe("google-maps-saved-2026-01-05.zip");
    expect(exportFileName("json", date)).toBe("google-maps-saved-2026-01-05.json");
  });

  it("gives the MIME type for each format", () => {
    expect(exportMimeType("zip")).toBe("application/zip");
    expect(exportMimeType("json")).toBe("application/json");
  });

  it("writes a Takeout ZIP with or without the extended columns", async () => {
    const snapshot = await sampleSnapshot();
    const text = async (extended: boolean) => {
      const file = exportFile(snapshot, "zip", { extended, date });
      expect(file.name).toBe("google-maps-saved-2026-01-05.zip");
      expect(file.blob.type).toBe("application/zip");
      const bytes = new Uint8Array(await file.blob.arrayBuffer());
      expect(String.fromCharCode(bytes[0], bytes[1])).toBe("PK");
      // The ZIP is stored without compression, so the CSV text is visible.
      return new TextDecoder().decode(bytes);
    };
    expect(await text(true)).toContain("Title,Note,URL,Comment,Latitude,Longitude,Address");
    const plain = await text(false);
    expect(plain).toContain("Title,Note,URL,Comment");
    expect(plain).not.toContain("Latitude");
  });

  it("writes the snapshot as indented JSON", async () => {
    const snapshot = await sampleSnapshot();
    const file = exportFile(snapshot, "json", { extended: true, date });
    expect(file.name).toBe("google-maps-saved-2026-01-05.json");
    expect(file.blob.type).toBe("application/json");
    const text = await file.blob.text();
    expect(text).toBe(JSON.stringify(snapshot, null, 2));
  });
});
