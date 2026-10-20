/**
 * Serves the static export (out/), to test the build or to host the app on a local network with no
 * internet (see docs/P2P_DESIGN.md, "Getting the app without internet"). It listens on every
 * interface and prints the URLs other devices can open.
 *
 *   yarn serve:static                      port 3000 (PORT), every interface (HOST to pick one)
 *   BASE_PATH=/hanabi yarn serve:static     under a base path, like a GitHub Pages project site
 *                                           (default: the base path the export was built with)
 *   TLS_CERT=cert.pem TLS_KEY=key.pem yarn serve:static
 *                                           https, with PEM files, e.g. from `mkcert localhost
 *                                           192.168.1.5` on devices that trust mkcert's root
 *
 * Pages opened at http://<lan-ip> are not secure contexts: no in-app camera and no offline cache
 * there, but nearby play works. Git Bash rewrites /hanabi into a Windows path: run
 * `MSYS_NO_PATHCONV=1 BASE_PATH=/hanabi yarn serve:static` there.
 *
 * Like GitHub Pages: /play redirects to /play/, and unknown paths get 404.html. Also:
 * - <basePath>/nearby-origins.json answers {"origins": [...]}, the origins of this server for other
 *   devices (./lan-origins.mjs), so that a page opened on localhost can build invite URLs they can
 *   open (src/lib/nearbyOrigin.ts).
 * - Files are revalidated on every use (Cache-Control: no-cache, Last-Modified), HTML and sw.js
 *   included, except the hashed ones under _next/static/, which are immutable.
 * - Range requests get 206 answers (Safari only plays media from servers that send them).
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { formatOrigin, isLoopbackAddress, lanOrigins } from "./lan-origins.mjs";
import { parseRange } from "./service-worker.mjs";

const root = resolve("out");
const notFoundPage = join(root, "404.html");
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || undefined;

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Keep in sync with normalizeBasePath in next.config.js. */
function normalizeBasePath(value) {
  const trimmed = (value || "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** The base path the export was built with (NEXT_PUBLIC_BASE_PATH), from its home page's script URLs. */
function exportBasePath() {
  try {
    const match = /(?:src|href)="([^"]*?)\/_next\/static\//.exec(readFileSync(join(root, "index.html"), "utf8"));
    return match ? normalizeBasePath(match[1]) : null;
  } catch {
    return null;
  }
}

/** The certificate and key to serve https with, or null for http. */
function readTls() {
  const { TLS_CERT, TLS_KEY } = process.env;
  if (!TLS_CERT && !TLS_KEY) {
    return null;
  }
  if (!TLS_CERT || !TLS_KEY) {
    console.error("serve-static: set both TLS_CERT and TLS_KEY (PEM files), or neither.");
    process.exit(1);
  }

  return { cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) };
}

if (!existsSync(join(root, "index.html"))) {
  console.error(`serve-static: no static export in ${root} (run yarn build first).`);
  process.exit(1);
}

const builtFor = exportBasePath();
const basePath = process.env.BASE_PATH !== undefined ? normalizeBasePath(process.env.BASE_PATH) : builtFor || "";
const tls = readTls();
const protocol = tls ? "https:" : "http:";

function resolveFile(pathname) {
  let file;
  try {
    file = normalize(join(root, decodeURIComponent(pathname)));
  } catch {
    return null;
  }
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    return null;
  }

  try {
    const stats = statSync(file);
    if (stats.isFile()) {
      return file;
    }
    if (stats.isDirectory()) {
      const index = join(file, "index.html");
      if (statSync(index).isFile()) {
        return index;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function cacheControl(file) {
  const hashed = file.startsWith(join(root, "_next", "static") + sep);
  return hashed ? "public, max-age=31536000, immutable" : "no-cache";
}

function sendFile(req, res, status, file) {
  const stats = statSync(file);
  const lastModified = stats.mtime.toUTCString();
  const headers = {
    "Content-Type": types[extname(file)] || "application/octet-stream",
    "Cache-Control": cacheControl(file),
    "Last-Modified": lastModified,
    "Accept-Ranges": "bytes",
  };

  if (status === 200) {
    const since = Date.parse(req.headers["if-modified-since"] || "");
    if (since >= Math.floor(stats.mtimeMs / 1000) * 1000) {
      res.writeHead(304, headers).end();
      return;
    }
  }

  // If-Range: the Range only applies to the version of the file the client already has part of.
  const ifRange = req.headers["if-range"];
  const range =
    status === 200 && (!ifRange || ifRange === lastModified) ? parseRange(req.headers.range, stats.size) : null;
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${stats.size}` }).end();
    return;
  }

  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stats.size}`;
  }
  headers["Content-Length"] = range ? range.end - range.start + 1 : stats.size;
  res.writeHead(range ? 206 : status, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }

  createReadStream(file, range || {})
    .on("error", () => res.destroy())
    .pipe(res);
}

function handle(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  const url = new URL(req.url, "http://localhost");
  let pathname = url.pathname;

  if (basePath) {
    if (pathname === basePath) {
      res.writeHead(301, { Location: `${basePath}/${url.search}` }).end();
      return;
    }
    if (!pathname.startsWith(`${basePath}/`)) {
      res.writeHead(404).end("Not found");
      return;
    }
    pathname = pathname.slice(basePath.length);
  }

  if (pathname === "/nearby-origins.json") {
    const origins = lanOrigins(networkInterfaces(), { protocol, port: server.address().port, host });
    res.writeHead(200, { "Content-Type": types[".json"], "Cache-Control": "no-store" });
    res.end(JSON.stringify({ origins }));
    return;
  }

  // Like GitHub Pages: /play redirects to /play/ when it is a directory.
  if (!pathname.endsWith("/") && !extname(pathname) && resolveFile(`${pathname}/`)) {
    res.writeHead(301, { Location: `${basePath}${pathname}/${url.search}` }).end();
    return;
  }

  const file = resolveFile(pathname);
  if (file) {
    sendFile(req, res, 200, file);
  } else if (existsSync(notFoundPage)) {
    sendFile(req, res, 404, notFoundPage);
  } else {
    res.writeHead(404).end("Not found");
  }
}

const server = (tls ? createHttpsServer(tls) : createServer()).on("request", (req, res) => {
  try {
    handle(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500);
    }
    res.end();
  }
});

server.on("error", (error) => {
  console.error(`serve-static: ${error.message}`);
  process.exit(1);
});

server.listen({ port, host }, () => {
  const listening = server.address().port;
  const url = (origin) => `${origin}${basePath}/`;
  const wildcard = !host || host === "0.0.0.0" || host === "::";
  const local =
    wildcard || isLoopbackAddress(host) ? formatOrigin(protocol, wildcard ? "localhost" : host, listening) : null;
  const lan = lanOrigins(networkInterfaces(), { protocol, port: listening, host });

  console.log(`Serving ${root}${basePath ? ` under ${basePath}/` : ""}`);
  if (local) {
    console.log(`  This computer:  ${url(local)}`);
  }
  if (lan.length) {
    lan.forEach((origin, i) => console.log(`  ${i ? "               " : "Other devices:"}  ${url(origin)}`));
  } else {
    console.log(`  Other devices:  none (${wildcard ? "no network connection?" : `listening on ${host} only`})`);
  }

  if (builtFor !== null && builtFor !== basePath) {
    console.warn(
      `Warning: the export was built for the base path "${builtFor}", not "${basePath}": its pages won't load. ` +
        "(In Git Bash, set MSYS_NO_PATHCONV=1 so that BASE_PATH stays a URL path.)"
    );
  }
  if (!tls && lan.length) {
    console.log(
      "Pages opened at http://<address> are not secure: no in-app camera or offline cache there (nearby play works).\n" +
        "Set TLS_CERT and TLS_KEY (PEM files, e.g. from mkcert) to serve https."
    );
  }
});
