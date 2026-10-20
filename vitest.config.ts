/**
 * Vitest configuration (unit and scenario tests run in Node).
 *
 * Written as CommonJS on purpose: this package is not "type": "module", so Vite loads the
 * config as CommonJS, and vitest's CommonJS config entry ("vitest/config") cannot load its
 * own ESM dependencies on Node 20. A plain object needs no import at all.
 *
 * @type {import("vitest/config").ViteUserConfig}
 */
module.exports = {
  resolve: {
    alias: {
      "~": `${__dirname}/src`,
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
};
