/**
 * The nearby play screens use their own translation keys (under "nearby"): every key the code
 * names must exist in English and French, and both must have the same keys.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { en } from "./en";
import { fr } from "./fr";

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Dotted paths of every string in a nested translation object. */
function keys(node: unknown, prefix: string): string[] {
  if (typeof node === "string") return [prefix];
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) => keys(value, `${prefix}.${key}`));
}

function lookup(resources: unknown, key: string): unknown {
  return key.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), resources);
}

describe("nearby translations", () => {
  it("has the same keys in English and French", () => {
    expect(keys(fr.nearby, "nearby").sort()).toEqual(keys(en.nearby, "nearby").sort());
  });

  it("translates every key the code uses", () => {
    const used = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      const pattern = /["'`](nearby\.[A-Za-z0-9_.]+)["'`]/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source))) {
        used.add(match[1]);
      }
    }

    expect(used.size).toBeGreaterThan(50);
    for (const key of Array.from(used)) {
      expect(typeof lookup(en, key), `en: ${key}`).toBe("string");
      expect(typeof lookup(fr, key), `fr: ${key}`).toBe("string");
    }
  });

  it("keeps the interpolations", () => {
    for (const key of keys(en.nearby, "nearby")) {
      const variables = (text: unknown) => (String(text).match(/{{\s*\w+\s*}}/g) || []).sort();
      expect(variables(lookup(fr, key)), key).toEqual(variables(lookup(en, key)));
    }
  });
});
