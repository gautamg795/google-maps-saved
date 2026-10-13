The four `*-response.json` files are redacted Google web responses captured on
2026-10-12 with the current reader requests: `/locationhistory/preview/mas`,
`/maps/preview/entitylist/getlist`, and ListAccounts. The two list pages belong
to one 591-entry list (500 entries with continuation, then 91 terminal entries).

Array lengths, positions, nulls, booleans, enums and counts are retained.
All other strings are replaced consistently across files, including list IDs,
place identities, cursor, names, notes, addresses and URLs. Account IDs and
emails use placeholders. Floating-point numbers and large numeric values are
replaced. These captures protect the positional response layout; they do not
preserve personal content or real feature identities.
