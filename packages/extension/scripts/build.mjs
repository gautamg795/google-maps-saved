#!/usr/bin/env node
// Bundles the popup into dist/. The build must not minify or rename
// identifiers: core serializes `requestAccountBody` with toString() and runs
// it inside the Google Maps document.
//
// Connected web app origins come from app-origins.json next to this
// package. They add the background service worker and externally_connectable.
// --app-origins=<origin>[,<origin>...] replaces that list for one build;
// --popup-only builds without connected apps. A popup-only build must be
// identical to a build with an empty list.
//
// --store builds the Chrome Web Store package: popup-only, into dist-store/,
// with no manifest `key`, then zipped to google-maps-saved-extension-<version>.zip.
// Keep `key` in the other builds; it sets the sideloaded extension ID.
// Requires the `zip` command.
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(extensionDir, "src");
const tempDir = join(extensionDir, `.dist-tmp-${process.pid}`);
const coreEntry = resolve(extensionDir, "..", "core", "src", "index.ts");

const buildOptions = {
  outdir: tempDir,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome127",
  alias: { "google-maps-saved": coreEntry },
  minify: false,
  logLevel: "warning",
};

const originsFile = join(extensionDir, "app-origins.json");

function checkOrigins(origins, source) {
  if (!Array.isArray(origins) || origins.some((origin) => typeof origin !== "string")) {
    throw new Error(`${source} must be a list of origin strings.`);
  }
  for (const origin of origins) {
    const url = URL.canParse(origin) ? new URL(origin) : null;
    if (url === null || url.origin !== origin || !["http:", "https:"].includes(url.protocol)) {
      throw new Error(
        `${JSON.stringify(origin)} in ${source} is not an exact http or https origin, for example https://places.example.com or http://localhost:3000.`,
      );
    }
  }
  return [...new Set(origins)];
}

/**
 * Returns `{ store, appOrigins }`. `appOrigins` is null for a popup-only
 * build. Order of precedence: --store, --popup-only, --app-origins=,
 * app-origins.json, none.
 */
async function resolveMode(args) {
  let override = null;
  let popupOnly = false;
  let store = false;
  for (const arg of args) {
    if (arg === "--popup-only") {
      popupOnly = true;
    } else if (arg === "--store") {
      store = true;
    } else if (arg.startsWith("--app-origins=")) {
      if (override !== null) throw new Error("Give --app-origins one time only.");
      override = checkOrigins(arg.slice("--app-origins=".length).split(","), "--app-origins");
    } else {
      throw new Error(
        `Unknown argument ${JSON.stringify(arg)}. Use --app-origins=<origin>[,<origin>...], --popup-only, or --store.`,
      );
    }
  }
  if (store && override !== null) {
    throw new Error("--store and --app-origins cannot be combined. A store build is popup-only.");
  }
  if (popupOnly && override !== null) {
    throw new Error("--popup-only and --app-origins cannot be combined.");
  }
  if (store || popupOnly) return { store, appOrigins: null };
  if (override !== null) return { store, appOrigins: override };
  let text;
  try {
    text = await readFile(originsFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { store, appOrigins: null };
    throw error;
  }
  const origins = checkOrigins(JSON.parse(text), "app-origins.json");
  return { store, appOrigins: origins.length === 0 ? null : origins };
}

/**
 * Chrome ignores the port in externally_connectable match patterns, so
 * http://localhost:3000 and http://localhost:5173 give one pattern. The
 * worker compares the full sender origin.
 */
function matchPatterns(origins) {
  return [
    ...new Set(
      origins.map((origin) => {
        const url = new URL(origin);
        return `${url.protocol}//${url.hostname}/*`;
      }),
    ),
  ];
}

/** Replaces `zipPath` with an archive of the files in `dir`, at the archive root. */
function zipDirectory(dir, zipPath) {
  try {
    // -X leaves out extra file attributes. zip -r adds to an existing archive,
    // so the caller must remove it first.
    execFileSync("zip", ["-q", "-r", "-X", zipPath, "."], { cwd: dir, stdio: "inherit" });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("The zip command is not installed. Install zip, then run the store build again.");
    }
    throw error;
  }
}

async function main() {
  const { store, appOrigins } = await resolveMode(process.argv.slice(2));
  const outDir = join(extensionDir, store ? "dist-store" : "dist");
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  try {
    await build({ ...buildOptions, entryPoints: [join(sourceDir, "popup.ts")] });
    for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
      if (entry.isFile() && /\.(html|css)$/i.test(entry.name)) {
        await copyFile(join(sourceDir, entry.name), join(tempDir, entry.name));
      }
    }
    await cp(join(extensionDir, "public"), join(tempDir, "public"), { recursive: true });
    if (store) {
      const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
      delete manifest.key;
      await writeFile(join(tempDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    } else if (appOrigins === null) {
      await copyFile(join(extensionDir, "manifest.json"), join(tempDir, "manifest.json"));
    } else {
      await build({
        ...buildOptions,
        entryPoints: [join(sourceDir, "background.ts")],
        define: { __APP_ORIGINS__: JSON.stringify(appOrigins) },
      });
      const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
      manifest.background = { service_worker: "background.js", type: "module" };
      manifest.externally_connectable = { matches: matchPatterns(appOrigins) };
      await writeFile(join(tempDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    await rm(outDir, { recursive: true, force: true });
    await rename(tempDir, outDir);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
  console.log(`Built extension at ${outDir}`);
  if (appOrigins !== null) {
    console.log(`Connected web app origins: ${appOrigins.join(", ")}`);
  }
  if (store) {
    const { version } = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
    const zipPath = join(extensionDir, `google-maps-saved-extension-${version}.zip`);
    await rm(zipPath, { force: true });
    zipDirectory(outDir, zipPath);
    console.log(`Packed store upload at ${zipPath}`);
  }
}

main().catch((error) => {
  console.error(`Extension build failed: ${error.message}`);
  process.exitCode = 1;
});
