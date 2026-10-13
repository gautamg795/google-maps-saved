import { toTakeoutZip, type Snapshot } from "google-maps-saved";

export type ExportFormat = "zip" | "json";

export type ExportFile = { name: string; blob: Blob };

const pad = (n: number) => String(n).padStart(2, "0");

/** Returns `google-maps-saved-YYYY-MM-DD.<zip|json>`. The date is local. */
export function exportFileName(format: ExportFormat, date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `google-maps-saved-${day}.${format}`;
}

export function exportMimeType(format: ExportFormat): string {
  return format === "zip" ? "application/zip" : "application/json";
}

/**
 * Serializes `snapshot` in `format`. `extended` adds the Latitude,
 * Longitude, and Address columns to the ZIP. JSON ignores it.
 */
export function exportFile(
  snapshot: Snapshot,
  format: ExportFormat,
  options: { extended: boolean; date: Date },
): ExportFile {
  const type = exportMimeType(format);
  const name = exportFileName(format, options.date);
  if (format === "json") {
    return { name, blob: new Blob([JSON.stringify(snapshot, null, 2)], { type }) };
  }
  const bytes = toTakeoutZip(snapshot, { extended: options.extended, date: options.date });
  // Blob needs an ArrayBuffer-backed view. The copy gives that type.
  return { name, blob: new Blob([new Uint8Array(bytes)], { type }) };
}
