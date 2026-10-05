// Bundles each Edge Function into one file, which is what the Supabase
// dashboard's editor takes: it holds a single index.ts per function, so the
// shared modules have to travel inside it.
//
//   node dev/build-functions.mjs
//
// Remote dependencies (npm:, jsr:, https:) stay as they are — Deno resolves
// those on the server.

// esbuild is not a dependency of this repo; point at an installed copy with
// ESBUILD=<path to esbuild's main.js> if node cannot find it on its own.
const { build } = await import(process.env.ESBUILD || "esbuild");
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FUNCTIONS = ["cleanup", "complete-upload", "create-upload", "get-session", "list-frames", "manage-frames"];

await mkdir(new URL("../dist/functions/", import.meta.url), { recursive: true });

for (const name of FUNCTIONS) {
  await build({
    entryPoints: [`${ROOT}supabase/functions/${name}/index.ts`],
    outfile: `${ROOT}dist/functions/${name}.ts`,
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "neutral",
    external: ["npm:*", "jsr:*", "https://*", "node:*"],
    logLevel: "warning",
  });
  console.log(`bundled ${name}`);
}
