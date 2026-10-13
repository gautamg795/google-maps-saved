# google-maps-saved

Read Google Maps **Saved** lists through a signed-in Maps web session and
export them as Takeout-format CSV/ZIP or JSON. Zero runtime dependencies.
ESM only.

The reader must run where `fetch` sends `www.google.com` cookies, for example
a Chrome extension page with host permission for `https://www.google.com/*`.
It will not work from a server.

## API

### Reading

`new GoogleReader(options)` takes the Google `authuser` index as
`options.slot` (0 to 20) and an `AbortSignal` as `options.signal`. Set
`options.followed` to also read followed lists. `options.selectedListKeys`
limits `collect()`; the default is every owned and collaborative list.
`options.progress` receives `{ listsRead, totalLists, membershipsRead }`.

`reader.inventory()` returns `{ googleAccountId, inventory, requestedGroups }`.

`reader.collect()` returns a validated `Snapshot`. Requests are sequential and
at least 200 ms apart. The inventory is read again before every page, and a
list that changes during the read fails with `MapsError` code `changed`.

### Account discovery

`requestAccountBody()` must be passed as the function reference to
`chrome.scripting.executeScript({ func })` on a Google Maps tab. Chrome
serializes it, so it has no imports.

`decodeAccounts(body)` returns `{ googleAccountId, googleEmail, slot }` for
each signed-in, verified account.

### Snapshot

`validateSnapshot(value)` validates and normalizes a JSON snapshot. `LIMITS`
holds the bounds: 100 lists, 5,000 memberships, 64 KiB per row, 10 MiB total.
The exported types are `Snapshot`, `SourceList`, `Membership`, and
`MapsError`.

### Takeout output

`toTakeoutZip(snapshot, { extended?, date? })` returns a `Uint8Array` with one
`Takeout/Saved/<title>.csv` per selected list and the header
`Title,Note,URL,Comment`. `extended` appends `Latitude,Longitude,Address`.
`date` sets the ZIP timestamps (UTC) so output is reproducible.

`takeoutFiles(snapshot, options)` returns `{ path, csv }[]` when you want the
CSVs without a ZIP. `takeoutPlaceUrl(member)` returns the Takeout-style place
URL. `createStoredZip(entries, { date? })` is the dependency-free ZIP writer,
and `encodeCsv(rows)` the RFC 4180 encoder.

## Errors

Every failure is a `MapsError` with a stable `code` and a user-readable
`message`. Codes: `cancelled`, `network`, `google_busy`, `google_access`,
`schema`, `changed`, `incomplete`, `too_large`, `account_unknown`,
`account_mismatch`, `unsupported_list`, `unsupported_place`.

## License

MIT
