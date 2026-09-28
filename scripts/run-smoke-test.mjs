// Bundles each test/*.ts entry with esbuild (headless — @lexical/headless
// works without a DOM, similar to how lightbook-prosemirror's own tests
// only exercise the model/state layer) and runs them all, failing loud on
// the first suite that fails.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const suites = ["test/smoke.ts", "test/collab.ts"];

// Bundled output has to live under the project so Node's bare-specifier
// resolution for the externalized "loro-crdt" (see below) can walk up to
// this project's own node_modules — os.tmpdir() has no such ancestor.
const cacheDir = path.join(root, "node_modules/.smoke-cache");
mkdirSync(cacheDir, { recursive: true });

for (const suite of suites) {
  const outfile = path.join(cacheDir, `${path.basename(suite, ".ts")}-${Date.now()}.mjs`);
  await build({
    entryPoints: [path.join(root, suite)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    jsx: "automatic",
    // loro-crdt's Node entry does its own dynamic wasm loading (a
    // dynamic require esbuild can't follow once bundled); importing it at
    // runtime instead of inlining it sidesteps that entirely.
    external: ["loro-crdt"],
  });
  console.log(`\n=== ${suite} ===`);
  const result = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}
