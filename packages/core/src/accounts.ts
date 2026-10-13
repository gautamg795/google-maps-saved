import { MapsError, accountId, text } from "./snapshot.js";
import { decodeResponse } from "./decode.js";

/**
 * A signed-in, valid, verified Google account from ListAccounts.
 * `slot` is the `authuser` routing index. It is a routing hint only. Do not
 * store it as an account identity, because it can change.
 */
export type GoogleAccount = {
  googleAccountId: string;
  googleEmail: string;
  slot: number;
};

const yes = (v: unknown) => v === 1 || v === true;
const no = (v: unknown) => v === 0 || v === false || v === null;

/**
 * Returns `value` when it is an email address of at most 320 bytes.
 * Throws `MapsError` "account_unknown" otherwise.
 */
export function googleEmail(value: unknown): string {
  const email = text(value, "Google account email", 320);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))
    throw new MapsError(
      "account_unknown",
      "Google did not return a verified account email.",
    );
  return email;
}

/**
 * Decodes a ListAccounts response body (from `requestAccountBody`). Returns
 * only accounts that are valid, not signed out, and verified. Throws
 * `MapsError` "account_unknown" on an unknown status value, more than 21
 * rows, or a repeated account ID.
 */
export function decodeAccounts(body: string): GoogleAccount[] {
  const root = decodeResponse(body);
  if (
    !Array.isArray(root) ||
    root[0] !== "gaia.l.a.r" ||
    !Array.isArray(root[1]) ||
    root[1].length > 21
  )
    throw new MapsError(
      "account_unknown",
      "Google returned an unsupported account list. Sign in to Google and retry.",
    );
  const accounts: GoogleAccount[] = [];
  // Row fields agree with Chromium's legacy ListAccounts parser and with a
  // captured two-account response: 3 email, 9 valid, 10 account ID,
  // 14 signed out, 15 verified.
  root[1].forEach((row: unknown, slot: number) => {
    if (
      !Array.isArray(row) ||
      row[0] !== "gaia.l.a" ||
      row.length < 16 ||
      ![yes(row[9]), no(row[9])].some(Boolean) ||
      ![yes(row[14]), no(row[14])].some(Boolean) ||
      ![yes(row[15]), no(row[15])].some(Boolean)
    )
      throw new MapsError(
        "account_unknown",
        "Google account status could not be verified. Retry after signing in.",
      );
    if (!yes(row[9]) || !no(row[14]) || !yes(row[15])) return;
    accounts.push({
      googleAccountId: accountId(row[10]),
      googleEmail: googleEmail(row[3]),
      slot,
    });
  });
  if (new Set(accounts.map((a) => a.googleAccountId)).size !== accounts.length)
    throw new MapsError(
      "account_unknown",
      "Google returned duplicate account identities.",
    );
  return accounts;
}

/**
 * Fetches the ListAccounts body with the page's Google cookies. Pass it as
 * `func` to `chrome.scripting.executeScript` on a Google Maps tab; the same
 * fetch from the extension context is rejected. Chrome serializes the function
 * with toString(), so it must not reference imports or module-level values.
 * Returns `{ error }` on a non-OK response, a body over 1 MiB, invalid UTF-8,
 * or a 20 s timeout.
 */
export async function requestAccountBody(): Promise<
  { body: string } | { error: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(
      "https://accounts.google.com/ListAccounts?json=standard&source=ChromiumBrowser",
      {
        method: "POST",
        body: " ",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      },
    );
    if (!response.ok) return { error: "google_access" };
    const reader = response.body?.getReader();
    if (!reader) return { error: "empty" };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 1024 * 1024) {
          await reader.cancel();
          return { error: "too_large" };
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return { body: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { error: "google_access" };
  } finally {
    clearTimeout(timer);
  }
}
