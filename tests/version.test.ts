// The version this Worker advertises must equal the version in package.json.
//
// THE EXPECTED VALUE IS DERIVED, NEVER TRANSCRIBED. This file reads package.json off disk and
// parses it; it does not carry a second hand-typed copy of the version string. That distinction
// is the whole reason this test is worth having. In prism-mcp the advertised version was a
// literal and the test asserting it carried a transcribed duplicate of the same string, so the
// assertion only ever proved that someone had typed the same thing twice -- and a correct
// version bump went red because one copy was updated and the other was not.
//
// SCOPE: this file owns "the literal agrees with package.json". Whether the endpoint actually
// PUTS that value on the wire is a separate failure mode, asserted in tests/router.test.ts.
// Two assertions, two mutations: breaking the literal reddens this file and leaves router.test
// green; removing the field from the payload reddens router.test and leaves this file green.
// That pairing is what proves they are two assertions rather than one check wearing two names.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const raw = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(raw) as { name?: string; version?: string };

describe("advertised version", () => {
  // POSITIVE CONTROL, and it runs first on purpose: if package.json moved, was renamed, or
  // stopped parsing, `pkg.version` is undefined and every assertion below would compare against
  // nothing. An undefined expected value makes a drift test fail for a reason that has nothing
  // to do with drift, so name that failure separately rather than letting it wear drift's
  // clothes. A broken reader must not be able to look like either a pass or a version mismatch.
  it("reads a real version out of package.json (control: the reader is not blind)", () => {
    expect(pkg.name).toBe("prism-control-plane");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("matches package.json, so a release bump cannot leave the wire behind", () => {
    expect(VERSION).toBe(pkg.version);
  });
});
