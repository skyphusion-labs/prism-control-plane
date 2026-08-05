import { describe, expect, it } from "vitest";
import {
  bearerFromRequest,
  formatClientKey,
  mintClientKey,
  parseClientKey,
  resolveClient,
} from "../src/auth";
import { constantTimeEqual, randomSecret, sha256Hex } from "../src/crypto";
import { FakeStore, testPlan } from "./fake-store";

async function seededStore() {
  const store = new FakeStore();
  store.plans.set("test", testPlan());
  await store.createAccount({ id: "acct_1", plan_id: "test", label: null });
  const minted = await mintClientKey();
  await store.createClient({
    id: minted.clientId,
    account_id: "acct_1",
    key_id: minted.keyId,
    secret_hash: minted.secretHash,
    label: "device",
    platform: "ios",
  });
  return { store, minted };
}

function authed(key: string): Request {
  return new Request("https://example.invalid/v1/me", { headers: { authorization: `Bearer ${key}` } });
}

describe("parseClientKey", () => {
  it("round-trips a minted key", async () => {
    const minted = await mintClientKey();
    const parsed = parseClientKey(minted.key);
    expect(parsed).not.toBeNull();
    expect(parsed?.keyId).toBe(minted.keyId);
  });

  it("keeps underscores inside the base64url secret", () => {
    // A naive split("_") would mangle a secret containing underscores into an unparseable key that had
    // actually been sent correctly. base64url uses "_", so this is the common case, not an edge one.
    const secret = "a_b" + "x".repeat(40);
    const parsed = parseClientKey(formatClientKey("0123456789abcdef", secret));
    expect(parsed?.secret).toBe(secret);
  });

  it("rejects malformed keys before any lookup", () => {
    expect(parseClientKey("")).toBeNull();
    expect(parseClientKey("nope")).toBeNull();
    expect(parseClientKey("pcp_short_" + "x".repeat(43))).toBeNull();
    expect(parseClientKey("other_0123456789abcdef_" + "x".repeat(43))).toBeNull();
    // Uppercase key_id: the id is lowercase hex by construction, so accepting other spellings would mean
    // two strings selecting the same row.
    expect(parseClientKey("pcp_0123456789ABCDEF_" + "x".repeat(43))).toBeNull();
    // Wrong secret length.
    expect(parseClientKey("pcp_0123456789abcdef_" + "x".repeat(42))).toBeNull();
  });
});

describe("bearerFromRequest", () => {
  it("accepts any case of the scheme and trims", () => {
    const request = new Request("https://example.invalid/", {
      headers: { authorization: "bearer  abc  " },
    });
    expect(bearerFromRequest(request)).toBe("abc");
  });

  it("returns null when there is no Authorization header", () => {
    expect(bearerFromRequest(new Request("https://example.invalid/"))).toBeNull();
  });
});

describe("constantTimeEqual", () => {
  it("compares equal and unequal values of the same length", () => {
    expect(constantTimeEqual("abcd", "abcd")).toBe(true);
    expect(constantTimeEqual("abcd", "abce")).toBe(false);
    expect(constantTimeEqual("abcd", "abcde")).toBe(false);
  });
});

describe("randomSecret", () => {
  it("mints 43 base64url characters and does not repeat", () => {
    const secrets = new Set(Array.from({ length: 50 }, () => randomSecret()));
    expect(secrets.size).toBe(50);
    for (const secret of secrets) expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("resolveClient", () => {
  it("resolves a valid key to client, account, and plan", async () => {
    const { store, minted } = await seededStore();
    const result = await resolveClient(store, authed(minted.key));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.caller.account.id).toBe("acct_1");
      expect(result.caller.plan.id).toBe("test");
    }
  });

  it("refuses a wrong secret against a real key id", async () => {
    const { store, minted } = await seededStore();
    const forged = formatClientKey(minted.keyId, randomSecret());
    expect(await resolveClient(store, authed(forged))).toMatchObject({
      ok: false,
      failure: "unauthenticated",
    });
  });

  it("reports a revoked key distinctly, so a client can stop retrying", async () => {
    const { store, minted } = await seededStore();
    await store.revokeClient(minted.clientId);
    expect(await resolveClient(store, authed(minted.key))).toMatchObject({
      ok: false,
      failure: "revoked",
    });
  });

  it("does not reveal revocation to a caller who cannot authenticate", async () => {
    // Revocation is checked AFTER the secret compare. Otherwise anyone holding only a key_id could learn
    // whether that key had been revoked.
    const { store, minted } = await seededStore();
    await store.revokeClient(minted.clientId);
    const forged = formatClientKey(minted.keyId, randomSecret());
    expect(await resolveClient(store, authed(forged))).toMatchObject({ failure: "unauthenticated" });
  });

  it("reports a suspended account", async () => {
    const { store, minted } = await seededStore();
    const account = store.accounts.get("acct_1");
    if (account) account.suspended_at = new Date().toISOString();
    expect(await resolveClient(store, authed(minted.key))).toMatchObject({ failure: "suspended" });
  });

  it("reports a dangling plan as misconfigured, not as an auth failure", async () => {
    // The credential is correct; our data is not. Answering "unauthenticated" would send the caller
    // chasing a key that is already right.
    const { store, minted } = await seededStore();
    store.plans.delete("test");
    expect(await resolveClient(store, authed(minted.key))).toMatchObject({
      failure: "misconfigured",
    });
  });

  it("stores only the hash of the secret", async () => {
    const { store, minted } = await seededStore();
    const parsed = parseClientKey(minted.key);
    const client = store.clients.get(minted.clientId);
    expect(client?.secret_hash).toBe(await sha256Hex(parsed?.secret ?? ""));
    // The plaintext must appear nowhere in the stored row.
    expect(JSON.stringify(client)).not.toContain(parsed?.secret ?? "impossible");
  });
});
