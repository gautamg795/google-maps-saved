import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { decodeAccounts, decodeInventory, decodePage, decodeResponse } from "../src/index.js";

const body = (name: string) =>
  readFile(new URL(`./fixtures/${name}-response.json`, import.meta.url), "utf8");

async function inventory() {
  return decodeInventory(decodeResponse(await body("inventory")), false);
}

async function largeList() {
  const result = await inventory();
  return result.inventory.find((list) => list.key === "3:Redacted5")!;
}

describe("redacted Google response captures", () => {
  it("decodes the inventory's account, relationships, and list counts", async () => {
    const result = await inventory();
    expect(result.googleAccountId).toBe("100000000000000000001");
    expect(result.requestedGroups).toEqual(["owned", "collaborative"]);
    expect(result.inventory).toHaveLength(18);
    expect(result.inventory.reduce((sum, list) => sum + list.reportedCount, 0)).toBe(1115);
    expect(result.inventory.find((list) => list.key === "3:Redacted5"))
      .toMatchObject({ type: 3, relationship: "owned", reportedCount: 591 });
  });

  it("decodes the 500-entry page and preserves its continuation", async () => {
    const page = await decodePage(decodeResponse(await body("getlist-continuation")), await largeList(), 0);
    expect(page.members).toHaveLength(500);
    expect(page.cursor).not.toBe("");
    expect(page.members[0]).toMatchObject({
      name: "Redacted103", identityKind: "feature", cid: "18445744073709551608", position: 0,
    });
    expect(page.members[499].position).toBe(499);
  });

  it("decodes the terminal 91-entry page with the continuation offset", async () => {
    const page = await decodePage(decodeResponse(await body("getlist-terminal")), await largeList(), 500);
    expect(page.members).toHaveLength(91);
    expect(page.cursor).toBe("");
    expect(page.members[0]).toMatchObject({ name: "Redacted2040", note: "Redacted2041", position: 500 });
    expect(page.members[90].position).toBe(590);
  });

  it("decodes both signed-in accounts with email and routing slot", async () => {
    expect(decodeAccounts(await body("listaccounts"))).toEqual([
      { googleAccountId: "100000000000000000001", googleEmail: "account2373@example.com", slot: 0 },
      { googleAccountId: "100000000000000000007", googleEmail: "account2376@example.com", slot: 1 },
    ]);
  });
});
