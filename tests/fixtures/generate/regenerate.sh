#!/usr/bin/env bash
#
# Regenerate tests/fixtures/apple-jws-fixtures.ts.
#
# Run from the repository root:   bash tests/fixtures/generate/regenerate.sh
#
# Two kinds of material end up in the fixture module.
#
#   1. The genuine Apple Root CA G3 and Apple WWDR CA G6 certificates, fetched from
#      Apple. These give the suite a positive control built from a real Apple
#      signature, which matters because we hold no Apple-issued leaf key: without
#      them the pinned anchor could only ever be observed refusing.
#
#   2. Throwaway certificates and JWS blobs generated here. No production key is
#      involved and none of these keys sign anything outside the test suite.
#
# The script is deliberately noisy: it verifies each hierarchy with openssl before
# emitting anything, so a later refusal by our own code is a fact about our code and
# not about a broken fixture.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

APPLE_LEAF_MARKER=1.2.840.113635.100.6.11.1   # Apple App Store signing marker
APPLE_WWDR_MARKER=1.2.840.113635.100.6.2.1    # Apple WWDR CA marker

echo "== fetching Apple's published certificates =="
curl -fsS --max-time 30 -o AppleRootCA-G3.cer \
  https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
curl -fsS --max-time 30 -o AppleWWDRCAG6.cer \
  https://www.apple.com/certificateauthority/AppleWWDRCAG6.cer

# Apple publishes this fingerprint for the root. Assert it here so a substituted or
# corrupted download fails loudly rather than becoming the suite's trust anchor.
EXPECTED_ROOT_SHA=63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179
ACTUAL_ROOT_SHA="$(openssl dgst -sha256 -r AppleRootCA-G3.cer | cut -d' ' -f1 | tr 'a-f' 'A-F')"
if [ "$ACTUAL_ROOT_SHA" != "$EXPECTED_ROOT_SHA" ]; then
  echo "REFUSING: Apple Root CA G3 sha256 is $ACTUAL_ROOT_SHA, expected $EXPECTED_ROOT_SHA" >&2
  exit 1
fi
echo "Apple Root CA G3 fingerprint matches Apple's published value"
openssl verify -CAfile <(openssl x509 -inform DER -in AppleRootCA-G3.cer) -partial_chain \
  <(openssl x509 -inform DER -in AppleWWDRCAG6.cer)

echo "== naive forgery: a self-signed leaf plus an arbitrary second certificate =="
# The subject copies the real Apple leaf's DN on purpose: a name is not an identity.
openssl ecparam -name prime256v1 -genkey -noout -out forged-leaf.key
openssl req -new -x509 -key forged-leaf.key -out forged-leaf.pem -days 36500 -sha256 \
  -subj "/CN=Prod ECC Mac App Store and iTunes Store Receipt Signing/OU=G6/O=Apple Inc./C=US"
openssl x509 -in forged-leaf.pem -outform DER -out forged-leaf.der
openssl ecparam -name prime256v1 -genkey -noout -out filler.key
openssl req -new -x509 -key filler.key -out filler.pem -days 36500 -sha256 \
  -subj "/CN=Apple Worldwide Developer Relations Certification Authority/OU=G6/O=Apple Inc./C=US"
openssl x509 -in filler.pem -outform DER -out filler.der

echo "== informed forgery: a self-signed hierarchy that copies both marker OIDs =="
# This is the fixture that proves the pinned anchor is load-bearing, rather than the
# marker checks merely happening to refuse first.
openssl ecparam -name secp384r1 -genkey -noout -out marked-int.key
openssl req -new -x509 -key marked-int.key -out marked-int.pem -days 36500 -sha384 \
  -subj "/CN=Apple Worldwide Developer Relations Certification Authority/OU=G6/O=Apple Inc./C=US" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "${APPLE_WWDR_MARKER}=DER:05:00"
openssl x509 -in marked-int.pem -outform DER -out marked-int.der
openssl ecparam -name prime256v1 -genkey -noout -out marked-leaf.key
openssl req -new -key marked-leaf.key -out marked-leaf.csr \
  -subj "/CN=Prod ECC Mac App Store and iTunes Store Receipt Signing/OU=G6/O=Apple Inc./C=US"
openssl x509 -req -in marked-leaf.csr -CA marked-int.pem -CAkey marked-int.key \
  -out marked-leaf.pem -days 36500 -sha256 -set_serial 11 \
  -extfile <(printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n%s=DER:05:00\n' "$APPLE_LEAF_MARKER")
openssl x509 -in marked-leaf.pem -outform DER -out marked-leaf.der

echo "== test hierarchy: root -> intermediate -> leaf, carrying the real marker OIDs =="
# Root and intermediate are P-384/SHA-384 and the leaf is P-256/SHA-256, matching the
# real Apple shape, so both the curve and the digest paths are exercised rather than
# assumed. Carrying the real marker OIDs means the ONLY thing a test changes is the
# trust anchor.
openssl ecparam -name secp384r1 -genkey -noout -out test-root.key
openssl req -new -x509 -key test-root.key -out test-root.pem -days 36500 -sha384 \
  -subj "/CN=Test Root CA - G3/O=Prism Test/C=US" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl x509 -in test-root.pem -outform DER -out test-root.der

openssl ecparam -name secp384r1 -genkey -noout -out test-int.key
openssl req -new -key test-int.key -out test-int.csr -subj "/CN=Test Intermediate CA/O=Prism Test/C=US"
openssl x509 -req -in test-int.csr -CA test-root.pem -CAkey test-root.key -out test-int.pem \
  -days 36500 -sha384 -set_serial 2 \
  -extfile <(printf 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n%s=DER:05:00\n' "$APPLE_WWDR_MARKER")
openssl x509 -in test-int.pem -outform DER -out test-int.der

openssl ecparam -name prime256v1 -genkey -noout -out test-leaf.key
openssl req -new -key test-leaf.key -out test-leaf.csr -subj "/CN=Test Receipt Signing/O=Prism Test/C=US"
openssl x509 -req -in test-leaf.csr -CA test-int.pem -CAkey test-int.key -out test-leaf.pem \
  -days 36500 -sha256 -set_serial 3 \
  -extfile <(printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n%s=DER:05:00\n' "$APPLE_LEAF_MARKER")
openssl x509 -in test-leaf.pem -outform DER -out test-leaf.der

# The same leaf minus the App Store marker, so that one check can be negative-tested
# with exactly one variable moved.
openssl ecparam -name prime256v1 -genkey -noout -out test-leaf-nomarker.key
openssl req -new -key test-leaf-nomarker.key -out test-leaf-nomarker.csr \
  -subj "/CN=Test Receipt Signing No Marker/O=Prism Test/C=US"
openssl x509 -req -in test-leaf-nomarker.csr -CA test-int.pem -CAkey test-int.key \
  -out test-leaf-nomarker.pem -days 36500 -sha256 -set_serial 5 \
  -extfile <(printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n')
openssl x509 -in test-leaf-nomarker.pem -outform DER -out test-leaf-nomarker.der

echo "== an unrelated CA, for the wrong-anchor case =="
openssl ecparam -name secp384r1 -genkey -noout -out other-root.key
openssl req -new -x509 -key other-root.key -out other-root.pem -days 36500 -sha384 \
  -subj "/CN=Other Root CA/O=Prism Test/C=US" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl x509 -in other-root.pem -outform DER -out other-root.der

echo "== independent confirmation of the generated material =="
openssl verify -CAfile test-root.pem -untrusted test-int.pem test-leaf.pem
openssl verify -CAfile test-root.pem -untrusted test-int.pem test-leaf-nomarker.pem
openssl verify -CAfile marked-int.pem -partial_chain marked-leaf.pem
openssl x509 -in marked-leaf.pem -noout -text | grep -q "$APPLE_LEAF_MARKER"
openssl x509 -in marked-int.pem -noout -text | grep -q "$APPLE_WWDR_MARKER"
openssl x509 -in test-leaf.pem -noout -text | grep -q "$APPLE_LEAF_MARKER"
# Negative control: the no-marker leaf must NOT carry it, or the marker test above
# proves nothing about the matcher.
if openssl x509 -in test-leaf-nomarker.pem -noout -text | grep -q "$APPLE_LEAF_MARKER"; then
  echo "REFUSING: the no-marker leaf carries the marker" >&2
  exit 1
fi
echo "all generated hierarchies verify, and the marker negative control holds"

node "$REPO_ROOT/tests/fixtures/generate/build-fixtures.mjs" "$WORK" "$REPO_ROOT"
echo "wrote tests/fixtures/apple-jws-fixtures.ts"
