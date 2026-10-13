#!/usr/bin/env node
// Bundles the popup into dist/. The build must not minify or rename
// identifiers: core serializes `requestAccountBody` with toString() and runs
// it inside the Google Maps document.
//
// --app-origins=<origin>[,<origin>...] also bundles the background service
// worker and lets pages at those exact origins connect to it. Without the
// flag, dist/ must stay identical to a popup-only build.
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

/** Returns the origins from --app-origins, or null when the flag is absent. */
function parseAppOrigins(args) {
  let origins = null;
  for (const arg of args) {
    if (!arg.startsWith("--app-origins=")) {
      throw new Error(`Unknown argument ${JSON.stringify(arg)}. Use --app-origins=<origin>[,<origin>...].`);
    }
    if (origins !== null) {
      throw new Error("Give --app-origins one time only.");
    }
    origins = arg.slice("--app-origins=".length).split(",");
    for (const origin of origins) {
      const url = URL.canParse(origin) ? new URL(origin) : null;
      if (url === null || url.origin !== origin || !["http:", "https:"].includes(url.protocol)) {
        throw new Error(
          `${JSON.stringify(origin)} is not an exact http or https origin, for example https://places.example.com or http://localhost:3000.`,
        );
      }
    }
  }
  return origins === null ? null : [...new Set(origins)];
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
  const appOrigins = parseAppOrigins(process.argv.slice(2));
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
