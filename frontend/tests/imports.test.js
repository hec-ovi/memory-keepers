// The three.js scene modules only load in a real browser, so jsdom suites
// never import them; a renamed or moved export surfaces as a blank scene in
// production. This walks every src module and proves each relative named
// import matches a real export in its target.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../src");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : [];
  });
}

const stripComments = (code) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("module graph", () => {
  it("every relative named import matches an export in its target", () => {
    const broken = [];
    for (const file of walk(SRC)) {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      for (const m of code.matchAll(/import\s*{([^}]*)}\s*from\s*["'](\.[^"']+)["']/g)) {
        const target = path.join(path.dirname(file), m[2]);
        if (!fs.existsSync(target)) {
          broken.push(`${path.relative(SRC, file)}: missing module ${m[2]}`);
          continue;
        }
        const exported = stripComments(fs.readFileSync(target, "utf8"));
        for (const raw of m[1].split(",")) {
          const name = raw.trim().split(/\s+as\s+/)[0];
          if (!name) continue;
          const re = new RegExp(
            `export\\s+(async\\s+)?(function|const|let|class)\\s+${name}\\b|export\\s*{[^}]*\\b${name}\\b`,
          );
          if (!re.test(exported)) {
            broken.push(`${path.relative(SRC, file)}: "${name}" not exported by ${m[2]}`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
