// Serves the static export (out/) for local testing, optionally under a base
// path to mimic GitHub Pages: BASE_PATH=/hanabi PORT=3000 node scripts/serve-static.mjs
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve("out");
const basePath = (process.env.BASE_PATH || "").replace(/\/+$/, "");
const port = Number(process.env.PORT) || 3000;

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function resolveFile(pathname) {
  const file = normalize(join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root)) return null;
  try {
    const stats = statSync(file);
    if (stats.isFile()) return file;
    if (stats.isDirectory()) {
      const index = join(file, "index.html");
      if (statSync(index).isFile()) return index;
    }
  } catch {
    return null;
  }
  return null;
}

createServer((req, res) => {
  let { pathname } = new URL(req.url, "http://localhost");

  if (basePath) {
    if (pathname === basePath) {
      res.writeHead(301, { Location: `${basePath}/` }).end();
      return;
    }
    if (!pathname.startsWith(`${basePath}/`)) {
      res.writeHead(404).end("Not found");
      return;
    }
    pathname = pathname.slice(basePath.length);
  }

  // Like GitHub Pages: /play redirects to /play/ when it is a directory.
  if (!pathname.endsWith("/") && !extname(pathname) && resolveFile(`${pathname}/`)) {
    res.writeHead(301, { Location: `${basePath}${pathname}/${new URL(req.url, "http://localhost").search}` }).end();
    return;
  }

  const file = resolveFile(pathname);
  const status = file ? 200 : 404;
  const served = file || join(root, "404.html");
  res.writeHead(status, { "Content-Type": types[extname(served)] || "application/octet-stream" });
  createReadStream(served).pipe(res);
}).listen(port, () => {
  console.log(`Serving ${root} at http://localhost:${port}${basePath}/`);
});
