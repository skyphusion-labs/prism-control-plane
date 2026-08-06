// Google Play purchase verification for POST /v1/store/redeem (platform=google_play).
//
// Uses a Play Console linked service account (JSON key) to call the Android Publisher API.
// When no service account is configured, the store route falls back to
// STORE_REDEEM_TRUST_DECODE (lab only).

export interface ServiceAccountJson {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface GooglePlayProductPurchase {
  /** Google order id (GPA.…); used for idempotency when present. */
  orderId: string | null;
  purchaseState: number;
  consumptionState: number | null;
  purchaseToken: string;
  productId: string;
  packageName: string;
}

function parseServiceAccount(raw: string): ServiceAccountJson | null {
  try {
    const j = JSON.parse(raw) as ServiceAccountJson;
    if (typeof j.client_email !== "string" || typeof j.private_key !== "string") return null;
    if (!j.client_email.includes("@") || j.private_key.length < 80) return null;
    return j;
  } catch {
    return null;
  }
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function b64url(data: ArrayBuffer | string): string {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function serviceAccountAccessToken(
  sa: ServiceAccountJson,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: sa.token_uri ?? "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${b64url(sig)}`;
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const res = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { access_token?: string };
  return typeof body.access_token === "string" ? body.access_token : null;
}

/**
 * Verify a Google Play product (consumable) purchase token.
 * Returns null when credentials missing or API refuses.
 */
export async function verifyGooglePlayPurchase(opts: {
  serviceAccountJson: string;
  packageName: string;
  productId: string;
  purchaseToken: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; purchase: GooglePlayProductPurchase } | { ok: false; detail: string }> {
  const sa = parseServiceAccount(opts.serviceAccountJson);
  if (!sa) return { ok: false, detail: "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not a valid service account key." };

  const doFetch = opts.fetchImpl ?? fetch;
  let accessToken: string | null;
  try {
    accessToken = await serviceAccountAccessToken(sa, doFetch);
  } catch (e) {
    return { ok: false, detail: `Service account token failed: ${String(e).slice(0, 200)}` };
  }
  if (!accessToken) return { ok: false, detail: "Could not mint Google access token for Android Publisher." };

  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(opts.packageName)}/purchases/products/` +
    `${encodeURIComponent(opts.productId)}/tokens/${encodeURIComponent(opts.purchaseToken)}`;

  const res = await doFetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      detail: `Android Publisher ${res.status}: ${text.slice(0, 300)}`,
    };
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, detail: "Android Publisher returned non-JSON." };
  }
  // purchaseState: 0 = purchased, 1 = canceled, 2 = pending
  const purchaseState = typeof body.purchaseState === "number" ? body.purchaseState : -1;
  if (purchaseState !== 0) {
    return { ok: false, detail: `Purchase not in purchased state (state=${purchaseState}).` };
  }
  const orderId = typeof body.orderId === "string" && body.orderId ? body.orderId : null;
  const consumptionState =
    typeof body.consumptionState === "number" ? body.consumptionState : null;

  return {
    ok: true,
    purchase: {
      orderId,
      purchaseState,
      consumptionState,
      purchaseToken: opts.purchaseToken,
      productId: opts.productId,
      packageName: opts.packageName,
    },
  };
}

export function hasGooglePlayCredentials(env: { GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?: string }): boolean {
  const raw = (env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON ?? "").trim();
  return raw.length > 80 && raw.includes("private_key");
}
