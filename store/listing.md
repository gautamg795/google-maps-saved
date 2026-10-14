# Chrome Web Store listing

Paste these into the Developer Dashboard. Field limits are noted.

## Store listing

**Name** (45 characters max)
Google Maps Saved export

**Summary** (132 characters max)
Export your Google Maps Saved lists as a Takeout-format ZIP or JSON, straight from the Maps tab you are signed in to.

**Description**
Export your Google Maps Saved lists without waiting for Google Takeout.

Open Google Maps, click the extension, choose the lists, and download. You get a ZIP in the same layout Google Takeout uses (one CSV per list, with Title, Note, URL and Comment columns), so anything that imports a Takeout export imports this file. You can also add Latitude, Longitude and Address columns, or download the raw JSON snapshot instead.

How it works
- The extension reads your lists through the same Maps web endpoints your browser already uses, with your existing Google session.
- Nothing is uploaded anywhere. The export is written to a file on your computer.
- Your Google password and cookies are never read by the extension.

What it reads
- Owned and collaborative lists by default. Followed lists are optional.
- Starred places and My Maps are not included.

Open source, MIT licensed. Source, issues and the JavaScript library behind it: https://github.com/gautamg795/google-maps-saved

This extension is not affiliated with Google. It uses unofficial endpoints that Google may change at any time.

**Category**
Productivity

**Language**
English

## Privacy practices

**Single purpose description**
Export the user's Google Maps Saved lists to a local file.

**Permission justifications**
- activeTab: identify the Google Maps tab the user clicked from, so the account lookup runs only there.
- scripting: run the Google account lookup inside that Maps tab. The function is self-contained and injects nothing into other sites.
- storage: remember the chosen Google account and the columns setting on the user's device.
- Host permission https://www.google.com/* (optional, requested in the popup): fetch the user's Saved lists with their existing Google session.

**Remote code**
No. All code ships in the package.

**Data usage** (tick these)
- Personally identifiable information: the signed-in Google account emails, shown in the popup so the user can choose one.
- Website content: the user's Saved list contents, written only into the file the user downloads.
Not collected: health, financial, authentication, personal communications, location, web history, user activity.

**Certifications** (tick all three)
- Not sold to third parties.
- Not used or transferred for purposes unrelated to the single purpose.
- Not used or transferred to determine creditworthiness or for lending.

**Privacy policy URL**
https://github.com/gautamg795/google-maps-saved/blob/main/PRIVACY.md

## Assets

- Icon: `packages/extension/public/icons/icon-128.png`
- Screenshots (1280×800): `store/screenshots/01-choose-lists.png`, `02-reading.png`, `03-done.png`
- Small promo tile (440×280): `store/promo-440x280.png`
- Package: `packages/extension/google-maps-saved-extension-<version>.zip` from `npm run build:store`

## Distribution

- Visibility: Public.
- Regions: all.
- Pricing: free.
