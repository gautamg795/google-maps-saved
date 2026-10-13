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
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(extensionDir, "src");
const outDir = join(extensionDir, "dist");
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
 * Returns the connected web app origins for this build, or null for a
 * popup-only build. Order of precedence: --popup-only, --app-origins=,
 * app-origins.json, none.
 */
async function resolveAppOrigins(args) {
  let override = null;
  let popupOnly = false;
  for (const arg of args) {
    if (arg === "--popup-only") {
      popupOnly = true;
    } else if (arg.startsWith("--app-origins=")) {
      if (override !== null) throw new Error("Give --app-origins one time only.");
      override = checkOrigins(arg.slice("--app-origins=".length).split(","), "--app-origins");
    } else {
      throw new Error(
        `Unknown argument ${JSON.stringify(arg)}. Use --app-origins=<origin>[,<origin>...] or --popup-only.`,
      );
    }
  }
  if (popupOnly && override !== null) {
    throw new Error("--popup-only and --app-origins cannot be combined.");
  }
  if (popupOnly) return null;
  if (override !== null) return override;
  let text;
  try {
    text = await readFile(originsFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const origins = checkOrigins(JSON.parse(text), "app-origins.json");
  return origins.length === 0 ? null : origins;
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

async function main() {
  const appOrigins = await resolveAppOrigins(process.argv.slice(2));
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
    if (appOrigins === null) {
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
    console.log(`Built extension at ${outDir}`);
    if (appOrigins !== null) {
      console.log(`Connected web app origins: ${appOrigins.join(", ")}`);
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error(`Extension build failed: ${error.message}`);
  process.exitCode = 1;
});
