// Drift guard between the router and the published contract.
//
// docs/openapi.yaml is written BEFORE the mobile clients exist and is what they will be built against, so
// a route that exists in code but not in the contract is a route no client knows about, and a route in the
// contract with no code behind it is a promise nobody keeps. Both are defects and both are caught here.
//
// Scanned with regexes rather than a YAML parser on purpose: adding a YAML dependency to check a
// hand-authored file would be a heavier commitment than the check is worth, and the two shapes being
// matched (a route literal in the router, a path key in the spec) are simple and stable.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const routerSource = readFileSync(join(ROOT, "src", "index.ts"), "utf8");
const specSource = readFileSync(join(ROOT, "docs", "openapi.yaml"), "utf8");
const contractSource = readFileSync(join(ROOT, "docs", "CONTRACT.md"), "utf8");

/** Every literal path the router matches. */
function routerPaths(): string[] {
  return [...routerSource.matchAll(/path === "([^"]+)"/g)].map((match) => match[1]);
}

/** Every path key declared in the spec (two-space indented, ends in a colon). */
function specPaths(): string[] {
  return [...specSource.matchAll(/^ {2}(\/[^\s:]*):$/gm)].map((match) => match[1]);
}

describe("router and openapi.yaml agree", () => {
  it("finds routes and spec paths at all", () => {
    expect(routerPaths().length).toBeGreaterThan(0);
    expect(specPaths().length).toBeGreaterThan(0);
  });

  it("declares every client-facing route in the spec", () => {
    // /admin is deliberately excluded: it is the operator surface and is not promised to clients.
    const clientRoutes = routerPaths().filter((path) => !path.startsWith("/admin"));
    for (const path of clientRoutes) expect(specPaths()).toContain(path);
  });

  it("implements every path the spec declares", () => {
    for (const path of specPaths()) expect(routerPaths()).toContain(path);
  });
});

describe("error codes are documented", () => {
  it("names every wire code in CONTRACT.md and openapi.yaml", () => {
    const httpSource = readFileSync(join(ROOT, "src", "http.ts"), "utf8");
    // Read the codes off the status table, which is the exhaustive one: a code with no status cannot exist.
    const table = /const STATUS_BY_CODE[^{]*{([\s\S]*?)\n};/.exec(httpSource);
    expect(table).not.toBeNull();
    const codes = [...(table?.[1] ?? "").matchAll(/^\s{2}([a-z_]+):/gm)].map((match) => match[1]);
    expect(codes.length).toBeGreaterThan(10);
    for (const code of codes) {
      expect(contractSource, `${code} missing from CONTRACT.md`).toContain(code);
      expect(specSource, `${code} missing from openapi.yaml`).toContain(code);
    }
  });
});

describe("published response headers are documented", () => {
  it("names every prism-* response header in the contract", () => {
    const chatSource = readFileSync(join(ROOT, "src", "routes", "chat.ts"), "utf8");
    const headers = new Set(
      [...chatSource.matchAll(/"(prism-[a-z-]+)":/g)].map((match) => match[1]),
    );
    expect(headers.size).toBeGreaterThan(5);
    for (const header of headers) {
      expect(contractSource, `${header} missing from CONTRACT.md`).toContain(header);
    }
  });
});
