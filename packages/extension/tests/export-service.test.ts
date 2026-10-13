import { MapsError, type CollectOptions, type Snapshot } from "google-maps-saved";
import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_ID, buildSnapshot } from "../../core/tests/fixture.js";
import {
  handleExternalPort,
  type ExportServiceDeps,
  type ExternalPort,
  type ServiceMessage,
} from "../src/export-service.js";
import type { Reader } from "../src/popup-controller.js";

const APP_ORIGIN = "http://localhost:3000";

function fakePort(sender: ExternalPort["sender"]) {
  const posted: ServiceMessage[] = [];
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  let open = true;
  const port = {
    sender,
    postMessage: vi.fn((message: ServiceMessage) => {
      if (!open) {
        throw new Error("Attempting to use a disconnected port object");
      }
      posted.push(message);
    }),
    disconnect: vi.fn(() => {
      open = false;
    }),
    onMessage: { addListener: (listener: (message: unknown) => void) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
  } satisfies ExternalPort;
  return {
    port,
    posted,
    send: (message: unknown) => messageListeners.forEach((listener) => listener(message)),
    close: () => {
      open = false;
      disconnectListeners.forEach((listener) => listener());
    },
  };
}

let snapshot: Snapshot;
let readers: CollectOptions[];
let collect: (options: CollectOptions) => Promise<Snapshot>;
let stored: Record<string, unknown>;
let granted: boolean;

function deps(): ExportServiceDeps & {
  permissions: { contains: ReturnType<typeof vi.fn> };
  createReader: ReturnType<typeof vi.fn>;
} {
  return {
    appOrigins: [APP_ORIGIN],
    permissions: { contains: vi.fn(async () => granted) },
    storage: { local: { get: vi.fn(async () => stored) } },
    createReader: vi.fn((options: CollectOptions): Reader => {
      readers.push(options);
      return {
        inventory: async () => ({
          googleAccountId: ACCOUNT_ID,
          requestedGroups: ["owned", "collaborative"],
          inventory: snapshot.inventory,
        }),
        collect: () => collect(options),
      };
    }),
    now: () => new Date(2026, 9, 13),
  };
}

const lastPost = (posted: ServiceMessage[]) => posted[posted.length - 1];

beforeEach(async () => {
  snapshot = await buildSnapshot([
    {
      id: "WantToGo01",
      type: 1,
      title: "Want to go",
      members: [
        { kind: "feature", parts: ["1", "2"], name: "Fish Market" },
        { kind: "coordinate", latitude: 35.6586, longitude: 139.7454, name: "Dropped pin" },
      ],
    },
    {
      id: "Coffee02",
      type: 3,
      title: "Coffee",
      members: [{ kind: "feature", parts: ["0", "3"], name: "Roasters" }],
    },
  ]);
  readers = [];
  collect = async (options) => {
    options.progress?.({ listsRead: 1, totalLists: 2, membershipsRead: 2 });
    return snapshot;
  };
  stored = { lastAccountId: ACCOUNT_ID, lastAccountSlot: 2 };
  granted = true;
});

describe("handleExternalPort", () => {
  it("disconnects a port from another origin without a read", () => {
    const d = deps();
    for (const sender of [
      { origin: "https://evil.example", tab: {} },
      { origin: "http://localhost:3001", tab: {} },
      { origin: APP_ORIGIN },
      undefined,
    ]) {
      const { port, send } = fakePort(sender);
      handleExternalPort(port, d);
      expect(port.disconnect).toHaveBeenCalled();
      send({ kind: "EXPORT" });
    }
    expect(d.permissions.contains).not.toHaveBeenCalled();
    expect(d.createReader).not.toHaveBeenCalled();
  });

  it("asks for setup when Google access is not granted", async () => {
    granted = false;
    const d = deps();
    const { port, posted, send } = fakePort({ origin: APP_ORIGIN, tab: {} });
    handleExternalPort(port, d);
    send({ kind: "EXPORT" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      kind: "ERROR",
      code: "setup",
      message:
        "Open the Google Maps Saved extension on a Google Maps tab once to allow Google access and choose your account.",
    });
    expect(d.permissions.contains).toHaveBeenCalledWith({ origins: ["https://www.google.com/*"] });
    expect(d.createReader).not.toHaveBeenCalled();
  });

  it("asks for setup when no account slot is stored", async () => {
    stored = { lastAccountId: ACCOUNT_ID };
    const d = deps();
    const { port, posted, send } = fakePort({ origin: APP_ORIGIN, tab: {} });
    handleExternalPort(port, d);
    send({ kind: "EXPORT" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      kind: "ERROR",
      code: "setup",
      message:
        "Open the Google Maps Saved extension on a Google Maps tab once to choose your account.",
    });
    expect(d.createReader).not.toHaveBeenCalled();
  });

  it("answers HELLO without starting an export", () => {
    const d = deps();
    const { port, posted, send } = fakePort({ origin: APP_ORIGIN, tab: {} });
    handleExternalPort(port, d);
    send({ kind: "HELLO" });
    expect(posted).toEqual([{ kind: "HELLO" }]);
    expect(d.createReader).not.toHaveBeenCalled();
  });

  it("rejects a message that is not an export request", () => {
    const { port, posted, send } = fakePort({ origin: APP_ORIGIN, tab: {} });
    handleExternalPort(port, deps());
    send({ kind: "PING" });
    expect(posted).toEqual([expect.objectContaining({ kind: "ERROR", code: "protocol" })]);
  });

  it("posts progress, then a Takeout ZIP as base64", async () => {
    const d = deps();
    const { port, posted, send } = fakePort({ origin: APP_ORIGIN, tab: {} });
    handleExternalPort(port, d);
    send({ kind: "EXPORT" });
    await vi.waitFor(() => expect(lastPost(posted)?.kind).toBe("RESULT"));

    expect(readers[0]).toMatchObject({ slot: 2, followed: false, expectedAccountId: ACCOUNT_ID });
    expect(readers[1]).toMatchObject({
      slot: 2,
      followed: false,
      expectedAccountId: ACCOUNT_ID,
      selectedListKeys: ["1:WantToGo01", "3:Coffee02"],
    });
    expect(posted[0]).toEqual({ kind: "PROGRESS", listsRead: 1, totalLists: 2, membershipsRead: 2 });
    const result = posted[1];
    if (result.kind !== "RESULT") {
      throw new Error("Expected a RESULT message.");
    }
    expect(result).toMatchObject({
      fileName: "google-maps-saved-2026-10-13.zip",
      mimeType: "application/zip",
      lists: 2,
      entries: 3,
    });
    const zip = await JSZip.loadAsync(Buffer.from(result.base64, "base64"));
    expect(Object.keys(zip.files)).toEqual([
      "Takeout/Saved/Want to go.csv",
      "Takeout/Saved/Coffee.csv",
    ]);
    const csv = await zip.file("Takeout/Saved/Want to go.csv")?.async("string");
    expect(csv?.split("\n")[0]).toBe("Title,Note,URL,Comment,Latitude,Longitude,Address");
    expect(JSON.parse(JSON.stringify(posted))).toEqual(posted);
  });

  it("leaves out the extended columns when the popup turned them off", async () => {
    stored = { ...stored, extendedColumns: false };
    const { port, posted, send } = fakePort({ origin: APP_ORIGIN, tab: {} });
    handleExternalPort(port, deps());
    send({ kind: "EXPORT" });
    await vi.waitFor(() => expect(lastPost(posted)?.kind).toBe("RESULT"));
    const result = lastPost(posted);
    if (result.kind !== "RESULT") {
      throw new Error("Expected a RESULT message.");
    }
    const zip = await JSZip.loadAsync(Buffer.from(result.base64, "base64"));
    const csv = await zip.file("Takeout/Saved/Coffee.csv")?.async("string");
    expect(csv?.split("\n")[0]).toBe("Title,Note,URL,Comment");
  });

  it("asks to choose the account again after an account mismatch", async () => {
    collect = async () => {
      throw new MapsError("account_mismatch", "Google returned a different account.");
    };
    const { port, posted, send } = fakePort({ origin: APP_ORIGIN, tab: {} });
    handleExternalPort(port, deps());
    send({ kind: "EXPORT" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      kind: "ERROR",
      code: "account_mismatch",
      message:
        "The remembered Google account is not at the same position any more. Open the Google Maps Saved extension on a Google Maps tab and choose your account again.",
    });
  });

  it("hides an unknown error behind a generic message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    collect = async () => {
      throw new TypeError("boom");
    };
    const { port, posted, send } = fakePort({ origin: APP_ORIGIN, tab: {} });
    handleExternalPort(port, deps());
    send({ kind: "EXPORT" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ kind: "ERROR", code: "unexpected" });
  });

  it("aborts the read when the page disconnects", async () => {
    let signal: AbortSignal | undefined;
    let settled = false;
    collect = (options) => {
      signal = options.signal;
      return new Promise<Snapshot>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          options.progress?.({ listsRead: 0, totalLists: 2, membershipsRead: 0 });
          settled = true;
          reject(new MapsError("cancelled", "The read was cancelled."));
        });
      });
    };
    const { port, posted, send, close } = fakePort({ origin: APP_ORIGIN, tab: {} });
    handleExternalPort(port, deps());
    send({ kind: "EXPORT" });
    await vi.waitFor(() => expect(signal).toBeDefined());
    close();
    expect(signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(settled).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });
});
