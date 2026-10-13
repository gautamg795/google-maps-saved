# google-maps-saved

Read your Google Maps **Saved** lists from the Chrome session you are already
signed in to, and export them as a Google Takeout-format ZIP (one CSV per
list), or as a JSON snapshot. No Takeout request, no waiting.

This repository has two packages:

| Package | What it is |
| --- | --- |
| [`packages/core`](packages/core) | `google-maps-saved` on npm. The reader for Google's Maps web endpoints, the snapshot types and validator, and the Takeout CSV/ZIP serializer. Zero runtime dependencies. |
| [`packages/extension`](packages/extension) | A Chrome extension (Manifest V3) that uses the library to export your lists to a file. A [connected web app](#connected-web-apps) listed in `app-origins.json` can request the export directly. |

Google credentials stay in Chrome. Nothing is uploaded anywhere. The reader
calls the same `www.google.com` endpoints the Maps web app calls, with your
cookies, from inside your browser.

> This uses unofficial Google endpoints. Google can change them at any time.
> When a read fails with a decoding error, the layout changed; open an issue
> with the error text (not with your data).

## Use the extension

Requirements: Chrome 127 or newer, Node 22.

```sh
npm ci
npm run build
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked**, and select `packages/extension/dist`. Pin the extension.
2. Open [Google Maps](https://www.google.com/maps) and sign in.
3. From that Maps tab, click the extension icon. Allow access to
   `www.google.com` when asked.
4. Choose the Google account, the lists, and the format. Click **Export
   selected lists**. Keep the popup open until the download starts.

The default output is a ZIP with the Takeout layout
`Takeout/Saved/<list title>.csv` and the header `Title,Note,URL,Comment`.
Place URLs use the same `…/data=!4m2!3m1!1s0x…:0x…` form as a real Takeout
export, so any importer that accepts Takeout accepts this file. By default
three extra columns are appended: `Latitude,Longitude,Address`. Turn that
off in the popup if an importer rejects unknown columns.

Starred places and My Maps are not included. Owned and collaborative lists
are read by default; followed lists are optional.

## Connected web apps

A web app can ask the extension for an export without the popup. The build
reads the allowed app origins from `packages/extension/app-origins.json`, so
plain `npm run build` produces the connected build. Chrome requires this list
in the manifest; there is no way to add an origin at runtime.

Each entry must be an exact `http` or `https` origin (scheme, host, and port
only, no path or trailing slash). The build adds a background service worker
(`background.js`) and an `externally_connectable` entry to
`dist/manifest.json`. Chrome match patterns ignore the port, so the manifest
lists `http://localhost/*` for `http://localhost:3000`. The worker accepts a
connection only from a tab whose origin is exactly one of the configured
origins.

Two overrides exist for one-off builds:

```sh
# Replace the list for this build only.
npm run build -w @google-maps-saved/extension -- \
  '--app-origins=https://places.example.com,http://localhost:3000'
# Build with no connected apps.
npm run build -w @google-maps-saved/extension -- --popup-only
```

The committed `app-origins.json` holds the maintainer's own app. Edit it, or
empty it, before you distribute a build to other people.

Use the popup once before the first connected export. The popup grants the
`www.google.com` host permission and remembers the Google account that you
choose. The worker uses that account and reads every owned and collaborative
list. It never reads followed lists. It uses the popup setting for the extra
`Latitude,Longitude,Address` columns.

The extension ID does not change between builds and machines, because the
`key` in `manifest.json` sets it. Use that ID in the web app.

### Message protocol

The page opens a port with `chrome.runtime.connect` and sends one message:

| From | Message | Fields |
| --- | --- | --- |
| Page | `EXPORT` | `{ kind: "EXPORT" }`. Send one per port. |
| Extension | `PROGRESS` | `listsRead`, `totalLists`, `membershipsRead` |
| Extension | `RESULT` | `fileName` (`google-maps-saved-YYYY-MM-DD.zip`), `mimeType` (`application/zip`), `base64` (the Takeout ZIP), `lists`, `entries` |
| Extension | `ERROR` | `code`, `message`. The `message` is for the user. |

Error codes include `setup` (use the popup first), `empty` (no Saved lists),
`account_mismatch` (choose the account in the popup again), `protocol` (the
page sent an unknown message), `unexpected`, and the `MapsError` codes of the
library. Close the port to cancel the read.

```ts
const port = chrome.runtime.connect(EXTENSION_ID, { name: "google-maps-saved-export" });
port.onMessage.addListener((m) => { /* PROGRESS | RESULT | ERROR */ });
port.postMessage({ kind: "EXPORT" });
```

`chrome.runtime` exists on a page only when an installed extension lists the
origin of that page in `externally_connectable`. Check for it before you show
the option.

## Use the library

```sh
npm install google-maps-saved
```

```ts
import { GoogleReader, toTakeoutZip } from "google-maps-saved";

// Must run in a context that can send www.google.com cookies, such as a
// Chrome extension page with host permission for https://www.google.com/*.
const reader = new GoogleReader({
  slot: 0, // Google authuser index
  followed: false,
  signal: new AbortController().signal,
  progress: (p) => console.log(p),
});
const snapshot = await reader.collect(); // every owned and collaborative list
const zip = toTakeoutZip(snapshot, { extended: true });
```

See [`packages/core/README.md`](packages/core/README.md) for the API.

## Develop

```sh
npm run typecheck
npm test
npm run build
```

The extension build does not minify. The library's `requestAccountBody`
function is serialized by Chrome and executed inside the Maps document, so it
must survive bundling unchanged.

## License

MIT
