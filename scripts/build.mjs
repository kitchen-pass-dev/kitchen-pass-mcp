// Builds dist/kitchen-pass-mcp.mjs: one bundled file, so a buyer's install resolves no dependency ranges at all
// (the SDK's caret ranges would otherwise re-resolve inside a process that holds a wallet key). No source maps
// (they store build paths), no comments. esbuild comes from the repo root's node_modules (via tsx); nothing is
// installed for it. Fails if anything in the bundle came from outside mcp/ — an import mcp/ never declared would
// work here (Node looks up to the repo root) and break for buyers — or if the output imports anything but Node built-ins.
import { chmodSync, mkdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(ROOT, "dist", "kitchen-pass-mcp.mjs");
mkdirSync(dirname(out), { recursive: true });

const result = await build({
  absWorkingDir: ROOT,
  entryPoints: ["src/bin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: out,
  sourcemap: false,
  legalComments: "none",
  minifyWhitespace: false,
  metafile: true,
  logLevel: "warning",
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __kpRequire } from 'node:module'; const require = __kpRequire(import.meta.url);" },
});

const problems = [];
for (const input of Object.keys(result.metafile.inputs)) {
  const rel = relative(ROOT, join(ROOT, input));
  if (rel.startsWith("..") || !(rel.startsWith(`src${sep}`) || rel.startsWith(`node_modules${sep}`))) problems.push(`bundled from outside mcp/: ${rel}`);
}
const builtins = new Set([...builtinModules, ...builtinModules.map(m => `node:${m}`)]);
for (const o of Object.values(result.metafile.outputs)) {
  for (const imp of o.imports) if (!imp.external || !builtins.has(imp.path)) problems.push(`output imports ${imp.path}`);
}
if (problems.length) {
  console.error(`✗ build refused:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
chmodSync(out, 0o755);
const bytes = result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].bytes;
console.log(`built dist/kitchen-pass-mcp.mjs (${(bytes / 1024).toFixed(0)} KB, ${Object.keys(result.metafile.inputs).length} inputs, all from mcp/)`);
