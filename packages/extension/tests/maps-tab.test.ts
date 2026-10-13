import { describe, expect, it } from "vitest";
import { isMapsUrl } from "../src/maps-tab.js";

describe("isMapsUrl", () => {
  it.each([
    "https://www.google.com/maps",
    "https://www.google.com/maps/",
    "https://www.google.com/maps?authuser=1",
    "https://www.google.com/maps/@35.66,139.77,14z",
    "https://www.google.com/maps/place/Example/data=!4m2",
  ])("accepts %s", (url) => {
    expect(isMapsUrl(url)).toBe(true);
  });

  it.each([
    undefined,
    "",
    "not a url",
    "chrome://newtab/",
    "http://www.google.com/maps",
    "https://google.com/maps",
    "https://maps.google.com/",
    "https://www.google.de/maps",
    "https://www.google.com:8443/maps",
    "https://www.google.com.example.com/maps",
    "https://www.google.com/mapsearch",
    "https://www.google.com/search?q=maps",
  ])("rejects %s", (url) => {
    expect(isMapsUrl(url)).toBe(false);
  });
});
