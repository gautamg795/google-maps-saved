import {
  ADAPTER_REVISION,
  LIMITS,
  MapsError,
  SCHEMA_VERSION,
  SNAPSHOT_FORMAT,
  listKey,
  validateSnapshot,
  type Snapshot,
  type SourceList,
} from "./snapshot.js";
import { decodeInventory, decodePage, decodeResponse } from "./decode.js";

const INVENTORY_PB = "!2m1!7e81!23m2!1i500!3b1!24m2!1i500!3b1!38m2!1i500!3b1";

/** Counts reported to `CollectOptions.progress` after each page and list. */
export type Progress = {
  listsRead: number;
  totalLists: number;
  membershipsRead: number;
};

/** Options for `GoogleReader`. */
export type CollectOptions = {
  /** Google `authuser` routing slot. Must be an integer from 0 to 20. */
  slot: number;
  /** Also read the followed list group. */
  followed: boolean;
  /** Stable Google account ID. Every inventory read must return this ID. */
  expectedAccountId?: string;
  /**
   * List keys to read, at most 100 distinct keys. The default is all owned
   * and collaborative lists.
   */
  selectedListKeys?: string[];
  /** Cancels the read. Pending pauses and requests stop at once. */
  signal: AbortSignal;
  progress?: (p: Progress) => void;
  /** Replaces the global `fetch`. The request must send Google cookies. */
  fetcher?: typeof fetch;
  /**
   * Called before each request attempt to get the current routing slot. Use
   * it when the slot of the same account can change during a read. The result
   * must be an integer from 0 to 20.
   */
  resolveSlot?: () => Promise<number>;
  /**
   * Called before and after each request attempt. Throw from it to stop the
   * read, for example when the caller's job expires.
   */
  checkpoint?: () => Promise<void>;
};

function abort(signal: AbortSignal) {
  if (signal.aborted)
    throw new MapsError("cancelled", "The read was cancelled.");
}

async function pause(ms: number, signal: AbortSignal) {
  abort(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(new MapsError("cancelled", "The read was cancelled."));
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Reads Google Maps Saved lists through the signed-in Maps web session.
 * The constructor throws `MapsError` "account_unknown" when `slot` is not an
 * integer from 0 to 20.
 */
export class GoogleReader {
  private lastRequest = 0;
  constructor(private options: CollectOptions) {
    if (
      !Number.isSafeInteger(options.slot) ||
      options.slot < 0 ||
      options.slot > 20
    )
      throw new MapsError(
        "account_unknown",
        "Google account routing could not be verified.",
      );
  }

  /**
   * Sends one GET request to www.google.com with credentials and returns the
   * decoded JSON array. Makes at most 3 attempts. Retries HTTP 429 and 5xx,
   * and obeys `Retry-After` (seconds or HTTP-date). Throws `MapsError`
   * "google_busy" when `Retry-After` is more than 10 s. The response body
   * must be at most 10 MiB of valid UTF-8.
   */
  async request(
    path: "/locationhistory/preview/mas" | "/maps/preview/entitylist/getlist",
    pb: string,
  ): Promise<unknown> {
    const { signal } = this.options;
    for (let attempt = 0; attempt < 3; attempt++) {
      await pause(Math.max(0, 200 - (Date.now() - this.lastRequest)), signal);
      this.lastRequest = Date.now();
      const controller = new AbortController();
      const forward = () => controller.abort();
      signal.addEventListener("abort", forward, { once: true });
      const timeout = setTimeout(forward, 20000);
      try {
        const slot = this.options.resolveSlot
          ? await this.options.resolveSlot()
          : this.options.slot;
        if (!Number.isSafeInteger(slot) || slot < 0 || slot > 20)
          throw new MapsError(
            "account_unknown",
            "Google account routing could not be verified.",
          );
        await this.options.checkpoint?.();
        const url = new URL(path, "https://www.google.com");
        url.search = new URLSearchParams({
          authuser: String(slot),
          hl: "en",
          gl: "us",
          pb,
        }).toString();
        const response = await (this.options.fetcher ?? fetch)(url, {
          credentials: "include",
          signal: controller.signal,
          redirect: "error",
          cache: "no-store",
        });
        await this.options.checkpoint?.();
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel();
          if (attempt === 2)
            throw new MapsError(
              "google_busy",
              "Google is temporarily unavailable. Retry later.",
            );
          const retry = response.headers.get("retry-after");
          const retryDate =
            retry && !/^\d+$/.test(retry) ? Date.parse(retry) : NaN;
          const seconds =
            retry && /^\d+$/.test(retry)
              ? Number(retry)
              : Number.isFinite(retryDate)
                ? Math.max(0, Math.ceil((retryDate - Date.now()) / 1000))
                : 1 + attempt;
          if (seconds > 10)
            throw new MapsError(
              "google_busy",
              "Google asked us to retry later. Try again in a few minutes.",
            );
          await pause(Math.max(1, seconds) * 1000, signal);
          continue;
        }
        if (!response.ok)
          throw new MapsError(
            "google_access",
            "Google did not allow this read. Check your sign-in.",
          );
        const reader = response.body?.getReader();
        if (!reader)
          throw new MapsError("schema", "Google returned an empty response.");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > LIMITS.bytes) {
              await reader.cancel();
              throw new MapsError(
                "too_large",
                "A Google response exceeds 10 MiB.",
              );
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
        let decoded: string;
        try {
          decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new MapsError(
            "schema",
            "Google returned invalid UTF-8. This response cannot be safely read.",
          );
        }
        return decodeResponse(decoded);
      } catch (e) {
        abort(signal);
        if (e instanceof MapsError) throw e;
        if (attempt === 2)
          throw new MapsError(
            "network",
            "The Google read was interrupted. Check your Google sign-in and retry.",
          );
        await pause((attempt + 1) * 1000, signal);
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", forward);
      }
    }
    throw new MapsError("network", "Google read failed.");
  }

  /**
   * Reads and decodes the list inventory. Throws `MapsError`
   * "account_mismatch" when `expectedAccountId` is set and Google returns a
   * different account.
   */
  async inventory() {
    const result = decodeInventory(
      await this.request("/locationhistory/preview/mas", INVENTORY_PB),
      this.options.followed,
    );
    if (
      this.options.expectedAccountId &&
      result.googleAccountId !== this.options.expectedAccountId
    )
      throw new MapsError(
        "account_mismatch",
        "Google returned a different account. Start a fresh read; nothing was exported.",
      );
    return result;
  }

  /**
   * Reads every selected list and returns a validated `Snapshot`. Reads the
   * inventory again before each list page and at the end. Throws `MapsError`
   * "changed" when the account, a selected list, or a list revision marker
   * changes during the read. Limits: at most 100 lists and 5,000 entries.
   */
  async collect(): Promise<Snapshot> {
    const startedAt = new Date().toISOString();
    const initial = await this.inventory();
    const selectedListKeys =
      this.options.selectedListKeys ??
      initial.inventory
        .filter((l) => l.relationship !== "followed")
        .map((l) => l.key);
    if (
      selectedListKeys.length > LIMITS.lists ||
      new Set(selectedListKeys).size !== selectedListKeys.length
    )
      throw new MapsError("too_large", "Choose at most 100 distinct lists.");
    const selected = selectedListKeys.map((k) => {
      const list = initial.inventory.find((l) => l.key === k);
      if (!list)
        throw new MapsError(
          "changed",
          "A selected list is no longer in the inventory.",
        );
      return list;
    });
    if (selected.reduce((n, l) => n + l.reportedCount, 0) > LIMITS.memberships)
      throw new MapsError(
        "too_large",
        "Selected lists exceed 5,000 saved entries.",
      );
    const stable = (a: SourceList, b: SourceList) =>
      JSON.stringify(a) === JSON.stringify(b);
    const memberships: Snapshot["memberships"] = [];
    const lists: Snapshot["lists"] = [];
    for (const list of selected) {
      // Google shows an unmaterialized default list as an owned row with a
      // count of zero and a null ID. There is no ID to send to getlist. The
      // final inventory check confirms that the list stays empty.
      if (
        list.id === `unmaterialized-default-${initial.googleAccountId}` &&
        [2, 3, 5, 6].includes(list.type) &&
        list.reportedCount === 0
      ) {
        lists.push({
          key: list.key,
          reportedCount: 0,
          retrievedCount: 0,
          complete: true,
        });
        this.options.progress?.({
          listsRead: lists.length,
          totalLists: selected.length,
          membershipsRead: memberships.length,
        });
        continue;
      }
      const seen = new Set<string>();
      let cursor = "";
      let listCount = 0;
      let pageMarker: string | null | undefined;
      do {
        const check = await this.inventory();
        const observed = check.inventory.find((l) => l.key === list.key);
        if (
          check.googleAccountId !== initial.googleAccountId ||
          !observed ||
          !stable(observed, list)
        )
          throw new MapsError(
            "changed",
            "The account or selected list changed during this read.",
          );
        listKey(list.id, list.type);
        let pb = `!1m4!1s${list.id}!2e${list.type}!3m1!1e1!2e2!3e2!4i500`;
        if (cursor) {
          if (!/^[A-Za-z0-9+/=_-]+$/.test(cursor))
            throw new MapsError(
              "schema",
              "Invalid Google continuation cursor.",
            );
          pb += `!5B${cursor.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
        }
        const page = await decodePage(
          await this.request("/maps/preview/entitylist/getlist", pb),
          list,
          listCount,
        );
        if (pageMarker !== undefined && pageMarker !== page.modifiedMarker)
          throw new MapsError(
            "changed",
            "Google changed a list while its pages were being read.",
          );
        pageMarker = page.modifiedMarker;
        if (page.cursor && (!page.members.length || seen.has(page.cursor)))
          throw new MapsError(
            "incomplete",
            "Google returned a repeated or empty continuation page.",
          );
        seen.add(page.cursor);
        cursor = page.cursor;
        listCount += page.members.length;
        if (
          listCount > list.reportedCount ||
          memberships.length + page.members.length > LIMITS.memberships
        )
          throw new MapsError(
            "incomplete",
            "Google returned more entries than expected.",
          );
        memberships.push(...page.members);
        this.options.progress?.({
          listsRead: lists.length,
          totalLists: selected.length,
          membershipsRead: memberships.length,
        });
      } while (cursor);
      if (listCount !== list.reportedCount)
        throw new MapsError(
          "incomplete",
          "Google did not return every entry in this list.",
        );
      lists.push({
        key: list.key,
        reportedCount: list.reportedCount,
        retrievedCount: listCount,
        complete: true,
      });
      this.options.progress?.({
        listsRead: lists.length,
        totalLists: selected.length,
        membershipsRead: memberships.length,
      });
    }
    const final = await this.inventory();
    if (
      final.googleAccountId !== initial.googleAccountId ||
      JSON.stringify(final.inventory) !== JSON.stringify(initial.inventory)
    )
      throw new MapsError(
        "changed",
        "Google inventory changed during the read. Retry for a consistent snapshot.",
      );
    return validateSnapshot({
      format: SNAPSHOT_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      adapterRevision: ADAPTER_REVISION,
      captureId: crypto.randomUUID(),
      startedAt,
      finishedAt: new Date().toISOString(),
      googleAccountId: initial.googleAccountId,
      inventoryComplete: true,
      requestedGroups: initial.requestedGroups,
      inventory: initial.inventory,
      selectedListKeys,
      lists,
      memberships,
    });
  }
}
