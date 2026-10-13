import { describe, expect, test } from "vitest";
import { encodeCsv, encodeCsvField } from "../src/csv.js";

describe("encodeCsvField", () => {
  test("leaves plain values unquoted", () => {
    expect(encodeCsvField("Plain value")).toBe("Plain value");
    expect(encodeCsvField("")).toBe("");
    expect(encodeCsvField("テスト")).toBe("テスト");
  });

  test("quotes commas", () => {
    expect(encodeCsvField("a,b")).toBe('"a,b"');
  });

  test("quotes and doubles inner quotes", () => {
    expect(encodeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  test("quotes CR and LF", () => {
    expect(encodeCsvField("line1\nline2")).toBe('"line1\nline2"');
    expect(encodeCsvField("line1\r\nline2")).toBe('"line1\r\nline2"');
    expect(encodeCsvField("a\rb")).toBe('"a\rb"');
  });

  test("quotes leading and trailing spaces", () => {
    expect(encodeCsvField(" lead")).toBe('" lead"');
    expect(encodeCsvField("trail ")).toBe('"trail "');
    expect(encodeCsvField("in side")).toBe("in side");
  });
});

describe("encodeCsv", () => {
  test("joins rows with LF and ends with LF", () => {
    expect(
      encodeCsv([
        ["Title", "Note"],
        ["A", "x,y"],
      ]),
    ).toBe('Title,Note\nA,"x,y"\n');
  });

  test("has no BOM", () => {
    const text = encodeCsv([["Title"]]);
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text.startsWith("Title")).toBe(true);
  });

  test("keeps empty fields", () => {
    expect(encodeCsv([["a", "", "c", ""]])).toBe("a,,c,\n");
  });
});
