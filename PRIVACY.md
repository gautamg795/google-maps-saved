# Privacy policy: Google Maps Saved export

Last updated: 2026-10-14

## What the extension does

The extension reads the Google Maps Saved lists of the Google account you
choose and writes them to a file that you download, or hands them to a web
app that you have configured in a build you made yourself. That is its only
purpose.

## What data it handles

- **Google account emails and IDs** of the accounts signed in to your Chrome
  profile, read from Google's account list so you can choose one. The chosen
  account ID and its position are stored in Chrome's extension storage on
  your device so the next export can reuse it.
- **Saved list contents**: list titles, place names, your notes, addresses,
  and coordinates. They are read from Google's Maps endpoints with your
  existing Google session and written into the file you download.
- **One setting**: whether to include the extra Latitude, Longitude, and
  Address columns.

## Where the data goes

Nowhere, unless you send it somewhere. The extension has no server. It does
not transmit any data to the developer or to third parties. The export is
written to a local file by your browser's download feature, or delivered to a
web app whose origin was compiled into your own build of the extension. The
build published on the Chrome Web Store contains no such web app.

## What it does not do

- It does not read, store, or transmit your Google password or cookies. The
  browser attaches your session to the requests; the extension never sees it.
- It does not run code from remote servers.
- It does not use analytics, advertising, or tracking of any kind.
- It does not change anything in your Google account.

## Permissions

- `activeTab` and `scripting`: run the account lookup inside the Google Maps
  tab you clicked from. Nothing is injected into other sites.
- `storage`: remember the chosen account and the columns setting on your
  device.
- Optional host permission for `https://www.google.com/*`: fetch your Saved
  lists with your Google session. You grant it in the popup.

## Contact

Open an issue at https://github.com/gautamg795/google-maps-saved/issues.
