# google-maps-saved

Read your Google Maps **Saved** lists from the Chrome session you are already
signed in to, and export them as a Google Takeout-format ZIP (one CSV per
list), or as a JSON snapshot. No Takeout request, no waiting.

This repository has two packages:

| Package | What it is |
| --- | --- |
| [`packages/core`](packages/core) | `google-maps-saved` on npm. The reader for Google's Maps web endpoints, the snapshot types and validator, and the Takeout CSV/ZIP serializer. Zero runtime dependencies. |
| [`packages/extension`](packages/extension) | A popup-only Chrome extension (Manifest V3) that uses the library to export your lists to a file. |

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
