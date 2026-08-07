// Chain validation for App Store signed transaction JWS.
//
// The suite is built so no assertion here can pass vacuously:
//   - every refusal is asserted BY NAME. A bare `ok === false` is produced both by
//     an intact guard and by a wide-open one that happens to trip a later check, so
//     it cannot distinguish the two states it exists to distinguish.
//   - the accepting path is exercised against a purpose-built hierarchy, so the
//     suite can observe a PASS and not only failures.
//   - one link is checked against genuine Apple certificates, so at least one
//     positive result comes from a real Apple signature rather than from ours.
//   - the trust anchor is the only thing the test hierarchy changes. The policy --
//     both marker OIDs, the CA constraint, the issuance links, the validity windows
//     -- is fixed in the module and is the same code production runs.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  APPLE_MARKER_OIDS,
  decodeAppleTransactionJws,
  pinnedAppleRoot,
  verifyAppleCertChain,
  verifyAppleTransactionJws,
  verifyAppleTransactionJwsAgainstAnchor,
} from "../src/apple-jws";
import { APPLE_ROOT_CA_G3_DER_B64, APPLE_ROOT_CA_G3_SHA256 } from "../src/apple-root-ca";
import {
  certValidAt,
  derEcdsaToP1363,
  importEcPublicKey,
  parseCertificate,
  verifyCertificateSignedBy,
  verifyEcdsa,
} from "../src/x509";
import {
  APPLE_ROOT_CA_G3_DER_B64_FIXTURE,
  APPLE_WWDR_CA_G6_DER_B64,
  FILLER_CERT_DER_B64,
  FORGED_LEAF_DER_B64,
  FORGED_MARKED_JWS,
  FORGED_SELF_SIGNED_JWS,
  MARKED_FORGED_INTERMEDIATE_DER_B64,
  MARKED_FORGED_LEAF_DER_B64,
  OTHER_TEST_ROOT_DER_B64,
  TAMPERED_TEST_CHAIN_JWS,
  TEST_CHAIN_INTERMEDIATE_DER_B64,
  TEST_CHAIN_JWS,
  TEST_CHAIN_LEAF_DER_B64,
  TEST_CHAIN_LEAF_NO_MARKER_DER_B64,
  TEST_CHAIN_ROOT_DER_B64,
} from "./fixtures/apple-jws-fixtures";

const der = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const fingerprint = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex").toUpperCase().match(/../g)!.join(":");

/** Inside every fixture validity window, and fixed so the suite cannot rot. */
const NOW = Date.UTC(2030, 0, 1);

const b64url = (s: string): string =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("pinned trust anchor", () => {
  it("is the published Apple Root CA G3, byte for byte", () => {
    // The shipped constant, the copy fetched from Apple, and Apple's published
    // fingerprint must all agree. Any one of the three moving fails the suite,
    // so an anchor cannot be substituted quietly.
    expect(APPLE_ROOT_CA_G3_DER_B64).toBe(APPLE_ROOT_CA_G3_DER_B64_FIXTURE);
    expect(fingerprint(der(APPLE_ROOT_CA_G3_DER_B64))).toBe(APPLE_ROOT_CA_G3_SHA256);
    expect(APPLE_ROOT_CA_G3_SHA256).toBe(
      "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79",
    );
  });

  it("parses, is self-issued, is a CA, and is P-384", () => {
    const anchor = pinnedAppleRoot();
    expect(anchor).not.toBeNull();
    expect(anchor!.curve).toBe("P-384");
    expect(anchor!.isCa).toBe(true);
    expect(Buffer.from(anchor!.issuer)).toEqual(Buffer.from(anchor!.subject));
    // The validity check reads both ways on a real certificate.
    expect(certValidAt(anchor!, Date.UTC(2026, 0, 1))).toBe(true);
    expect(certValidAt(anchor!, Date.UTC(2013, 0, 1))).toBe(false);
    expect(certValidAt(anchor!, Date.UTC(2045, 0, 1))).toBe(false);
  });
});

describe("marker OIDs, checked against real Apple certificates", () => {
  const root = parseCertificate(der(APPLE_ROOT_CA_G3_DER_B64))!;
  const wwdr = parseCertificate(der(APPLE_WWDR_CA_G6_DER_B64))!;

  it("finds Apple's WWDR marker where it belongs and nowhere else", () => {
    // POSITIVE: the marker required of an intermediate is present on the real one.
    expect(wwdr.extensionOids).toContain(APPLE_MARKER_OIDS.intermediate);
    // NEGATIVE: the same matcher does not fire on certificates that lack it, so a
    // hit is evidence about the certificate and not about the matcher.
    expect(root.extensionOids).not.toContain(APPLE_MARKER_OIDS.intermediate);
    expect(root.extensionOids).not.toContain(APPLE_MARKER_OIDS.leaf);
    expect(wwdr.extensionOids).not.toContain(APPLE_MARKER_OIDS.leaf);
  });

  it("reads basicConstraints CA from real certificates, both ways", () => {
    expect(root.isCa).toBe(true);
    expect(wwdr.isCa).toBe(true);
    expect(parseCertificate(der(TEST_CHAIN_LEAF_DER_B64))!.isCa).toBe(false);
  });
});

describe("chain links against genuine Apple certificates", () => {
  it("accepts the real Apple WWDR G6 as issued by the pinned root", async () => {
    // The strongest positive control available without an Apple-issued leaf key:
    // a real Apple certificate, a real Apple P-384/SHA-384 signature, the pinned
    // anchor, and the shipped code.
    const wwdr = parseCertificate(der(APPLE_WWDR_CA_G6_DER_B64))!;
    expect(await verifyCertificateSignedBy(wwdr, pinnedAppleRoot()!)).toBe(true);
  });

  it("refuses that same real certificate under a different anchor", async () => {
    // Proves the assertion above is about the signature, not about the code saying
    // true for any well-formed certificate.
    const wwdr = parseCertificate(der(APPLE_WWDR_CA_G6_DER_B64))!;
    const other = parseCertificate(der(OTHER_TEST_ROOT_DER_B64))!;
    expect(await verifyCertificateSignedBy(wwdr, other)).toBe(false);
  });
});

describe("verifyAppleCertChain on a purpose-built hierarchy", () => {
  const leaf = der(TEST_CHAIN_LEAF_DER_B64);
  const intermediate = der(TEST_CHAIN_INTERMEDIATE_DER_B64);
  const anchor = parseCertificate(der(TEST_CHAIN_ROOT_DER_B64))!;

  it("ACCEPTS a well-formed chain under the matching anchor", async () => {
    const r = await verifyAppleCertChain(leaf, intermediate, anchor, NOW);
    expect(r.ok).toBe(true);
  });

  it("refuses the same chain under a different anchor", async () => {
    const other = parseCertificate(der(OTHER_TEST_ROOT_DER_B64))!;
    expect(await verifyAppleCertChain(leaf, intermediate, other, NOW)).toEqual({
      ok: false,
      reason: "intermediate_not_issued_by_pinned_root",
    });
  });

  it("refuses a leaf not issued by the presented intermediate", async () => {
    // The marked forgery's leaf carries every marker and is a valid certificate;
    // it simply was not issued by this intermediate.
    expect(
      await verifyAppleCertChain(der(MARKED_FORGED_LEAF_DER_B64), intermediate, anchor, NOW),
    ).toEqual({ ok: false, reason: "leaf_not_issued_by_intermediate" });
  });

  it("refuses a leaf missing the App Store marker", async () => {
    // Same issuer, same anchor, same validity: only the marker differs.
    expect(
      await verifyAppleCertChain(der(TEST_CHAIN_LEAF_NO_MARKER_DER_B64), intermediate, anchor, NOW),
    ).toEqual({ ok: false, reason: "leaf_missing_app_store_marker" });
  });

  it("refuses an intermediate missing the WWDR marker", async () => {
    // OTHER_TEST_ROOT is a CA and carries no marker, so this reaches the marker
    // check rather than the CA check.
    expect(
      await verifyAppleCertChain(leaf, der(OTHER_TEST_ROOT_DER_B64), anchor, NOW),
    ).toEqual({ ok: false, reason: "intermediate_missing_apple_wwdr_marker" });
  });

  it("refuses an intermediate that is not a CA", async () => {
    expect(await verifyAppleCertChain(leaf, leaf, anchor, NOW)).toEqual({
      ok: false,
      reason: "intermediate_not_ca",
    });
  });

  it("refuses outside the validity window, in both directions", async () => {
    expect(await verifyAppleCertChain(leaf, intermediate, anchor, Date.UTC(1999, 0, 1))).toEqual({
      ok: false,
      reason: "certificate_outside_validity_window",
    });
    expect(await verifyAppleCertChain(leaf, intermediate, anchor, Date.UTC(2400, 0, 1))).toEqual({
      ok: false,
      reason: "certificate_outside_validity_window",
    });
  });

  it("refuses unparseable certificate bytes", async () => {
    expect(await verifyAppleCertChain(new Uint8Array([1, 2, 3]), intermediate, anchor, NOW)).toEqual({
      ok: false,
      reason: "leaf_parse_failed",
    });
    expect(await verifyAppleCertChain(leaf, new Uint8Array([1, 2, 3]), anchor, NOW)).toEqual({
      ok: false,
      reason: "intermediate_parse_failed",
    });
  });
});

describe("verifyAppleTransactionJws against the PINNED Apple anchor", () => {
  it("refuses a self-signed JWS", async () => {
    expect(await verifyAppleTransactionJws(FORGED_SELF_SIGNED_JWS)).toEqual({
      ok: false,
      reason: "intermediate_missing_apple_wwdr_marker",
    });
  });

  it("refuses a self-signed JWS that copies BOTH Apple marker OIDs", async () => {
    // This is the case that proves the pinned anchor is load-bearing. Every check
    // short of anchoring passes: the leaf carries the App Store marker, the
    // intermediate carries the WWDR marker and is a CA, the leaf really was issued
    // by that intermediate, the dates are valid, and the JWS signature is genuine
    // for the key presented. It is refused because the chain stops somewhere that
    // is not Apple's root.
    expect(await verifyAppleTransactionJws(FORGED_MARKED_JWS)).toEqual({
      ok: false,
      reason: "intermediate_not_issued_by_pinned_root",
    });
  });

  it("CONTROL: that marked forgery is internally consistent under its OWN anchor", async () => {
    // Without this the test above would be satisfied by a fixture that is simply
    // broken, and the refusal would say nothing about anchoring.
    const ownAnchor = parseCertificate(der(MARKED_FORGED_INTERMEDIATE_DER_B64))!;
    const r = await verifyAppleCertChain(
      der(MARKED_FORGED_LEAF_DER_B64),
      der(MARKED_FORGED_INTERMEDIATE_DER_B64),
      ownAnchor,
      NOW,
    );
    expect(r.ok).toBe(true);
  });

  it("CONTROL: the forgeries still decode and still claim Production credit", () => {
    // Establishes that the refusals above are the chain check firing, and not the
    // payload being unreadable.
    for (const jws of [FORGED_SELF_SIGNED_JWS, FORGED_MARKED_JWS]) {
      expect(decodeAppleTransactionJws(jws)).toMatchObject({
        productId: "org.skyphusion.prism.credit.50",
        bundleId: "org.skyphusion.prism",
        environment: "Production",
      });
    }
  });

  it("refuses a chain that is internally valid but anchored elsewhere", async () => {
    expect(await verifyAppleTransactionJws(TEST_CHAIN_JWS)).toEqual({
      ok: false,
      reason: "intermediate_not_issued_by_pinned_root",
    });
  });

  it("ignores a root supplied inside x5c", async () => {
    // TEST_CHAIN_JWS carries its own root as x5c[2]. Presenting a root must not
    // make it trusted, so the verdict is identical with and without it.
    const parts = TEST_CHAIN_JWS.split(".");
    const header = JSON.parse(
      Buffer.from(parts[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
    ) as { alg: string; x5c: string[] };
    expect(header.x5c).toHaveLength(3);
    const twoOnly = b64url(JSON.stringify({ alg: header.alg, x5c: header.x5c.slice(0, 2) }));
    const withoutRoot = await verifyAppleTransactionJws(`${twoOnly}.${parts[1]}.${parts[2]}`);
    expect(withoutRoot).toEqual({ ok: false, reason: "intermediate_not_issued_by_pinned_root" });
    expect(await verifyAppleTransactionJws(TEST_CHAIN_JWS)).toEqual(withoutRoot);
  });

  it("refuses a JWS carrying no x5c at all", async () => {
    const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT" }));
    const payload = b64url(JSON.stringify({ transactionId: "1", productId: "p", bundleId: "b" }));
    expect(await verifyAppleTransactionJws(`${header}.${payload}.AAAA`)).toEqual({
      ok: false,
      reason: "missing_x5c",
    });
  });

  it("refuses an x5c carrying only a leaf", async () => {
    const header = b64url(JSON.stringify({ alg: "ES256", x5c: [FORGED_LEAF_DER_B64] }));
    expect(await verifyAppleTransactionJws(`${header}.AAAA.AAAA`)).toEqual({
      ok: false,
      reason: "x5c_too_short",
    });
  });

  it("refuses an algorithm other than ES256", async () => {
    const header = b64url(
      JSON.stringify({ alg: "none", x5c: [FORGED_LEAF_DER_B64, FILLER_CERT_DER_B64] }),
    );
    expect(await verifyAppleTransactionJws(`${header}.AAAA.AAAA`)).toEqual({
      ok: false,
      reason: "unsupported_alg",
    });
  });

  it("refuses a malformed compact form", async () => {
    expect(await verifyAppleTransactionJws("a.b")).toEqual({ ok: false, reason: "malformed_jws" });
  });
});

describe("the full pipeline, driven end to end against the test anchor", () => {
  const anchor = () => parseCertificate(der(TEST_CHAIN_ROOT_DER_B64))!;

  it("ACCEPTS a genuine JWS whose chain reaches the supplied anchor", async () => {
    // The only place this suite can observe the accepting path of the SHIPPED
    // pipeline. Without it every assertion here would be a refusal, and a function
    // that only ever refuses is indistinguishable from one that cannot accept.
    expect(await verifyAppleTransactionJwsAgainstAnchor(TEST_CHAIN_JWS, anchor(), NOW)).toEqual({
      ok: true,
    });
  });

  it("refuses a signature that does not cover the payload", async () => {
    // Same chain, same signature bytes, different payload. Reaches the signature
    // step only because the chain above it passed, so this asserts the signature
    // check specifically rather than the chain refusing first.
    expect(
      await verifyAppleTransactionJwsAgainstAnchor(TAMPERED_TEST_CHAIN_JWS, anchor(), NOW),
    ).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("decodes a signature segment containing _ rather than rejecting it as malformed", async () => {
    // The distinction is the whole point. A decoder that mishandles "_" reports
    // signature_malformed, because the bytes never reach the curve; a correct one
    // reports signature_invalid, because they do and the maths says no. Both are
    // refusals, so a test asserting only "not ok" could not tell them apart -- and
    // in production the difference is every genuine purchase whose signature
    // happens to contain "_", which is about three in four.
    const parts = TEST_CHAIN_JWS.split(".");
    const toB64Url = (b: Uint8Array): string =>
      Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    let withUnderscore: string | null = null;
    let withoutUnderscore: string | null = null;
    for (let i = 0; i < 500 && !(withUnderscore && withoutUnderscore); i++) {
      const s = toB64Url(crypto.getRandomValues(new Uint8Array(64)));
      if (s.includes("_")) withUnderscore ??= s;
      else withoutUnderscore ??= s;
    }
    // Harness floor: if either sample is missing the loop is broken, not the code.
    expect(withUnderscore).not.toBeNull();
    expect(withoutUnderscore).not.toBeNull();

    const verdictFor = async (sig: string) =>
      verifyAppleTransactionJwsAgainstAnchor(`${parts[0]}.${parts[1]}.${sig}`, anchor(), NOW);

    // CONTROL: a "_"-free signature of the same length reaches the curve.
    expect(await verdictFor(withoutUnderscore!)).toEqual({ ok: false, reason: "signature_invalid" });
    // SUBJECT: so does one carrying "_".
    expect(await verdictFor(withUnderscore!)).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("refuses a signature of the wrong length as malformed, not invalid", async () => {
    // Proves signature_malformed is reachable, so the assertions above are choosing
    // between two live outcomes rather than one that can never occur.
    const parts = TEST_CHAIN_JWS.split(".");
    expect(await verifyAppleTransactionJwsAgainstAnchor(`${parts[0]}.${parts[1]}.AAAA`, anchor(), NOW)).toEqual(
      { ok: false, reason: "signature_malformed" },
    );
  });
});

describe("the production call site", () => {
  it("redeem uses the anchor-free entry point", () => {
    // Read from the repo root, which is vitest's cwd. A wrong path throws rather
    // than returning empty, and the positive control below proves we read the file
    // we meant to.
    const src = readFileSync("src/routes/store.ts", "utf8");
    // POSITIVE control: the string this matcher is looking for is really present,
    // so a later zero would be a fact about the file and not about the matcher.
    expect(src).toContain("verifyAppleTransactionJws(signed)");
    // The route must not reach for the anchor-injecting form, which exists for tests.
    expect(src).not.toContain("verifyAppleTransactionJwsAgainstAnchor");
    expect(src).not.toContain("verifyAppleCertChain");
  });
});

describe("base64url decoding", () => {
  it("refuses characters outside the base64url alphabet rather than guessing", () => {
    expect(decodeAppleTransactionJws("a.!!!!.c")).toBeNull();
  });

  it("decodes payload segments unchanged", () => {
    const toB64Url = (s: string): string =>
      Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const header = toB64Url(JSON.stringify({ alg: "ES256" }));
    const payload = toB64Url(
      JSON.stringify({ transactionId: "2000000123456789", productId: "p", bundleId: "b" }),
    );
    expect(decodeAppleTransactionJws(`${header}.${payload}.AAAA`)).toMatchObject({
      transactionId: "2000000123456789",
    });
  });
});

describe("DER ECDSA signature conversion", () => {
  it("left-pads short components to the coordinate width", () => {
    const sig = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]);
    const out = derEcdsaToP1363(sig, 32)!;
    expect(out.length).toBe(64);
    expect(out[31]).toBe(0x01);
    expect(out[63]).toBe(0x02);
    expect(out.slice(0, 31).every((b) => b === 0)).toBe(true);
  });

  it("refuses a component wider than the curve", () => {
    const big = new Uint8Array(34).fill(0x11);
    const sig = new Uint8Array([0x30, 0x26, 0x02, 0x22, ...big, 0x02, 0x01, 0x02]);
    expect(derEcdsaToP1363(sig, 32)).toBeNull();
  });

  it("refuses non-DER input", () => {
    expect(derEcdsaToP1363(new Uint8Array([1, 2, 3]), 32)).toBeNull();
  });
});
