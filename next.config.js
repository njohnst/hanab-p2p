/**
 * Fully static build (`next build` writes `out/`), servable from any static host.
 *
 * Set NEXT_PUBLIC_BASE_PATH to serve the app from a sub-path, e.g. "/hanabi"
 * for a GitHub Pages project site. Keep the normalisation below in sync with
 * src/lib/routes.ts.
 */
function normalizeBasePath(value) {
  const trimmed = (value || "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

const basePath = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);

/** @type {import('next').NextConfig} */
module.exports = {
  output: "export",
  trailingSlash: true,
  basePath,
  assetPrefix: basePath,
  images: {
    unoptimized: true,
  },
  productionBrowserSourceMaps: true,
};
