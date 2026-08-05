// Client-key identity. The single seam every authenticated route goes through.
//
// ONE derivation, one place. Every /v1 route calls resolveClient(), so the rules about revocation,
// suspension, and malformed bearers cannot diverge between routes. That is the same discipline
// prism's src/auth.ts resolveIdentity() enforces, for the same reason.

import { constantTimeEqual, newId, newKeyId, randomSecret, sha256Hex } from "./crypto";
import type { AccountRow, ClientRow, ControlPlaneStore, PlanRow } from "./store";

/**
 * Bearer format: `pcp_<key_id>_<secret>`.
 *
 * TWO PARTS, and the split is what makes the compare safe. `key_id` (16 hex, NOT secret) selects
 * exactly one candidate row, so the secret is then compared against a single known value in constant
 * time. A single-token scheme would force either a table scan or an index on the secret itself, and
 * indexing a credential is how a database dump becomes a login.
 *
 * The prefix is `pcp_` (prism control plane) so a leaked string is recognisable in a log or a paste and
 * can be searched for by secret scanners.
 */
export const KEY_PREFIX = "pcp";
const KEY_ID_RE = /^[0-9a-f]{16}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

export interface ParsedKey {
  keyId: string;
  secret: string;
}

/**
 * Parse a bearer value. Returns null for anything malformed.
 *
 * SHAPE IS CHECKED BEFORE ANY DATABASE WORK. A junk bearer is refused without a D1 read, so an
 * unauthenticated flood of garbage costs no queries. Splitting on the first two underscores rather
 * than `split("_")` matters: base64url secrets may contain underscores, and a naive split would
 * mangle them into an unparseable key that had actually been sent correctly.
 */
export function parseClientKey(raw: string): ParsedKey | null {
  const first = raw.indexOf("_");
  if (first < 0 || raw.slice(0, first) !== KEY_PREFIX) return null;
  const second = raw.indexOf("_", first + 1);
  if (second < 0) return null;
  const keyId = raw.slice(first + 1, second);
  const secret = raw.slice(second + 1);
  if (!KEY_ID_RE.test(keyId) || !SECRET_RE.test(secret)) return null;
  return { keyId, secret };
}

export function formatClientKey(keyId: string, secret: string): string {
  return `${KEY_PREFIX}_${keyId}_${secret}`;
}

/** Read the bearer out of the Authorization header. Case-insensitive scheme, per RFC 7235. */
export function bearerFromRequest(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export interface Caller {
  client: ClientRow;
  account: AccountRow;
  plan: PlanRow;
}

/**
 * Why a caller did not resolve.
 *
 * These map one-to-one onto contract error codes, and they are distinct because a client must act
 * differently on each:
 *
 *   unauthenticated  no or malformed bearer, or no matching key. Retry with a correct credential.
 *   revoked          the key existed and was killed. TERMINAL: delete the stored key, re-enroll.
 *   suspended        the account is switched off. The key is fine; the account is not.
 *   misconfigured    the key resolves but its account or plan does not exist. That is OUR bug, and it
 *                    answers 503, not 401: telling a caller "you are not authenticated" when the real
 *                    problem is a dangling foreign key sends them chasing a credential that is correct.
 */
export type ResolveFailure = "unauthenticated" | "revoked" | "suspended" | "misconfigured";

export type ResolveResult =
  | { ok: true; caller: Caller }
  | { ok: false; failure: ResolveFailure; detail?: string };

export async function resolveClient(
  store: ControlPlaneStore,
  request: Request,
): Promise<ResolveResult> {
  const bearer = bearerFromRequest(request);
  if (!bearer) return { ok: false, failure: "unauthenticated" };
  const parsed = parseClientKey(bearer);
  if (!parsed) return { ok: false, failure: "unauthenticated" };

  const client = await store.getClientByKeyId(parsed.keyId);
  if (!client) return { ok: false, failure: "unauthenticated" };

  const presented = await sha256Hex(parsed.secret);
  // Constant-time against the single candidate. An unknown key_id already returned above, so the
  // timing signal that remains (key exists vs not) is the same one any lookup-based scheme has.
  if (!constantTimeEqual(presented, client.secret_hash)) {
    return { ok: false, failure: "unauthenticated" };
  }

  // Revocation is checked AFTER the secret compare, deliberately. Checking it first would let anyone
  // holding only a key_id learn whether that key had been revoked, which is a small but free
  // information leak about accounts they cannot authenticate as.
  if (client.revoked_at) return { ok: false, failure: "revoked" };

  const account = await store.getAccount(client.account_id);
  if (!account) {
    return {
      ok: false,
      failure: "misconfigured",
      detail: `client ${client.id} references account ${client.account_id}, which does not exist`,
    };
  }
  if (account.suspended_at) return { ok: false, failure: "suspended" };

  const plan = await store.getPlan(account.plan_id);
  if (!plan) {
    return {
      ok: false,
      failure: "misconfigured",
      detail: `account ${account.id} references plan ${account.plan_id}, which does not exist`,
    };
  }

  return { ok: true, caller: { client, account, plan } };
}

export interface MintedKey {
  clientId: string;
  keyId: string;
  /** The plaintext bearer. Exists here and in the enrollment response, nowhere else, ever. */
  key: string;
  secretHash: string;
}

/** Mint a client id, key id, and secret. The caller persists only the hash. */
export async function mintClientKey(): Promise<MintedKey> {
  const clientId = newId("cli");
  const keyId = newKeyId();
  const secret = randomSecret();
  return {
    clientId,
    keyId,
    key: formatClientKey(keyId, secret),
    secretHash: await sha256Hex(secret),
  };
}
