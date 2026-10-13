import { MapsError, toTakeoutZip, type Progress } from "google-maps-saved";
import { exportFileName, exportMimeType } from "./export-file.js";
import { GOOGLE_ORIGINS, type ReaderFactory } from "./popup-controller.js";

/** Messages that the extension posts to a connected web app. */
export type ServiceMessage =
  | ({ kind: "PROGRESS" } & Progress)
  | {
      kind: "RESULT";
      fileName: string;
      mimeType: string;
      base64: string;
      lists: number;
      entries: number;
    }
  | { kind: "ERROR"; code: string; message: string }
  | { kind: "HELLO" };

/** The part of `chrome.runtime.Port` that the service uses. */
export interface ExternalPort {
  readonly sender?: { origin?: string; tab?: object };
  postMessage(message: ServiceMessage): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export type ExportServiceDeps = {
  /** Exact origins, for example `https://places.example.com`. */
  appOrigins: readonly string[];
  permissions: {
    contains(permissions: { origins: string[] }): Promise<boolean>;
  };
  storage: {
    local: { get(keys: string[]): Promise<Record<string, unknown>> };
  };
  createReader: ReaderFactory;
  now: () => Date;
};

const SETUP_ACCESS =
  "Open the Google Maps Saved extension on a Google Maps tab once to allow Google access and choose your account.";
const SETUP_ACCOUNT =
  "Open the Google Maps Saved extension on a Google Maps tab once to choose your account.";
const ACCOUNT_MOVED =
  "The remembered Google account is not at the same position any more. Open the Google Maps Saved extension on a Google Maps tab and choose your account again.";
const UNEXPECTED =
  "The export failed. Open the Google Maps Saved extension on a Google Maps tab and try an export there.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isExportRequest(message: unknown): boolean {
  return isRecord(message) && message.kind === "EXPORT";
}

function isSlot(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 20;
}

/** Returns standard base64 for `bytes`. */
function toBase64(bytes: Uint8Array): string {
  // String.fromCharCode takes each byte as one argument. Large chunks
  // overflow the call stack.
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Serves one `chrome.runtime.onConnectExternal` port. Accepts only a tab
 * whose origin is in `deps.appOrigins`, and runs at most one export.
 */
export function handleExternalPort(port: ExternalPort, deps: ExportServiceDeps): void {
  const origin = port.sender?.origin;
  if (origin === undefined || !deps.appOrigins.includes(origin) || port.sender?.tab === undefined) {
    port.disconnect();
    return;
  }

  const abort = new AbortController();
  let connected = true;
  let started = false;
  // postMessage throws on a disconnected port.
  const post = (message: ServiceMessage) => {
    if (connected) {
      port.postMessage(message);
    }
  };

  port.onDisconnect.addListener(() => {
    connected = false;
    abort.abort();
  });
  port.onMessage.addListener((message) => {
    // HELLO lets a page confirm that this exact origin is accepted. Chrome
    // exposes chrome.runtime on every port of a listed host, so the page
    // cannot know that from chrome.runtime alone.
    if (isRecord(message) && message.kind === "HELLO") {
      post({ kind: "HELLO" });
      return;
    }
    if (!isExportRequest(message)) {
      post({ kind: "ERROR", code: "protocol", message: 'Send { kind: "EXPORT" }.' });
      return;
    }
    if (started) {
      post({ kind: "ERROR", code: "protocol", message: "Send one EXPORT per connection." });
      return;
    }
    started = true;
    void runExport(deps, abort.signal, post).catch((error: unknown) => {
      post(errorMessage(error));
    });
  });
}

async function runExport(
  deps: ExportServiceDeps,
  signal: AbortSignal,
  post: (message: ServiceMessage) => void,
): Promise<void> {
  if (!(await deps.permissions.contains({ origins: GOOGLE_ORIGINS }))) {
    throw new MapsError("setup", SETUP_ACCESS);
  }
  const stored = await deps.storage.local.get([
    "lastAccountId",
    "lastAccountSlot",
    "extendedColumns",
  ]);
  const expectedAccountId = stored.lastAccountId;
  const slot = stored.lastAccountSlot;
  if (typeof expectedAccountId !== "string" || expectedAccountId === "" || !isSlot(slot)) {
    throw new MapsError("setup", SETUP_ACCOUNT);
  }
  const extended = stored.extendedColumns !== false;

  const { inventory } = await deps
    .createReader({ slot, followed: false, expectedAccountId, signal })
    .inventory();
  const selectedListKeys = inventory
    .filter((list) => list.relationship !== "followed")
    .map((list) => list.key);
  if (selectedListKeys.length === 0) {
    throw new MapsError("empty", "This account has no Saved lists.");
  }

  const snapshot = await deps
    .createReader({
      slot,
      followed: false,
      expectedAccountId,
      selectedListKeys,
      signal,
      // The MV3 worker stops after 30 s without events. Each PROGRESS
      // message resets that timer, so always post it, also when no page
      // shows it.
      progress: (p) =>
        post({
          kind: "PROGRESS",
          listsRead: p.listsRead,
          totalLists: p.totalLists,
          membershipsRead: p.membershipsRead,
        }),
    })
    .collect();

  const date = deps.now();
  post({
    kind: "RESULT",
    fileName: exportFileName("zip", date),
    mimeType: exportMimeType("zip"),
    base64: toBase64(toTakeoutZip(snapshot, { extended, date })),
    lists: snapshot.lists.length,
    entries: snapshot.memberships.length,
  });
}

function errorMessage(error: unknown): ServiceMessage {
  if (error instanceof MapsError) {
    return {
      kind: "ERROR",
      code: error.code,
      message: error.code === "account_mismatch" ? ACCOUNT_MOVED : error.message,
    };
  }
  console.error(error);
  return { kind: "ERROR", code: "unexpected", message: UNEXPECTED };
}
