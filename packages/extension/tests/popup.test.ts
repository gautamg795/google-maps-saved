// @vitest-environment jsdom
import {
  MapsError,
  requestAccountBody,
  type CollectOptions,
  type Snapshot,
  type SourceList,
} from "google-maps-saved";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import html from "../src/popup.html?raw";
import { ACCOUNT_ID, sampleSnapshot } from "../../core/tests/fixture.js";
import { mountPopup, type ChromeApi, type Reader } from "../src/popup-controller.js";

function accountRow(email: string, id: string): unknown[] {
  const row: unknown[] = Array(16).fill(null);
  row[0] = "gaia.l.a";
  row[3] = email;
  row[9] = 1;
  row[10] = id;
  row[15] = 1;
  return row;
}

const accountsBody =
  ")]}'\n" +
  JSON.stringify([
    "gaia.l.a.r",
    [accountRow("other@example.com", "555"), accountRow("me@example.com", ACCOUNT_ID)],
  ]);

function fakeChrome(url: string, granted: boolean) {
  return {
    tabs: {
      query: vi.fn(async () => [{ id: 7, url }]),
      create: vi.fn(async () => ({})),
    },
    permissions: {
      contains: vi.fn(async () => granted),
      request: vi.fn(async () => true),
    },
    scripting: {
      executeScript: vi.fn(async () => [{ result: { body: accountsBody } }]),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({ lastAccountId: ACCOUNT_ID })),
        set: vi.fn(async () => {}),
      },
    },
  } satisfies ChromeApi;
}

let snapshot: Snapshot;
let readers: CollectOptions[];
let collect: () => Promise<Snapshot>;
let downloads: string[];

function createReader(options: CollectOptions): Reader {
  readers.push(options);
  const followed: SourceList = {
    ...snapshot.inventory[0],
    key: "1:Followed03",
    id: "Followed03",
    relationship: "followed",
    title: "Friend picks",
    emoji: "⭐",
  };
  return {
    inventory: async () => ({
      googleAccountId: ACCOUNT_ID,
      requestedGroups: options.followed
        ? ["owned", "collaborative", "followed"]
        : ["owned", "collaborative"],
      inventory: options.followed ? [...snapshot.inventory, followed] : snapshot.inventory,
    }),
    collect: async () => {
      options.progress?.({ listsRead: 1, totalLists: 2, membershipsRead: 3 });
      return collect();
    },
  };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusText = () => $("status").textContent;
const listBoxes = () => Array.from(document.querySelectorAll<HTMLInputElement>("#lists input"));

beforeEach(async () => {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.body.replaceWith(document.importNode(parsed.body, true));
  snapshot = await sampleSnapshot();
  readers = [];
  collect = async () => snapshot;
  downloads = [];
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("popup", () => {
  it("asks for a Google Maps tab when the active tab is elsewhere", async () => {
    const chrome = fakeChrome("https://example.com/", true);
    await mountPopup({ chrome, document, createReader });
    expect($("not-maps").hidden).toBe(false);
    expect($("export-form").hidden).toBe(true);
    $("open-maps").click();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://www.google.com/maps" });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("requests Google access in the click, then reads accounts", async () => {
    const chrome = fakeChrome("https://www.google.com/maps/@1,2,3z", false);
    await mountPopup({ chrome, document, createReader });
    expect($("access").hidden).toBe(false);
    $("allow-access").click();
    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: ["https://www.google.com/*"],
    });
    await vi.waitFor(() => expect(listBoxes()).toHaveLength(2));
    expect($("access").hidden).toBe(true);
  });

  it("reads accounts and lists, then downloads a Takeout ZIP", async () => {
    const chrome = fakeChrome("https://www.google.com/maps", true);
    await mountPopup({ chrome, document, createReader, now: () => new Date(2026, 9, 13) });

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      world: "ISOLATED",
      func: requestAccountBody,
    });
    const select = $<HTMLSelectElement>("account");
    expect(Array.from(select.options, (o) => o.textContent)).toEqual([
      "other@example.com",
      "me@example.com",
    ]);
    expect(select.value).toBe(ACCOUNT_ID);
    expect(readers[0]).toMatchObject({ slot: 1, followed: false, expectedAccountId: ACCOUNT_ID });
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ lastAccountId: ACCOUNT_ID });
    expect(listBoxes().map((box) => box.checked)).toEqual([true, true]);
    expect($("lists").textContent).toContain("3 entries · Owned");

    $("include-followed").click();
    await vi.waitFor(() => expect(listBoxes()).toHaveLength(3));
    expect(readers[1].followed).toBe(true);
    expect(listBoxes().map((box) => box.checked)).toEqual([true, true, false]);
    expect($("lists").textContent).toContain("⭐ Friend picks");

    $("export").click();
    await vi.waitFor(() => expect(statusText()).toBe("Exported 2 lists and 4 entries."));
    expect(readers[2]).toMatchObject({
      slot: 1,
      followed: true,
      expectedAccountId: ACCOUNT_ID,
      selectedListKeys: ["1:SampleWantToGo01", "3:SampleCoffee02"],
    });
    expect(downloads).toEqual(["google-maps-saved-2026-10-13.zip"]);
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0];
    expect(blob).toBeInstanceOf(Blob);
    expect((blob as Blob).type).toBe("application/zip");
    await vi.waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake"));
  });

  it("shows a read error as an alert and enables the controls again", async () => {
    const chrome = fakeChrome("https://www.google.com/maps", true);
    await mountPopup({ chrome, document, createReader });
    collect = async () => {
      throw new MapsError("changed", "The account or selected list changed during this read.");
    };
    $("export").click();
    expect($("cancel").hidden).toBe(false);
    expect($<HTMLButtonElement>("export").disabled).toBe(true);
    await vi.waitFor(() => expect($("status").getAttribute("role")).toBe("alert"));
    expect(statusText()).toBe("The account or selected list changed during this read.");
    expect($<HTMLButtonElement>("export").disabled).toBe(false);
    expect($("cancel").hidden).toBe(true);
    expect(downloads).toEqual([]);
  });
});
