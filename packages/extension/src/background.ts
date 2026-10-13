import { GoogleReader } from "google-maps-saved";
import { handleExternalPort } from "./export-service.js";

const APP_ORIGINS: string[] = __APP_ORIGINS__;

chrome.runtime.onConnectExternal.addListener((port) =>
  handleExternalPort(port, {
    appOrigins: APP_ORIGINS,
    permissions: chrome.permissions,
    storage: chrome.storage,
    createReader: (options) => new GoogleReader(options),
    now: () => new Date(),
  }),
);
