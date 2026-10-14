#!/usr/bin/env node
// Renders the Chrome Web Store images: the icons in public/icons/, three
// 1280x800 popup screenshots in store/screenshots/, and store/promo-440x280.png.
// The popup runs from dist/ with a fake `chrome` API and fake Google
// responses. All accounts, lists, and places are fictional.
//
// One-time setup, outside the repository (Playwright 1.63.0 uses Chromium revision 1243):
//   mkdir -p /tmp/gms-store-tools && cd /tmp/gms-store-tools && npm init -y && npm i playwright@1.63.0 && npx playwright install chromium
// Then, from the repository root:
//   npm run build && node packages/extension/scripts/store-screenshots.mjs
// Set PLAYWRIGHT_DIR when Playwright is in a different directory.
//
// The fake responses use the positional shapes of packages/core/tests/google.test.ts.
// Update them when the decoder changes.
import { access, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(extensionDir, "..", "..");
const distPopup = join(extensionDir, "dist", "popup.html");
const iconsDir = join(extensionDir, "public", "icons");
const storeDir = join(repoDir, "store");
const playwrightDir = resolve(process.env.PLAYWRIGHT_DIR ?? "/tmp/gms-store-tools");

const ICON_SIZES = [16, 32, 48, 128];
const SHOT = { width: 1280, height: 800 };
const POPUP_MAX_HEIGHT = 600;
const PROMO = { width: 440, height: 280 };

const ACCOUNT_ID = "100000000000000000001";
const WORK_ACCOUNT_ID = "100000000000000000002";
const FRIEND_ACCOUNT_ID = "100000000000000000077";
const ACCOUNTS = [
  { email: "maya@example.com", id: ACCOUNT_ID },
  { email: "maya.work@example.com", id: WORK_ACCOUNT_ID },
];
// [id, title, count, relationship, latitude, longitude]
// The list box shows about four rows without scrolling. Keep UNCHECKED_TITLE in the first three.
const LISTS = [
  ["WantToGo001", "Want to go", 186, "owned", 40.7128, -74.006],
  ["Tokyo2026002", "Tokyo 2026", 47, "owned", 35.6762, 139.6503],
  ["DateNights003", "Date nights", 9, "owned", 41.8781, -87.6298],
  ["Coffee004", "Coffee", 23, "owned", 45.5152, -122.6784],
  ["LisbonWknd005", "Lisbon weekend", 14, "owned", 38.7223, -9.1393],
  ["Hikes006", "Hikes", 31, "owned", 46.8523, -121.7603],
  ["Favorites007", "Favorites", 64, "owned", 37.7749, -122.4194],
  ["TeamLunch008", "Team lunch spots", 18, "collaborative", 47.6062, -122.3321],
];
const UNCHECKED_TITLE = "Date nights";
// The page of the third selected list waits until the reading screenshot is taken.
const HELD_LIST_ID = LISTS.filter(([, title]) => title !== UNCHECKED_TITLE)[2][0];

function loadPlaywright() {
  try {
    return createRequire(join(playwrightDir, "package.json"))("playwright");
  } catch {
    throw new Error(
      `Playwright is not installed in ${playwrightDir}. See the setup line at the top of this script.`,
    );
  }
}

const xssi = (value) => `)]}'\n${JSON.stringify(value)}`;

function accountRow(email, id) {
  const row = Array(16).fill(null);
  row[0] = "gaia.l.a";
  row[3] = email;
  row[9] = 1;
  row[10] = id;
  row[15] = 1;
  return row;
}

function listRow(id, total, owner, title) {
  const r = [];
  r[0] = [id, 1];
  r[3] = [null, null, owner];
  r[4] = title;
  r[5] = "";
  r[8] = [];
  r[11] = [1760000000, 0];
  r[12] = total;
  r[17] = "";
  return r;
}

function owner(relationship) {
  return relationship === "owned" ? ACCOUNT_ID : FRIEND_ACCOUNT_ID;
}

function member(listIndex, index, title, latitude, longitude) {
  const p = [];
  const dLat = ((index * 37) % 100) / 2000;
  const dLng = ((index * 53) % 100) / 2000;
  p[1] = [
    null,
    null,
    "Name/address",
    null,
    `${100 + index} Example Street`,
    [null, null, latitude + dLat, longitude + dLng],
    [String(listIndex + 1), String(index + 1)],
  ];
  p[2] = `${title} place ${index + 1}`;
  p[3] = "";
  return p;
}

function fakeGoogle() {
  const rows = LISTS.map(([id, title, total, relationship]) =>
    listRow(id, total, owner(relationship), title),
  );
  const inventory = [];
  inventory[29] = [null, null, null, rows.filter((_, i) => LISTS[i][3] === "owned")];
  inventory[43] = [null, null, null, rows.filter((_, i) => LISTS[i][3] === "collaborative")];
  inventory[30] = [null, null, null, []];
  const pages = {};
  LISTS.forEach(([id, title, total, relationship, latitude, longitude], listIndex) => {
    const row = listRow(id, total, owner(relationship), title);
    row[8] = Array.from({ length: total }, (_, i) =>
      member(listIndex, i, title, latitude, longitude),
    );
    pages[id] = xssi([row, ""]);
  });
  return {
    accountId: ACCOUNT_ID,
    accountsBody: xssi(["gaia.l.a.r", ACCOUNTS.map((a) => accountRow(a.email, a.id))]),
    inventoryBody: xssi(inventory),
    pages,
    heldListId: HELD_LIST_ID,
  };
}

/** Runs in the popup page before its scripts. It must not reference module scope. */
function installFakes({ accountId, accountsBody, inventoryBody, pages, heldListId }) {
  const stored = { lastAccountId: accountId };
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  window.__releaseHeldList = () => release();
  window.__heldListWaiting = false;
  window.__downloads = [];
  const chromeApi = {
    tabs: {
      query: async () => [{ id: 1, url: "https://www.google.com/maps/@38.7223,-9.1393,13z" }],
      create: async () => ({}),
    },
    permissions: {
      contains: async () => true,
      request: async () => true,
    },
    scripting: {
      executeScript: async () => [{ result: { body: accountsBody } }],
    },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]])),
        set: async (items) => {
          Object.assign(stored, items);
        },
      },
    },
  };
  Object.defineProperty(window, "chrome", { value: chromeApi, configurable: true, writable: true });
  const ok = (text) => new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  window.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.origin === "https://www.google.com" && url.pathname === "/locationhistory/preview/mas") {
      return ok(inventoryBody);
    }
    if (url.origin === "https://www.google.com" && url.pathname === "/maps/preview/entitylist/getlist") {
      const id = /^!1m4!1s([^!]+)!/.exec(url.searchParams.get("pb") ?? "")?.[1];
      if (id === heldListId) {
        window.__heldListWaiting = true;
        await held;
      }
      if (id !== undefined && id in pages) return ok(pages[id]);
    }
    throw new TypeError(`No fake response for ${url.href}`);
  };
  URL.createObjectURL = () => "blob:store-screenshot";
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () {
    window.__downloads.push(this.download);
  };
}

// Puts the popup at its natural width in the middle of a white 1280x800 page.
const FRAME_CSS = `
html {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #ffffff;
}
body {
  flex: none;
  border-radius: 10px;
  box-shadow:
    0 1px 3px rgba(32, 42, 45, 0.12),
    0 18px 48px rgba(32, 42, 45, 0.16);
}
`;

async function renderIcons(browser) {
  const svg = await readFile(join(extensionDir, "public", "icon.svg"));
  const src = `data:image/svg+xml;base64,${svg.toString("base64")}`;
  await mkdir(iconsDir, { recursive: true });
  for (const size of ICON_SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}img{display:block}</style><img width="${size}" height="${size}" src="${src}">`,
    );
    await page.locator("img").evaluate((img) => img.decode());
    await page.screenshot({ path: join(iconsDir, `icon-${size}.png`), omitBackground: true });
    await page.close();
  }
}

async function waitForStatus(page, pattern) {
  await page.waitForFunction(
    (source) => new RegExp(source).test(document.getElementById("status")?.textContent ?? ""),
    pattern.source,
  );
}

async function shoot(page, name) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  const height = await page.evaluate(() => document.body.getBoundingClientRect().height);
  // Chrome caps an action popup at 600 px and adds a scrollbar above that.
  if (height > POPUP_MAX_HEIGHT) {
    throw new Error(`The popup is ${height}px high in ${name}; Chrome shows a scrollbar above ${POPUP_MAX_HEIGHT}px.`);
  }
  console.log(`${name}: popup height ${height}px`);
  await page.screenshot({
    path: join(storeDir, "screenshots", name),
    animations: "disabled",
    caret: "hide",
  });
}

async function renderScreenshots(browser) {
  await mkdir(join(storeDir, "screenshots"), { recursive: true });
  const context = await browser.newContext({
    viewport: SHOT,
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "en-US",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await context.addInitScript(installFakes, fakeGoogle());
  await page.goto(pathToFileURL(distPopup).href);
  await page.addStyleTag({ content: FRAME_CSS });

  await waitForStatus(page, /^Found \d+ lists\.$/);
  if (!(await page.evaluate(() => document.fonts.check('650 14px "Geist"')))) {
    throw new Error("The Geist font did not load in the popup.");
  }
  await page.locator("#lists label", { hasText: UNCHECKED_TITLE }).locator("input").uncheck();
  // uncheck() can scroll the list box.
  await page.evaluate(() => {
    document.getElementById("lists").scrollTop = 0;
  });
  await shoot(page, "01-choose-lists.png");

  await page.click("#export");
  await page.waitForFunction(() => window.__heldListWaiting === true);
  await waitForStatus(page, /^Read 2 of /);
  await shoot(page, "02-reading.png");

  await page.evaluate(() => window.__releaseHeldList());
  await waitForStatus(page, /^Exported /);
  const downloads = await page.evaluate(() => window.__downloads);
  if (downloads.length !== 1) {
    throw new Error(`Expected one download, got ${JSON.stringify(downloads)}.`);
  }
  await shoot(page, "03-done.png");
  await context.close();
  if (errors.length > 0) {
    throw new Error(`The popup logged errors:\n${errors.join("\n")}`);
  }
}

async function renderPromo(browser) {
  const font = await readFile(join(extensionDir, "public", "geist-latin.woff2"));
  const svg = await readFile(join(extensionDir, "public", "icon.svg"));
  const page = await browser.newPage({ viewport: PROMO, deviceScaleFactor: 1, colorScheme: "light" });
  await page.setContent(`<!doctype html>
<style>
@font-face {
  font-family: Geist;
  src: url("data:font/woff2;base64,${font.toString("base64")}") format("woff2");
  font-weight: 100 900;
}
html, body { margin: 0; height: 100%; }
body {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #192226;
  color: #f1eee5;
  font-family: Geist, sans-serif;
  text-align: center;
}
img { display: block; width: 96px; height: 96px; }
h1 { margin: 14px 0 0; font-size: 30px; font-weight: 850; line-height: 1.15; letter-spacing: -0.04em; }
p { margin: 8px 0 0; font-size: 15px; line-height: 1.4; color: #b9c4c3; }
</style>
<img src="data:image/svg+xml;base64,${svg.toString("base64")}" alt="">
<h1>Google Maps Saved</h1>
<p>Export your Saved lists. No Takeout wait.</p>`);
  await page.locator("img").evaluate((img) => img.decode());
  await page.evaluate(() => document.fonts.ready);
  if (!(await page.evaluate(() => document.fonts.check('850 30px "Geist"')))) {
    throw new Error("The Geist font did not load in the promo tile.");
  }
  await page.screenshot({ path: join(storeDir, "promo-440x280.png") });
  await page.close();
}

async function main() {
  try {
    await access(distPopup);
  } catch {
    throw new Error(`${distPopup} is missing. Run npm run build first.`);
  }
  const { chromium } = loadPlaywright();
  // file:// pages cannot load module scripts or fonts without this flag.
  const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
  try {
    await renderIcons(browser);
    await renderScreenshots(browser);
    await renderPromo(browser);
  } finally {
    await browser.close();
  }
  console.log(`Wrote icons to ${iconsDir} and store images to ${storeDir}`);
}

main().catch((error) => {
  console.error(`Store screenshots failed: ${error.message}`);
  process.exitCode = 1;
});
