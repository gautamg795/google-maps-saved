import {
  GoogleReader,
  MapsError,
  decodeAccounts,
  requestAccountBody,
  type CollectOptions,
  type GoogleAccount,
  type Progress,
  type Relationship,
  type SourceList,
} from "google-maps-saved";
import { exportFile, type ExportFile, type ExportFormat } from "./export-file.js";
import { isMapsUrl } from "./maps-tab.js";
import { carrySelection, defaultSelectedKeys, selectionProblem } from "./selection.js";

export const GOOGLE_ORIGINS = ["https://www.google.com/*"];
export const MAPS_URL = "https://www.google.com/maps";

export type AccountBodyResult = Awaited<ReturnType<typeof requestAccountBody>>;

/** The part of the `chrome` API that the popup uses. */
export interface ChromeApi {
  tabs: {
    query(info: {
      active: true;
      currentWindow: true;
    }): Promise<Array<{ id?: number; url?: string }>>;
    create(properties: { url: string }): Promise<unknown>;
  };
  permissions: {
    contains(permissions: { origins: string[] }): Promise<boolean>;
    request(permissions: { origins: string[] }): Promise<boolean>;
  };
  scripting: {
    executeScript(injection: {
      target: { tabId: number };
      world: "ISOLATED";
      func: typeof requestAccountBody;
    }): Promise<Array<{ result?: AccountBodyResult }>>;
  };
  storage: {
    local: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

export type Reader = Pick<GoogleReader, "inventory" | "collect">;
export type ReaderFactory = (options: CollectOptions) => Reader;

export type PopupDeps = {
  chrome: ChromeApi;
  document: Document;
  createReader?: ReaderFactory;
  now?: () => Date;
};

const GENERIC_ERROR =
  "Something went wrong. Reload the Google Maps tab, then open this popup again.";

const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  owned: "Owned",
  collaborative: "Collaborative",
  followed: "Followed",
};

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function byId<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  id: string,
  tag: K,
): HTMLElementTagNameMap[K] {
  const element = doc.getElementById(id);
  if (element === null || element.tagName.toLowerCase() !== tag) {
    throw new Error(`The popup has no <${tag} id="${id}">.`);
  }
  return element as HTMLElementTagNameMap[K];
}

type Busy = "idle" | "inventory" | "export";

export class PopupController {
  private readonly chrome: ChromeApi;
  private readonly doc: Document;
  private readonly createReader: ReaderFactory;
  private readonly now: () => Date;

  private readonly notMaps: HTMLElement;
  private readonly access: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly accountSelect: HTMLSelectElement;
  private readonly includeFollowed: HTMLInputElement;
  private readonly listsBox: HTMLDivElement;
  private readonly reloadButton: HTMLButtonElement;
  private readonly formatInputs: HTMLInputElement[];
  private readonly extended: HTMLInputElement;
  private readonly exportButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly allowButton: HTMLButtonElement;
  private readonly statusLine: HTMLElement;

  private tabId = 0;
  private storedAccountId: string | null = null;
  private accounts: GoogleAccount[] = [];
  private account: GoogleAccount | null = null;
  /** Inventory for `listsAccountId`, read with `listsFollowed`. */
  private lists: SourceList[] = [];
  private listsAccountId: string | null = null;
  private listsFollowed = false;
  private inventoryLoaded = false;
  private checked = new Set<string>();
  private busy: Busy = "idle";
  private abort: AbortController | null = null;

  constructor(deps: PopupDeps) {
    this.chrome = deps.chrome;
    this.doc = deps.document;
    this.createReader = deps.createReader ?? ((options) => new GoogleReader(options));
    this.now = deps.now ?? (() => new Date());

    const doc = this.doc;
    this.notMaps = byId(doc, "not-maps", "section");
    this.access = byId(doc, "access", "section");
    this.form = byId(doc, "export-form", "form");
    this.accountSelect = byId(doc, "account", "select");
    this.includeFollowed = byId(doc, "include-followed", "input");
    this.listsBox = byId(doc, "lists", "div");
    this.reloadButton = byId(doc, "reload", "button");
    this.extended = byId(doc, "extended", "input");
    this.exportButton = byId(doc, "export", "button");
    this.cancelButton = byId(doc, "cancel", "button");
    this.allowButton = byId(doc, "allow-access", "button");
    this.statusLine = byId(doc, "status", "p");
    this.formatInputs = Array.from(
      this.form.querySelectorAll<HTMLInputElement>('input[name="format"]'),
    );

    byId(doc, "open-maps", "button").addEventListener("click", () => {
      void this.chrome.tabs.create({ url: MAPS_URL }).catch((error: unknown) => this.fail(error));
    });
    this.allowButton.addEventListener("click", () => this.requestAccess());
    this.accountSelect.addEventListener("change", () => {
      this.account =
        this.accounts.find((a) => a.googleAccountId === this.accountSelect.value) ?? null;
      void this.loadInventory();
    });
    this.includeFollowed.addEventListener("change", () => void this.loadInventory());
    this.reloadButton.addEventListener("click", () => void this.loadInventory());
    for (const input of this.formatInputs) {
      input.addEventListener("change", () => this.sync());
    }
    this.extended.addEventListener("change", () => {
      void this.chrome.storage.local
        .set({ extendedColumns: this.extended.checked })
        .catch((error: unknown) => this.fail(error));
    });
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.exportSelected();
    });
    this.cancelButton.addEventListener("click", () => this.abort?.abort());
  }

  /** Runs the flow up to the first inventory. Never rejects. */
  async start(): Promise<void> {
    try {
      const [tab] = await this.chrome.tabs.query({ active: true, currentWindow: true });
      if (tab === undefined || tab.id === undefined || !isMapsUrl(tab.url)) {
        this.notMaps.hidden = false;
        return;
      }
      this.tabId = tab.id;
      const stored = await this.chrome.storage.local.get(["lastAccountId", "extendedColumns"]);
      this.storedAccountId =
        typeof stored.lastAccountId === "string" ? stored.lastAccountId : null;
      this.extended.checked = stored.extendedColumns !== false;
      if (await this.chrome.permissions.contains({ origins: GOOGLE_ORIGINS })) {
        await this.discoverAccounts();
      } else {
        this.access.hidden = false;
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private requestAccess(): void {
    // permissions.request needs the user gesture. Call it before any await.
    const request = this.chrome.permissions.request({ origins: GOOGLE_ORIGINS });
    this.allowButton.disabled = true;
    void request
      .then(async (granted) => {
        if (!granted) {
          this.showAlert("Google access is necessary to read your Saved lists.");
          return;
        }
        this.access.hidden = true;
        await this.discoverAccounts();
      })
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        this.allowButton.disabled = false;
      });
  }

  private async discoverAccounts(): Promise<void> {
    this.showStatus("Finding your Google accounts…");
    const results = await this.chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      world: "ISOLATED",
      // Pass the imported function reference. Do not wrap it in another
      // function: Chrome serializes `func` with toString() and runs only
      // that source in the Maps document.
      func: requestAccountBody,
    });
    const result = results[0]?.result;
    if (result === undefined || "error" in result) {
      throw new MapsError(
        "account_unknown",
        "Google did not return your accounts. Make sure that you are signed in to Google, then open this popup again.",
      );
    }
    this.accounts = decodeAccounts(result.body);
    if (this.accounts.length === 0) {
      throw new MapsError(
        "account_unknown",
        "No signed-in Google account was found. Sign in to Google in this Chrome profile, then open this popup again.",
      );
    }
    this.account =
      this.accounts.length === 1
        ? this.accounts[0]
        : (this.accounts.find((a) => a.googleAccountId === this.storedAccountId) ?? null);
    this.renderAccounts();
    this.form.hidden = false;
    this.showStatus(this.account === null ? "Choose a Google account." : "");
    this.sync();
    if (this.account !== null) {
      await this.loadInventory();
    }
  }

  private renderAccounts(): void {
    const options: HTMLOptionElement[] = [];
    if (this.account === null) {
      const placeholder = this.doc.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose an account";
      placeholder.disabled = true;
      placeholder.selected = true;
      options.push(placeholder);
    }
    for (const account of this.accounts) {
      const option = this.doc.createElement("option");
      option.value = account.googleAccountId;
      option.textContent = account.googleEmail;
      option.selected = account === this.account;
      options.push(option);
    }
    this.accountSelect.replaceChildren(...options);
  }

  private async loadInventory(): Promise<void> {
    const account = this.account;
    if (account === null || this.busy !== "idle") {
      return;
    }
    this.accountSelect.querySelector('option[value=""]')?.remove();
    const followed = this.includeFollowed.checked;
    const previous = this.listsAccountId === account.googleAccountId ? this.lists : [];
    const checked = this.checked;
    this.lists = [];
    this.inventoryLoaded = false;
    this.renderLists();
    const signal = this.begin("inventory");
    this.showStatus(`Reading lists for ${account.googleEmail}…`);
    try {
      await this.chrome.storage.local.set({ lastAccountId: account.googleAccountId });
      const result = await this.createReader({
        slot: account.slot,
        followed,
        expectedAccountId: account.googleAccountId,
        signal,
      }).inventory();
      this.lists = result.inventory;
      this.listsAccountId = account.googleAccountId;
      this.listsFollowed = followed;
      this.checked =
        previous.length > 0
          ? carrySelection(previous, checked, this.lists)
          : defaultSelectedKeys(this.lists);
      this.inventoryLoaded = true;
      this.showStatus(`Found ${plural(this.lists.length, "list", "lists")}.`);
    } catch (error) {
      this.fail(error);
    } finally {
      this.end();
      this.renderLists();
    }
  }

  private renderLists(): void {
    if (this.inventoryLoaded && this.lists.length === 0) {
      const empty = this.doc.createElement("p");
      empty.textContent = "This account has no Saved lists.";
      this.listsBox.replaceChildren(empty);
      return;
    }
    this.listsBox.replaceChildren(
      ...this.lists.map((list) => {
        const row = this.doc.createElement("label");
        row.className = "list-row";
        const box = this.doc.createElement("input");
        box.type = "checkbox";
        box.value = list.key;
        box.checked = this.checked.has(list.key);
        box.disabled = this.busy !== "idle";
        box.addEventListener("change", () => {
          if (box.checked) {
            this.checked.add(list.key);
          } else {
            this.checked.delete(list.key);
          }
        });
        const text = this.doc.createElement("span");
        const title = this.doc.createElement("strong");
        const name = list.title.trim() === "" ? "Untitled list" : list.title;
        title.textContent = list.emoji === "" ? name : `${list.emoji} ${name}`;
        const meta = this.doc.createElement("span");
        meta.className = "list-meta";
        meta.textContent = `${plural(list.reportedCount, "entry", "entries")} · ${RELATIONSHIP_LABELS[list.relationship]}`;
        text.append(title, meta);
        row.append(box, text);
        return row;
      }),
    );
  }

  private format(): ExportFormat {
    return this.formatInputs.find((input) => input.checked)?.value === "json" ? "json" : "zip";
  }

  private async exportSelected(): Promise<void> {
    const account = this.account;
    if (account === null || !this.inventoryLoaded || this.busy !== "idle") {
      return;
    }
    const selected = this.lists.filter((list) => this.checked.has(list.key));
    const problem = selectionProblem(selected);
    if (problem !== null) {
      this.showAlert(problem);
      return;
    }
    const format = this.format();
    const extended = this.extended.checked;
    const signal = this.begin("export");
    this.showProgress({ listsRead: 0, totalLists: selected.length, membershipsRead: 0 });
    try {
      const snapshot = await this.createReader({
        slot: account.slot,
        followed: this.listsFollowed,
        expectedAccountId: account.googleAccountId,
        selectedListKeys: selected.map((list) => list.key),
        signal,
        progress: (p) => this.showProgress(p),
      }).collect();
      this.download(exportFile(snapshot, format, { extended, date: this.now() }));
      this.showStatus(
        `Exported ${plural(snapshot.lists.length, "list", "lists")} and ${plural(snapshot.memberships.length, "entry", "entries")}.`,
      );
    } catch (error) {
      this.fail(error);
    } finally {
      this.end();
    }
  }

  private download(file: ExportFile): void {
    const url = URL.createObjectURL(file.blob);
    const link = this.doc.createElement("a");
    link.href = url;
    link.download = file.name;
    link.hidden = true;
    this.doc.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private showProgress(p: Progress): void {
    this.showStatus(
      `Read ${p.listsRead.toLocaleString("en-US")} of ${plural(p.totalLists, "list", "lists")} · ${plural(p.membershipsRead, "entry", "entries")}`,
    );
  }

  private begin(busy: Exclude<Busy, "idle">): AbortSignal {
    this.busy = busy;
    this.abort = new AbortController();
    this.sync();
    return this.abort.signal;
  }

  private end(): void {
    this.busy = "idle";
    this.abort = null;
    this.sync();
  }

  private sync(): void {
    const reading = this.busy !== "idle";
    this.accountSelect.disabled = reading;
    this.includeFollowed.disabled = reading || this.account === null;
    for (const box of this.listsBox.querySelectorAll("input")) {
      box.disabled = reading;
    }
    this.reloadButton.hidden = reading || this.account === null || this.inventoryLoaded;
    for (const input of this.formatInputs) {
      input.disabled = this.busy === "export";
    }
    this.extended.disabled = this.busy === "export" || this.format() === "json";
    this.exportButton.disabled = reading || !this.inventoryLoaded;
    this.cancelButton.hidden = !reading;
  }

  private showStatus(message: string): void {
    this.statusLine.removeAttribute("role");
    this.statusLine.textContent = message;
  }

  private showAlert(message: string): void {
    this.statusLine.setAttribute("role", "alert");
    this.statusLine.textContent = message;
  }

  private fail(error: unknown): void {
    if (error instanceof MapsError && error.code === "cancelled") {
      this.showStatus(error.message);
      return;
    }
    if (error instanceof MapsError) {
      this.showAlert(error.message);
      return;
    }
    console.error(error);
    this.showAlert(GENERIC_ERROR);
  }
}

/** Connects the popup markup in `deps.document` and starts the flow. */
export function mountPopup(deps: PopupDeps): Promise<void> {
  return new PopupController(deps).start();
}
