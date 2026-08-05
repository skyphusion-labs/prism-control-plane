// THE PRIVACY GATE, as a test rather than as a habit.
//
// docs/CONTRACT.md makes a binding promise: this plane never persists prompt or completion text. A promise
// like that decays one convenient debug column at a time, so it is enforced against the migrations
// themselves. Adding a column that could hold message content fails the build.
//
// A green gate that cannot observe its own failure is not a gate, so this file also asserts that the
// scanner still finds a planted violation. Without that, a scanner broken by a refactor would report
// "no violations found" forever and read exactly like success.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

/**
 * Strip SQL comments before scanning.
 *
 * LOAD-BEARING, not tidiness. The migration's own comments discuss prompts and message content at length
 * (explaining why none is stored), so a scanner that read comments would fail on the documentation of the
 * very rule it enforces, and the obvious "fix" would be to delete the explanation.
 */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

/**
 * Words that must not appear as identifiers in the schema.
 *
 * Deliberately broad, and false positives are the POINT: a column called `summary` or `title` probably
 * holds something a user typed, and the reviewer who wants one should have to argue for it in a PR rather
 * than land it silently.
 */
const FORBIDDEN = [
  "prompt",
  "completion",
  "content",
  "message",
  "messages",
  "transcript",
  "body",
  "summary",
  "title",
  "answer",
  "question",
];

/**
 * Tokenize on non-alphanumerics AND on underscores.
 *
 * SPLITTING ON UNDERSCORE IS THE WHOLE TRICK, and getting it wrong is what the positive control below
 * caught on the first run: `\bprompt\b` does NOT match `prompt_text`, because `_` is a word character, so
 * a boundary-based scanner sails past every realistically-named violation. SQL identifiers are
 * snake_case, so the parts are what must be compared.
 */
function violations(sql: string): string[] {
  const words = new Set(
    stripSqlComments(sql)
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .flatMap((token) => token.split("_"))
      .filter(Boolean),
  );
  return FORBIDDEN.filter((word) => words.has(word));
}

describe("schema privacy invariant", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));

  it("has migrations to check", () => {
    // Otherwise this whole file passes vacuously on a repo whose migrations moved.
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} stores no prompt or completion text`, () => {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      expect(violations(sql)).toEqual([]);
    });
  }

  it("still detects a planted violation", () => {
    expect(
      violations(`CREATE TABLE usage_events (id TEXT PRIMARY KEY, prompt_text TEXT);`),
    ).toContain("prompt");
  });

  it("does not fire on comments that discuss the rule", () => {
    expect(violations(`-- no prompt or completion content is stored here\nCREATE TABLE t (id TEXT);`)).toEqual(
      [],
    );
  });
});
