const NEEDS_QUOTES = /["\r\n,]/;

/** RFC 4180 field. Leading or trailing spaces also force quotes. */
export function encodeCsvField(value: string): string {
  const quote =
    NEEDS_QUOTES.test(value) || value.startsWith(" ") || value.endsWith(" ");
  if (!quote) {
    return value;
  }
  return `"${value.replaceAll('"', '""')}"`;
}

/** LF line endings, trailing LF, no BOM. */
export function encodeCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(encodeCsvField).join(",") + "\n").join("");
}
