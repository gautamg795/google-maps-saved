#!/usr/bin/env node
// Bundles the popup into dist/. The build must not minify or rename
// identifiers: core serializes `requestAccountBody` with toString() and runs
// it inside the Google Maps document.
import { copyFile, cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(extensionDir, "src");
const outDir = join(extensionDir, "dist");
const tempDir = join(extensionDir, `.dist-tmp-${process.pid}`);
const coreEntry = resolve(extensionDir, "..", "core", "src", "index.ts");

async function main() {
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  try {
    await build({
      entryPoints: [join(sourceDir, "popup.ts")],
      outdir: tempDir,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "chrome127",
      alias: { "google-maps-saved": coreEntry },
      minify: false,
      logLevel: "warning",
    });
    for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
      if (entry.isFile() && /\.(html|css)$/i.test(entry.name)) {
        await copyFile(join(sourceDir, entry.name), join(tempDir, entry.name));
      }
    }
    await cp(join(extensionDir, "public"), join(tempDir, "public"), { recursive: true });
    await copyFile(join(extensionDir, "manifest.json"), join(tempDir, "manifest.json"));
    await rm(outDir, { recursive: true, force: true });
    await rename(tempDir, outDir);
    console.log(`Built extension at ${outDir}`);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error(`Extension build failed: ${error.message}`);
  process.exitCode = 1;
});
