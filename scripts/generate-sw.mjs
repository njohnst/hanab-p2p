/**
 * Writes the offline cache's service worker, out/sw.js, after `next build` (`yarn build` runs it).
 * It precaches every file of the export but source maps and dotfiles (see ./service-worker.mjs and
 * docs/P2P_DESIGN.md, "Getting the app without internet").
 *
 *   node scripts/generate-sw.mjs [exportDir]     (default: out)
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { buildServiceWorker, isPrecached, precacheHash, precacheManifest } from "./service-worker.mjs";

const root = resolve(process.argv[2] || "out");

/** Every file under `dir`, as paths relative to the export with "/". */
function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listFiles(path);
    }

    return entry.isFile() ? [relative(root, path).split(sep).join("/")] : [];
  });
}

if (!existsSync(join(root, "index.html"))) {
  console.error(`generate-sw: no static export in ${root} (run next build first).`);
  process.exit(1);
}

const paths = listFiles(root).filter(isPrecached);
const files = paths.map((path) => ({ path, hash: precacheHash(readFileSync(join(root, path))) }));
const manifest = precacheManifest(files);
if (!manifest.precache.some(([key]) => key === "404.html")) {
  console.warn("generate-sw: the export has no 404.html: unknown pages will fail offline.");
}

const worker = buildServiceWorker(manifest);
writeFileSync(join(root, "sw.js"), worker);

const bytes = paths.reduce((total, path) => total + statSync(join(root, path)).size, 0);
const megabytes = (bytes / 1024 / 1024).toFixed(1);
console.log(
  `generate-sw: wrote sw.js (${(worker.length / 1024).toFixed(1)} KB), version ${manifest.version}, ` +
    `precaching ${manifest.precache.length} files (${megabytes} MB).`
);
