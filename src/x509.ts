// Minimal DER / X.509 reader, enough to validate an ECDSA certificate chain.
//
// Scope, stated so nobody mistakes this for a general X.509 implementation:
//   - ECDSA P-256 and P-384 subject keys only
//   - ecdsa-with-SHA256 and ecdsa-with-SHA384 signatures only
//   - definite-length DER only (indefinite length is refused, not tolerated)
//   - name comparison is byte equality of the encoded Name, not RFC 4518 string prep
//   - no CRL, no OCSP, no name constraints, no path-length enforcement
//
// That is deliberate. The consumer (src/apple-jws.ts) validates one fixed shape --
// an Apple App Store leaf, its Apple WWDR intermediate, and a pinned Apple root --
// and anything outside that shape must be REFUSED rather than best-guessed. Every
// function here returns null on anything it does not fully understand; none of them
// fall back to a permissive reading.
//
// WebCrypto is used for the signature maths. Workers and Node both implement ECDSA
// P-256/P-384 verify and SPKI import, which is the only platform surface required.

/** A parsed DER tag-length-value. Offsets are absolute within the source buffer. */
export interface Tlv {
  tag: number;
  start: number;
  contentStart: number;
  contentEnd: number;
  /** One past the final byte of this TLV, i.e. the start of the next one. */
  end: number;
}

/** Read one TLV at `off`. Returns null for anything malformed or non-definite-length. */
export function readTlv(buf: Uint8Array, off: number): Tlv | null {
  if (off < 0 || off + 2 > buf.length) return null;
  const tag = buf[off];
  // Multi-byte tags are not used anywhere in the certificates we accept.
  if ((tag & 0x1f) === 0x1f) return null;
  let p = off + 1;
  const first = buf[p++];
  let len: number;
  if (first < 0x80) {
    len = first;
  } else {
    const n = first & 0x7f;
    // n === 0 is the indefinite form, illegal in DER. Cap at 4 bytes of length.
    if (n === 0 || n > 4 || p + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
    if (len > buf.length) return null;
  }
  const contentStart = p;
  const contentEnd = p + len;
  if (contentEnd > buf.length) return null;
  return { tag, start: off, contentStart, contentEnd, end: contentEnd };
}

const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
const TAG_BOOLEAN = 0x01;
const TAG_SEQUENCE = 0x30;
const TAG_UTC_TIME = 0x17;
const TAG_GENERALIZED_TIME = 0x18;

/**
 * DER encodings of the OIDs this module understands, as lowercase hex of the
 * complete TLV (tag 0x06, length, content). Verified byte-for-byte against the
 * real Apple Root CA G3 and Apple WWDR CA G6 certificates, with negative controls,
 * by tests/apple-jws-chain.test.ts.
 */
export const OID = {
  /** 1.2.840.10045.2.1 -- id-ecPublicKey */
  ecPublicKey: "06072a8648ce3d0201",
  /** 1.2.840.10045.3.1.7 -- prime256v1 / NIST P-256 */
  p256: "06082a8648ce3d030107",
  /** 1.3.132.0.34 -- secp384r1 / NIST P-384 */
  p384: "06052b81040022",
  /** 1.2.840.10045.4.3.2 -- ecdsa-with-SHA256 */
  ecdsaWithSha256: "06082a8648ce3d040302",
  /** 1.2.840.10045.4.3.3 -- ecdsa-with-SHA384 */
  ecdsaWithSha384: "06082a8648ce3d040303",
  /** 2.5.29.19 -- basicConstraints */
  basicConstraints: "0603551d13",
} as const;

export type EcCurve = "P-256" | "P-384";
export type EcHash = "SHA-256" | "SHA-384";

export interface ParsedCertificate {
  /** The whole certificate, as given. */
  der: Uint8Array;
  /** tbsCertificate, complete TLV. This is the byte range a signature covers. */
  tbs: Uint8Array;
  /** issuer Name, complete TLV, for byte-equality against a candidate issuer's subject. */
  issuer: Uint8Array;
  /** subject Name, complete TLV. */
  subject: Uint8Array;
  notBeforeMs: number;
  notAfterMs: number;
  /** subjectPublicKeyInfo, complete TLV, ready for crypto.subtle.importKey("spki", ...). */
  spki: Uint8Array;
  /** Curve of the subject public key. */
  curve: EcCurve;
  /** Digest used by the ISSUER when signing this certificate. */
  signatureHash: EcHash;
  /** signatureValue contents: a DER SEQUENCE { INTEGER r, INTEGER s }. */
  signature: Uint8Array;
  /** basicConstraints cA, false when the extension is absent. */
  isCa: boolean;
  /** extnID of every extension present, as lowercase hex of the complete OID TLV. */
  extensionOids: string[];
}

function hexOf(buf: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < to; i++) s += buf[i].toString(16).padStart(2, "0");
  return s;
}

/** Parse an ASN.1 UTCTime or GeneralizedTime. Only the Zulu forms DER permits. */
export function parseAsn1Time(buf: Uint8Array, tlv: Tlv): number | null {
  let text = "";
  for (let i = tlv.contentStart; i < tlv.contentEnd; i++) text += String.fromCharCode(buf[i]);
  let year: number;
  let rest: string;
  if (tlv.tag === TAG_UTC_TIME) {
    const m = /^(\d{2})(\d{10})Z$/.exec(text);
    if (!m) return null;
    const yy = Number(m[1]);
    // RFC 5280: 50..99 means 19xx, 00..49 means 20xx.
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
    rest = m[2];
  } else if (tlv.tag === TAG_GENERALIZED_TIME) {
    const m = /^(\d{4})(\d{10})Z$/.exec(text);
    if (!m) return null;
    year = Number(m[1]);
    rest = m[2];
  } else {
    return null;
  }
  const month = Number(rest.slice(0, 2));
  const day = Number(rest.slice(2, 4));
  const hour = Number(rest.slice(4, 6));
  const minute = Number(rest.slice(6, 8));
  const second = Number(rest.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
    return null;
  }
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/**
 * Parse an X.509 certificate. Returns null if the certificate is malformed, or if
 * it uses any algorithm outside the accepted set -- an unsupported certificate is
 * refused, never accepted on a weaker basis.
 */
export function parseCertificate(der: Uint8Array): ParsedCertificate | null {
  const cert = readTlv(der, 0);
  if (!cert || cert.tag !== TAG_SEQUENCE || cert.end !== der.length) return null;

  const tbs = readTlv(der, cert.contentStart);
  if (!tbs || tbs.tag !== TAG_SEQUENCE) return null;

  // signatureAlgorithm, which must agree with the one inside tbsCertificate.
  const sigAlg = readTlv(der, tbs.end);
  if (!sigAlg || sigAlg.tag !== TAG_SEQUENCE) return null;
  const sigAlgOid = readTlv(der, sigAlg.contentStart);
  if (!sigAlgOid || sigAlgOid.tag !== TAG_OID) return null;
  const sigAlgHex = hexOf(der, sigAlgOid.start, sigAlgOid.end);
  let signatureHash: EcHash;
  if (sigAlgHex === OID.ecdsaWithSha256) signatureHash = "SHA-256";
  else if (sigAlgHex === OID.ecdsaWithSha384) signatureHash = "SHA-384";
  else return null;

  const sigValue = readTlv(der, sigAlg.end);
  if (!sigValue || sigValue.tag !== TAG_BIT_STRING || sigValue.end !== cert.contentEnd) return null;
  // First content byte of a BIT STRING is the count of unused trailing bits.
  if (sigValue.contentEnd - sigValue.contentStart < 2) return null;
  if (der[sigValue.contentStart] !== 0x00) return null;
  const signature = der.subarray(sigValue.contentStart + 1, sigValue.contentEnd);

  // --- inside tbsCertificate ---
  let off = tbs.contentStart;
  // version [0] EXPLICIT, optional
  if (off < tbs.contentEnd && der[off] === 0xa0) {
    const v = readTlv(der, off);
    if (!v) return null;
    off = v.end;
  }
  const serial = readTlv(der, off);
  if (!serial || serial.tag !== TAG_INTEGER) return null;
  off = serial.end;

  const innerSigAlg = readTlv(der, off);
  if (!innerSigAlg || innerSigAlg.tag !== TAG_SEQUENCE) return null;
  // RFC 5280 4.1.1.2: the outer signatureAlgorithm MUST match tbsCertificate.signature.
  if (hexOf(der, innerSigAlg.start, innerSigAlg.end) !== hexOf(der, sigAlg.start, sigAlg.end)) {
    return null;
  }
  off = innerSigAlg.end;

  const issuer = readTlv(der, off);
  if (!issuer || issuer.tag !== TAG_SEQUENCE) return null;
  off = issuer.end;

  const validity = readTlv(der, off);
  if (!validity || validity.tag !== TAG_SEQUENCE) return null;
  const notBeforeTlv = readTlv(der, validity.contentStart);
  if (!notBeforeTlv) return null;
  const notAfterTlv = readTlv(der, notBeforeTlv.end);
  if (!notAfterTlv || notAfterTlv.end !== validity.contentEnd) return null;
  const notBeforeMs = parseAsn1Time(der, notBeforeTlv);
  const notAfterMs = parseAsn1Time(der, notAfterTlv);
  if (notBeforeMs == null || notAfterMs == null) return null;
  off = validity.end;

  const subject = readTlv(der, off);
  if (!subject || subject.tag !== TAG_SEQUENCE) return null;
  off = subject.end;

  const spkiTlv = readTlv(der, off);
  if (!spkiTlv || spkiTlv.tag !== TAG_SEQUENCE) return null;
  const spkiAlg = readTlv(der, spkiTlv.contentStart);
  if (!spkiAlg || spkiAlg.tag !== TAG_SEQUENCE) return null;
  const keyTypeOid = readTlv(der, spkiAlg.contentStart);
  if (!keyTypeOid || keyTypeOid.tag !== TAG_OID) return null;
  if (hexOf(der, keyTypeOid.start, keyTypeOid.end) !== OID.ecPublicKey) return null;
  const curveOid = readTlv(der, keyTypeOid.end);
  if (!curveOid || curveOid.tag !== TAG_OID || curveOid.end !== spkiAlg.contentEnd) return null;
  const curveHex = hexOf(der, curveOid.start, curveOid.end);
  let curve: EcCurve;
  if (curveHex === OID.p256) curve = "P-256";
  else if (curveHex === OID.p384) curve = "P-384";
  else return null;
  off = spkiTlv.end;

  // Optional issuerUniqueID [1], subjectUniqueID [2], extensions [3].
  let isCa = false;
  const extensionOids: string[] = [];
  while (off < tbs.contentEnd) {
    const t = readTlv(der, off);
    if (!t) return null;
    if (t.tag === 0xa3) {
      const extSeq = readTlv(der, t.contentStart);
      if (!extSeq || extSeq.tag !== TAG_SEQUENCE) return null;
      let e = extSeq.contentStart;
      while (e < extSeq.contentEnd) {
        const ext = readTlv(der, e);
        if (!ext || ext.tag !== TAG_SEQUENCE) return null;
        const extId = readTlv(der, ext.contentStart);
        if (!extId || extId.tag !== TAG_OID) return null;
        const extIdHex = hexOf(der, extId.start, extId.end);
        extensionOids.push(extIdHex);
        // critical BOOLEAN DEFAULT FALSE, then extnValue OCTET STRING
        let vOff = extId.end;
        const maybeCritical = readTlv(der, vOff);
        if (!maybeCritical) return null;
        if (maybeCritical.tag === TAG_BOOLEAN) vOff = maybeCritical.end;
        const extnValue = readTlv(der, vOff);
        if (!extnValue || extnValue.tag !== TAG_OCTET_STRING) return null;
        if (extIdHex === OID.basicConstraints) {
          // BasicConstraints ::= SEQUENCE { cA BOOLEAN DEFAULT FALSE, ... }
          const bc = readTlv(der, extnValue.contentStart);
          if (!bc || bc.tag !== TAG_SEQUENCE) return null;
          if (bc.contentEnd > bc.contentStart) {
            const ca = readTlv(der, bc.contentStart);
            if (ca && ca.tag === TAG_BOOLEAN && ca.contentEnd - ca.contentStart === 1) {
              isCa = der[ca.contentStart] !== 0x00;
            }
          }
        }
        e = ext.end;
      }
    }
    off = t.end;
  }

  return {
    der,
    tbs: der.subarray(tbs.start, tbs.end),
    issuer: der.subarray(issuer.start, issuer.end),
    subject: der.subarray(subject.start, subject.end),
    notBeforeMs,
    notAfterMs,
    spki: der.subarray(spkiTlv.start, spkiTlv.end),
    curve,
    signatureHash,
    signature,
    isCa,
    extensionOids,
  };
}

/** Byte equality. Used for Name comparison and for anchor identity. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Convert a DER ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }) to the fixed
 * width IEEE P1363 r||s form WebCrypto expects. `size` is the coordinate size of
 * the SIGNING key's curve: 32 for P-256, 48 for P-384.
 */
export function derEcdsaToP1363(sig: Uint8Array, size: number): Uint8Array | null {
  const seq = readTlv(sig, 0);
  if (!seq || seq.tag !== TAG_SEQUENCE || seq.end !== sig.length) return null;
  const r = readTlv(sig, seq.contentStart);
  if (!r || r.tag !== TAG_INTEGER) return null;
  const s = readTlv(sig, r.end);
  if (!s || s.tag !== TAG_INTEGER || s.end !== seq.contentEnd) return null;

  const out = new Uint8Array(size * 2);
  const place = (t: Tlv, at: number): boolean => {
    let from = t.contentStart;
    // Strip the leading 0x00 DER adds to keep a value positive.
    while (from < t.contentEnd - 1 && sig[from] === 0x00) from++;
    const len = t.contentEnd - from;
    if (len > size || len === 0) return false;
    out.set(sig.subarray(from, t.contentEnd), at + size - len);
    return true;
  };
  if (!place(r, 0) || !place(s, size)) return null;
  return out;
}

/** Copy into a plain ArrayBuffer, which importKey/verify require. */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

/** Import a certificate's subjectPublicKeyInfo as an ECDSA verify key. */
export async function importEcPublicKey(cert: ParsedCertificate): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.importKey(
      "spki",
      toArrayBuffer(cert.spki),
      { name: "ECDSA", namedCurve: cert.curve },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
}

/** Verify an ECDSA signature over `data` with an already-imported key. */
export async function verifyEcdsa(
  key: CryptoKey,
  hash: EcHash,
  signatureP1363: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      { name: "ECDSA", hash },
      key,
      toArrayBuffer(signatureP1363),
      toArrayBuffer(data),
    );
  } catch {
    return false;
  }
}

/**
 * Verify that `child` was signed by `issuer`. Checks the encoded issuer/subject
 * Names match byte-for-byte and that the signature over child.tbs verifies under
 * the issuer's public key.
 */
export async function verifyCertificateSignedBy(
  child: ParsedCertificate,
  issuer: ParsedCertificate,
): Promise<boolean> {
  if (!bytesEqual(child.issuer, issuer.subject)) return false;
  const key = await importEcPublicKey(issuer);
  if (!key) return false;
  const size = issuer.curve === "P-384" ? 48 : 32;
  const raw = derEcdsaToP1363(child.signature, size);
  if (!raw) return false;
  return verifyEcdsa(key, child.signatureHash, raw, child.tbs);
}

/** True when `nowMs` lies inside the certificate's validity window, inclusive. */
export function certValidAt(cert: ParsedCertificate, nowMs: number): boolean {
  return nowMs >= cert.notBeforeMs && nowMs <= cert.notAfterMs;
}
