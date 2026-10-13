import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeAccounts, requestAccountBody } from "../src/accounts.js";
function row(
  email = "fixture@example.com",
  id = "123",
  valid: unknown = 1,
  signedout: unknown = null,
  verified: unknown = 1,
) {
  const r: unknown[] = Array(16).fill(null);
  r[0] = "gaia.l.a";
  r[3] = email;
  r[9] = valid;
  r[10] = id;
  r[14] = signedout;
  r[15] = verified;
  return r;
}
const body = (rows: unknown[]) =>
  ")]}'\n" + JSON.stringify(["gaia.l.a.r", rows]);
describe("verified Google account discovery", () => {
  it("reads actual emails and stable IDs while preserving raw routing slots", () => {
    expect(
      decodeAccounts(
        body([
          row("signedout@example.com", "9", 1, 1),
          row("selected@example.com", "123"),
          row("expired@example.com", "456", 0),
        ]),
      ),
    ).toEqual([
      { googleEmail: "selected@example.com", googleAccountId: "123", slot: 1 },
    ]);
  });
  it("accepts evidenced null not-signed-out flags, rejecting unknown and unverified statuses", () => {
    expect(
      decodeAccounts(
        body([row("selected@example.com", "123", true, false, true)]),
      ),
    ).toHaveLength(1);
    expect(
      decodeAccounts(body([row("unverified@example.com", "123", 1, null, 0)])),
    ).toEqual([]);
    expect(() =>
      decodeAccounts(
        body([row("selected@example.com", "123", 1, "unknown", 1)]),
      ),
    ).toThrow("status");
    expect(() => decodeAccounts(body([row("not an email", "123")]))).toThrow(
      "email",
    );
    expect(() => decodeAccounts(body([row(), row()]))).toThrow("duplicate");
    expect(() => decodeAccounts('["other",[]]')).toThrow("unsupported");
  });
  it("uses a fixed credentialed read endpoint with no cookie access or redirect", async () => {
    const fetcher = vi.fn(async () => new Response(body([row()])));
    vi.stubGlobal("fetch", fetcher);
    const resultBody = await requestAccountBody();
    const result = decodeAccounts("body" in resultBody ? resultBody.body : "");
    expect(result[0].googleEmail).toBe("fixture@example.com");
    expect(fetcher).toHaveBeenCalledWith(
      "https://accounts.google.com/ListAccounts?json=standard&source=ChromiumBrowser",
      expect.objectContaining({
        method: "POST",
        body: " ",
        credentials: "include",
        redirect: "error",
        cache: "no-store",
      }),
    );
  });
  it("rejects malformed text and oversized account responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([0xc3, 0x28]))),
    );
    expect(await requestAccountBody()).toEqual({ error: "google_access" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(1024 * 1024 + 1))),
    );
    expect(await requestAccountBody()).toEqual({ error: "too_large" });
  });
});

afterEach(() => vi.unstubAllGlobals());
