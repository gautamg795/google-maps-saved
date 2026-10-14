# google-maps-saved

Export your Google Maps **Saved** lists from the Chrome profile you are already
signed in to. No Takeout request, no waiting. The output is a Google
Takeout-format ZIP (one CSV per list) or a JSON snapshot, and a web app you
own can ask for that export with one click.

| Package | What it is |
| --- | --- |
| [`packages/core`](packages/core) | The `google-maps-saved` library: reader for the Maps web endpoints, snapshot types and validator, Takeout CSV/ZIP serializer. Zero runtime dependencies. |
| [`packages/extension`](packages/extension) | A Chrome extension (Manifest V3) built on the library. Popup export to a file, plus an optional background worker that answers export requests from the web apps listed in `app-origins.json`. |

The reader calls the same `www.google.com` endpoints the Maps web app calls,
with your cookies, from inside your browser. Google credentials never leave
Chrome. The export goes only where you send it: a file on disk, or a web app
you listed yourself.

> These are unofficial Google endpoints. Google can change them at any time.
> When a read fails with a decoding error, the layout changed. Open an issue
> with the error text, not with your data.

## Quick start

Requirements: Chrome 127 or newer, Node 22 (see `.node-version`).

```sh
git clone https://github.com/gautamg795/google-maps-saved.git
cd google-maps-saved
npm ci
npm run build
```

`npm run build` writes the extension to `packages/extension/dist` and the
library to `packages/core/dist`.

### Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select `packages/extension/dist`.
4. Pin the extension from the puzzle-piece menu.

The extension ID is fixed by the `key` in `packages/extension/manifest.json`,
so it is the same on every machine. After a rebuild, click **Reload** on the
extension card in `chrome://extensions`.

### First use

1. Open [Google Maps](https://www.google.com/maps) and sign in.
2. From that Maps tab, click the extension icon.
3. Click **Allow Google access** and accept the prompt for `www.google.com`.
   Chrome may close the popup for the prompt; click the icon again.
4. Choose your Google account. The extension remembers it.

You now have two ways to export.

## Export to a file

In the popup, choose the lists and the format, then click **Export selected
lists**. Keep the popup open until the download starts; closing it cancels the
read.

- **Takeout ZIP** (default): `Takeout/Saved/<list title>.csv` per list, header
  `Title,Note,URL,Comment`. Place URLs use the same
  `/maps/place/<name>/data=!4m2!3m1!1s0x…:0x…` form as a real Takeout export,
  so any importer that accepts Takeout accepts this file.
- **Add Latitude, Longitude, Address columns** (default on) appends three
  columns to each CSV. Turn it off if an importer rejects unknown columns.
- **JSON snapshot**: the raw validated snapshot, for your own tooling.

Owned and collaborative lists are selected by default. Followed lists are
optional. Starred places and My Maps are not included.

## Export straight into your web app

A web app whose origin is listed in `packages/extension/app-origins.json` can
request the export without the popup. The build reads that file and adds a
background service worker and an `externally_connectable` entry to the
manifest. Chrome requires this list in the manifest; origins cannot be added
at runtime.

The committed `app-origins.json` lists the maintainer's own app
([places-to-be](https://github.com/gautamg795/places-to-be)). To use the
extension with your own app:

1. Edit `packages/extension/app-origins.json`. Each entry is an exact `http`
   or `https` origin: scheme, host, and port, with no path or trailing slash.
2. `npm run build`, then **Reload** the extension in `chrome://extensions`.
3. Complete [First use](#first-use) once. The worker reuses the account and
   permission from the popup.
4. In your app, connect to the extension by ID and follow the
   [message protocol](#message-protocol).

The worker reads every owned and collaborative list and never reads followed
lists. It uses the popup's setting for the extra columns.

Two build overrides exist for one-off builds:

```sh
# Replace the origin list for this build only.
npm run build -w @google-maps-saved/extension -- \
  '--app-origins=https://places.example.com,http://localhost:3000'
# Build with no connected apps.
npm run build -w @google-maps-saved/extension -- --popup-only
```

Empty or edit `app-origins.json` before you give a build to other people.

### Message protocol

The page opens a port with `chrome.runtime.connect(EXTENSION_ID, { name })`
and sends JSON messages. The `name` is free-form.

| From | Message | Fields |
| --- | --- | --- |
| Page | `HELLO` | `{ kind: "HELLO" }`. Optional probe. |
| Extension | `HELLO` | No fields. Sent only when the page's exact origin is accepted. |
| Page | `EXPORT` | `{ kind: "EXPORT" }`. One per port. |
| Extension | `PROGRESS` | `listsRead`, `totalLists`, `membershipsRead`. Repeated. |
| Extension | `RESULT` | `fileName` (`google-maps-saved-YYYY-MM-DD.zip`), `mimeType` (`application/zip`), `base64` (the ZIP), `lists`, `entries`. |
| Extension | `ERROR` | `code`, `message`. The message is written for the user. |

Error codes: `setup` (complete First use), `account_mismatch` (choose the
account in the popup again), `empty` (no Saved lists), `protocol` (unknown
message), `unexpected`, and the library's `MapsError` codes. Closing the port
cancels the read.

```ts
const port = chrome.runtime.connect(EXTENSION_ID, { name: "google-maps-saved-export" });
port.onMessage.addListener((m) => { /* HELLO | PROGRESS | RESULT | ERROR */ });
port.postMessage({ kind: "HELLO" });   // show the option only after the reply
port.postMessage({ kind: "EXPORT" });
```

Use the `HELLO` probe to decide whether to show the option. Chrome exposes
`chrome.runtime` on every port of a listed host, because match patterns
ignore ports, so its presence alone does not prove the exact origin is
accepted. An unlisted origin is disconnected without a reply.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Popup says to open Google Maps first | The active tab is not `https://www.google.com/maps`. Open Maps and click the icon from that tab. |
| "Open the Google Maps Saved extension on a Google Maps tab once…" in your app | The worker has no permission or no remembered account. Complete [First use](#first-use). |
| "The remembered Google account is not at the same position any more…" | You signed in or out of a Google account, which changed the account order. Choose the account in the popup again. |
| Your app shows no sync option | The app's exact origin, including port, is not in `app-origins.json`, or the extension was not reloaded after the build. |
| Chrome refuses to load the unpacked folder | Another copy with the same ID is loaded. Remove it first. |
| "Google returned a response this connector cannot decode." | Google changed the response layout. Open an issue with the message. |

## Publish to the Chrome Web Store

The store build is popup-only and has no `key`, so the store assigns its own
extension ID and a sideloaded connected build can stay installed next to it.

```sh
npm run build:store
```

This writes `packages/extension/dist-store/` and
`packages/extension/google-maps-saved-extension-<version>.zip`. Then, in the
[Developer Dashboard](https://chrome.google.com/webstore/devconsole):

1. Register as a developer once (one-time fee) with the Google account that
   should own the listing.
2. **New item**, upload the ZIP.
3. Fill **Store listing**, **Privacy practices**, and **Distribution** from
   [`store/listing.md`](store/listing.md). Upload the screenshots and promo
   tile from `store/`.
4. Submit for review. Review takes from hours to a few days. Permissions and
   the privacy form are the usual reasons for a rejection; the text in
   `store/listing.md` answers them.

For a new version: bump `version` in `packages/extension/manifest.json`, run
`npm run build:store`, upload the new ZIP under **Package**, and submit.

## Use the library

```sh
npm install google-maps-saved
```

```ts
import { GoogleReader, toTakeoutZip } from "google-maps-saved";

// Runs only where fetch sends www.google.com cookies, such as a Chrome
// extension page or worker with host permission for https://www.google.com/*.
const reader = new GoogleReader({
  slot: 0, // Google authuser index
  followed: false,
  signal: new AbortController().signal,
  progress: (p) => console.log(p),
});
const snapshot = await reader.collect(); // every owned and collaborative list
const zip = toTakeoutZip(snapshot, { extended: true });
```

The API is documented in [`packages/core/README.md`](packages/core/README.md)
and the package is on npm at
[google-maps-saved](https://www.npmjs.com/package/google-maps-saved).

## Develop

```sh
npm run typecheck   # core and extension
npm test            # vitest, both packages
npm run build
```

Layout:

- `packages/core/src`: `snapshot.ts` (types, limits, validator), `decode.ts`
  (positional decoding of Google responses), `collect.ts` (`GoogleReader`),
  `accounts.ts` (ListAccounts discovery), `csv.ts`, `zip.ts`, `takeout.ts`.
- `packages/core/tests/fixtures`: redacted captures of real Google responses
  and a golden Takeout ZIP. Never commit real account IDs, emails, or notes.
- `packages/extension/src`: `popup-controller.ts` (popup flow),
  `export-service.ts` (connected-app worker), `popup.ts` and `background.ts`
  (entry points), small pure modules with their own tests.
- `packages/extension/scripts/build.mjs`: esbuild. It does not minify, because
  the library's `requestAccountBody` is serialized by Chrome with `toString()`
  and run inside the Maps document.

## License

MIT
