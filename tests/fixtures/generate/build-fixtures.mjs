// Build tests/fixtures/apple-jws-fixtures.ts from the material regenerate.sh made.
// Invoked by that script; not meant to be run on its own.
import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, sign as nodeSign, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const [work, repoRoot] = process.argv.slice(2);
if (!work || !repoRoot) {
  console.error("usage: build-fixtures.mjs <workdir> <repoRoot>");
  process.exit(1);
}

const derB64 = (f) => readFileSync(`${work}/${f}`).toString("base64");
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Signatures are re-rolled until every base64url segment is free of "_". That is not
// cosmetic. A decoder that mishandles "_" refuses the bytes before they ever reach
// the curve, which is a different refusal from a signature that genuinely does not
// verify -- and a fixture that tripped it would be refused for the wrong reason.
function makeJws(keyFile, x5c, payload) {
  const key = createPrivateKey(readFileSync(`${work}/${keyFile}`));
  const h = b64url(Buffer.from(JSON.stringify({ alg: "ES256", x5c })));
  const p = b64url(Buffer.from(JSON.stringify(payload)));
  if (h.includes("_") || p.includes("_")) throw new Error("header/payload carry _");
  const input = Buffer.from(`${h}.${p}`, "utf8");
  for (let i = 0; i < 20000; i++) {
    const sig = nodeSign("sha256", input, { key, dsaEncoding: "ieee-p1363" });
    if (sig.length !== 64) throw new Error(`expected a 64-byte P1363 signature, got ${sig.length}`);
    const s = b64url(sig);
    if (!s.includes("_")) return `${h}.${p}.${s}`;
  }
  throw new Error("no _-free signature found in 20000 attempts");
}

const BASE = {
  productId: "org.skyphusion.prism.credit.50",
  bundleId: "org.skyphusion.prism",
  environment: "Production",
  type: "Consumable",
  purchaseDate: 1754500000000,
};

const forgedJws = makeJws("forged-leaf.key", [derB64("forged-leaf.der"), derB64("filler.der")], {
  ...BASE,
  transactionId: "forged0001",
  originalTransactionId: "forged0001",
});
const forgedMarkedJws = makeJws(
  "marked-leaf.key",
  [derB64("marked-leaf.der"), derB64("marked-int.der")],
  { ...BASE, transactionId: "forgedmarked1", originalTransactionId: "forgedmarked1" },
);
const testChainJws = makeJws(
  "test-leaf.key",
  [derB64("test-leaf.der"), derB64("test-int.der"), derB64("test-root.der")],
  { ...BASE, transactionId: "testchain0001", originalTransactionId: "testchain0001" },
);
const parts = testChainJws.split(".");
const tamperedPayload = b64url(
  Buffer.from(JSON.stringify({ ...BASE, transactionId: "tampered0001" })),
);
if (tamperedPayload.includes("_")) throw new Error("tampered payload carries _");
const tamperedJws = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

const appleRoot = readFileSync(`${work}/AppleRootCA-G3.cer`);
const appleWwdr = readFileSync(`${work}/AppleWWDRCAG6.cer`);
const fp = (b) => createHash("sha256").update(b).digest("hex").toUpperCase().match(/../g).join(":");

// Report the leaf's validity window, because the certificates are minted at
// generation time: a naive midnight-UTC "now" lands BEFORE notBefore for part of
// every day, and a test that picks one gets a refusal that has nothing to do with
// the thing under test.
const startdate = execFileSync("openssl", ["x509", "-in", `${work}/test-leaf.pem`, "-noout", "-startdate"])
  .toString()
  .trim();
console.log(`Apple Root CA G3 sha256 ${fp(appleRoot)}`);
console.log(`test hierarchy ${startdate} -- pick a test "now" comfortably after this`);

const wrap = (s) => (s.match(/.{1,88}/g) ?? []).map((l) => `  "${l}"`).join(" +\n");
const entry = (name, value, doc) => `${doc}\nexport const ${name} =\n${wrap(value)};\n`;

const out = `// Test fixtures for the App Store JWS chain checks.
//
// GENERATED. Do not hand-edit: run \`bash tests/fixtures/generate/regenerate.sh\`
// from the repository root, which re-fetches Apple's published certificates,
// rebuilds every hierarchy, verifies each one with openssl, and rewrites this file.
//
// The two Apple certificates are the genuine published articles from
// https://www.apple.com/certificateauthority/ . They give the suite a POSITIVE
// control built from a real Apple signature, which matters because we hold no
// Apple-issued leaf key and so the pinned anchor can otherwise only ever be
// observed refusing. Everything else is throwaway test material; no production key
// is involved and none of these keys sign anything outside this suite.
//
//   FORGED_SELF_SIGNED_JWS    a self-signed leaf carrying Apple's own leaf subject
//                             name, plus an arbitrary second certificate. A name is
//                             not an identity.
//   FORGED_MARKED_JWS         a self-signed hierarchy that ALSO copies both of
//                             Apple's marker extension OIDs. This is the fixture
//                             that proves the pinned anchor is load-bearing rather
//                             than the marker checks happening to refuse first.
//   TEST_CHAIN_*              a complete root -> intermediate -> leaf hierarchy
//                             carrying the real Apple marker OIDs, so the only
//                             thing a test changes is the trust anchor. Root and
//                             intermediate are P-384/SHA-384 and the leaf is
//                             P-256/SHA-256, matching the real Apple shape.
//   TEST_CHAIN_LEAF_NO_MARKER_DER_B64
//                             the same leaf minus the App Store marker, so that
//                             check can be negative-tested with one variable moved.
//   TAMPERED_TEST_CHAIN_JWS   the same valid chain and signature bytes over a
//                             DIFFERENT payload, proving the signature step is still
//                             enforced once the chain has validated.
//   OTHER_TEST_ROOT_DER_B64   an unrelated CA that signed nothing here.
//
// The test certificates are minted at generation time, so notBefore is that moment.
// Tests must pick a "now" comfortably inside the window.

${entry("FORGED_SELF_SIGNED_JWS", forgedJws, "/** Self-signed leaf, no marker OIDs, no path to any real CA. */")}
${entry("FORGED_MARKED_JWS", forgedMarkedJws, "/** Self-signed hierarchy that copies both Apple marker OIDs. Must still be refused. */")}
${entry("TEST_CHAIN_JWS", testChainJws, "/** Signed by TEST_CHAIN_LEAF, chaining to TEST_CHAIN_ROOT. Carries its root as x5c[2]. */")}
${entry("TAMPERED_TEST_CHAIN_JWS", tamperedJws, "/** Valid chain, signature does not cover the payload. */")}
${entry("TEST_CHAIN_ROOT_DER_B64", derB64("test-root.der"), "/** Test anchor, P-384, self-signed, CA:TRUE. */")}
${entry("TEST_CHAIN_INTERMEDIATE_DER_B64", derB64("test-int.der"), "/** Test intermediate, P-384, CA:TRUE, WWDR marker, issued by TEST_CHAIN_ROOT. */")}
${entry("TEST_CHAIN_LEAF_DER_B64", derB64("test-leaf.der"), "/** Test leaf, P-256, CA:FALSE, App Store marker, issued by TEST_CHAIN_INTERMEDIATE. */")}
${entry("TEST_CHAIN_LEAF_NO_MARKER_DER_B64", derB64("test-leaf-nomarker.der"), "/** As above but WITHOUT the App Store marker. */")}
${entry("OTHER_TEST_ROOT_DER_B64", derB64("other-root.der"), "/** An unrelated CA, P-384, no marker OIDs. */")}
${entry("FORGED_LEAF_DER_B64", derB64("forged-leaf.der"), "/** The naive self-signed leaf on its own. */")}
${entry("FILLER_CERT_DER_B64", derB64("filler.der"), "/** An arbitrary second cert, present only to satisfy a length check. */")}
${entry("MARKED_FORGED_LEAF_DER_B64", derB64("marked-leaf.der"), "/** Forged leaf carrying Apple's App Store marker OID. */")}
${entry("MARKED_FORGED_INTERMEDIATE_DER_B64", derB64("marked-int.der"), "/** Forged CA carrying Apple's WWDR marker OID. */")}
${entry("APPLE_ROOT_CA_G3_DER_B64_FIXTURE", appleRoot.toString("base64"), "/** The genuine Apple Root CA G3, as published by Apple. */")}
${entry("APPLE_WWDR_CA_G6_DER_B64", appleWwdr.toString("base64"), "/** The genuine Apple WWDR CA G6 intermediate, issued by Apple Root CA G3. */")}`;

writeFileSync(`${repoRoot}/tests/fixtures/apple-jws-fixtures.ts`, out);
