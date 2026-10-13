# @google-maps-saved/extension

The Chrome extension. Build and usage are documented in the
[repository README](../../README.md).

- `manifest.json`: permissions, popup, and the fixed `key`. The build adds the
  worker and `externally_connectable` from `app-origins.json`.
- `app-origins.json`: exact origins of web apps allowed to request an export.
- `scripts/build.mjs`: `npm run build`, `-- --popup-only`, or
  `-- '--app-origins=…'`.
- `src/`: `popup.*` and `popup-controller.ts` for the popup;
  `background.ts` and `export-service.ts` for the connected-app worker.
