// The upstream credential seam.
//
// THIS IS THE FILE THAT PROTECTS AN ARCHITECTURE DECISION, not just some code. Cloudflare caps an account
// at 500 API tokens in total, across every service on it, so "one Cloudflare token per Prism user" cannot be
// the default and cannot be unbounded:
//   https://developers.cloudflare.com/fundamentals/api/reference/limits/
//
// What must hold, and what these tests pin:
//   1. Product is SHARED ONLY. One CF_AIG_TOKEN for every Prism account. Cloudflare's 500-token
//      account ceiling makes one-token-per-account a hard product cap and starves vivijure.
//   2. credentialMode is always "shared", even if someone left UPSTREAM_CREDENTIAL_MODE=per-user.
//   3. A leftover per-user config REFUSES to wire (null) rather than minting or silently sharing.
//   4. The shared credential is never handed to a client. Covered end to end in router.test.ts.

import { describe, expect, it } from "vitest";
import { CfApi } from "../src/cf-api";
import { credentialMode, perUserModeRequested, type Env } from "../src/env";
import { upstreamCredentialSource } from "../src/index";
import {
  CF_ACCOUNT_TOKEN_QUOTA,
  CfUserTokenProvider,
  SharedTokenSource,
  userTokenName,
} from "../src/token-minter";
import { decryptToken, kekRing } from "../src/token-crypto";
import { FakeStore } from "./fake-store";

/** A 32-byte AES key, base64. Test-only, and it never leaves this file. */
const KEK = Buffer.alloc(32, 7).toString("base64");

const WIRED: Partial<Env> = { CF_ACCOUNT_ID: "acct-cf", AI_GATEWAY_ID: "prism-proxy" };

describe("credentialMode", () => {
  it("is always shared, including when config still says per-user", () => {
    // Product ruling: one account token. The mode flag cannot re-open minting.
    expect(credentialMode({} as Env)).toBe("shared");
    expect(credentialMode({ UPSTREAM_CREDENTIAL_MODE: "" } as Env)).toBe("shared");
    expect(credentialMode({ UPSTREAM_CREDENTIAL_MODE: "per-user" } as Env)).toBe("shared");
    expect(credentialMode({ UPSTREAM_CREDENTIAL_MODE: " Per-User " } as Env)).toBe("shared");
    expect(credentialMode({ UPSTREAM_CREDENTIAL_MODE: "junk" } as Env)).toBe("shared");
  });
});

describe("perUserModeRequested", () => {
  it("detects a leftover per-user config so wiring can refuse it", () => {
    expect(perUserModeRequested({} as Env)).toBe(false);
    expect(perUserModeRequested({ UPSTREAM_CREDENTIAL_MODE: "shared" } as Env)).toBe(false);
    expect(perUserModeRequested({ UPSTREAM_CREDENTIAL_MODE: "per-user" } as Env)).toBe(true);
    expect(perUserModeRequested({ UPSTREAM_CREDENTIAL_MODE: " Per-User " } as Env)).toBe(true);
  });
});

describe("upstreamCredentialSource", () => {
  const store = new FakeStore();
  const now = () => 1_785_900_000;

  it("builds the shared source when CF_AIG_TOKEN is set", () => {
    const source = upstreamCredentialSource({ ...WIRED, CF_AIG_TOKEN: "shared-token" } as Env, store, now);
    expect(source?.mode).toBe("shared");
    expect(source).toBeInstanceOf(SharedTokenSource);
  });

  it("returns null when CF_AIG_TOKEN is missing", () => {
    expect(upstreamCredentialSource({ ...WIRED } as Env, store, now)).toBeNull();
  });

  it("refuses a leftover per-user config rather than minting", () => {
    // Fully-specified per-user secrets used to be enough to open minting. That path is retired: even with
    // every old secret present, wiring returns null so a misdeploy fails closed at the door.
    expect(
      upstreamCredentialSource(
        {
          ...WIRED,
          UPSTREAM_CREDENTIAL_MODE: "per-user",
          CF_AIG_TOKEN: "shared-token",
          PCP_CF_API_TOKEN: "minting",
          USER_TOKEN_KEK: KEK,
          USER_TOKEN_BUDGET: "50",
        } as Env,
        store,
        now,
      ),
    ).toBeNull();
  });

  it("returns null with no gateway, whatever the credential config says", () => {
    // No gateway means nowhere to send inference, so a credential would be pointless and the door is shut on
    // the same 503 rather than on a confusing partial success.
    expect(
      upstreamCredentialSource({ CF_AIG_TOKEN: "shared-token" } as Env, store, now),
    ).toBeNull();
  });
});

describe("SharedTokenSource", () => {
  it("hands the same credential to every account and labels the mode", () => {
    const source = new SharedTokenSource("shared-token");
    return Promise.all([source.forAccount("acct_1"), source.forAccount("acct_2")]).then(([a, b]) => {
      expect(a).toEqual({
        outcome: "ok",
        credential: { tokenId: "shared", value: "shared-token" },
        minted: false,
      });
      expect(b).toEqual(a);
    });
  });

  it("refuses instead of returning an empty credential", async () => {
    expect(await new SharedTokenSource("").forAccount("acct_1")).toMatchObject({
      outcome: "unavailable",
    });
  });

  it("revokes nothing, because revoking a shared credential is an outage", async () => {
    // Reported as `false` rather than throwing: the operator route turns this into a 501 that names the real
    // stop button (revoke the client keys, suspend the account) instead of pretending a revocation happened.
    expect(await new SharedTokenSource("shared-token").revokeForAccount("acct_1")).toBe(false);
  });
});

describe("CfUserTokenProvider budget", () => {
  /**
   * The fake credential value Cloudflare "returns" from a mint.
   *
   * LONG AND DISTINCTIVE ON PURPOSE. An earlier version of this file used the single character "v", and the
   * "ciphertext does not contain the plaintext" assertion below then passed or failed on whether a random IV
   * happened to base64-encode a "v" -- green locally, red in CI, and testing nothing either way. A plaintext
   * that base64 cannot produce by chance is what makes that assertion mean something.
   */
  const TOKEN_VALUE = "cf-user-token-plaintext-must-not-be-stored";

  /** A CfApi whose fetch records calls and answers a successful mint. */
  function mintingApi(): { api: CfApi; minted: string[] } {
    const minted: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/tokens")) {
        const body = JSON.parse(String(init.body)) as { name: string };
        minted.push(body.name);
        return new Response(
          JSON.stringify({
            success: true,
            result: { id: `cftok_${minted.length}`, value: TOKEN_VALUE },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      // The orphan sweep and anything else: an empty list.
      return new Response(JSON.stringify({ success: true, result: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { api: new CfApi({ accountId: "acct-cf", token: "minting", fetchImpl }), minted };
  }

  function provider(store: FakeStore, budget: number): CfUserTokenProvider {
    return new CfUserTokenProvider(
      mintingApi().api,
      store,
      kekRing(KEK),
      () => 1_785_900_000,
      budget,
    );
  }

  it("mints within budget, hands back the live value, and stores only ciphertext", async () => {
    const store = new FakeStore();
    const result = await provider(store, 2).forAccount("acct_1");
    expect(result).toMatchObject({ outcome: "ok", minted: true });
    // The CALLER gets the usable value; only the STORE is ciphertext. Both halves matter: a provider that
    // encrypted correctly but returned the ciphertext would fail every inference call with a 401.
    if (result.outcome === "ok") expect(result.credential.value).toBe(TOKEN_VALUE);

    const row = await store.getUserToken("acct_1");
    expect(row?.cf_token_id).toBe("cftok_1");
    // THE CIPHERTEXT MUST NOT BE THE PLAINTEXT. A stored credential readable from a database dump is the
    // breach this envelope encryption exists to prevent.
    expect(row?.token_enc).not.toContain(TOKEN_VALUE);
    // AND IT MUST STILL BE THE SAME CREDENTIAL. "Unreadable" is trivially satisfiable by storing garbage;
    // the property worth asserting is that it round-trips under the installed key.
    expect(await decryptToken(kekRing(KEK), row!.token_enc)).toBe(TOKEN_VALUE);
  });

  it("refuses the mint that would exceed the budget, and mints nothing", async () => {
    // Checked BEFORE the Cloudflare call, so the ceiling arrives as a clean refusal with an operator-readable
    // reason rather than as a Cloudflare rejection mid-signup.
    const store = new FakeStore();
    const source = provider(store, 1);
    expect(await source.forAccount("acct_1")).toMatchObject({ outcome: "ok", minted: true });

    const refused = await source.forAccount("acct_2");
    expect(refused.outcome).toBe("unavailable");
    if (refused.outcome === "unavailable") {
      // The reason has to be actionable: it names the numbers, the account-wide quota it is a share of, and
      // both ways out. This string is an operator's only clue at 2am.
      expect(refused.reason).toContain("budget exhausted");
      expect(refused.reason).toContain(String(CF_ACCOUNT_TOKEN_QUOTA));
      expect(refused.reason).toContain("USER_TOKEN_BUDGET");
      expect(refused.reason).toContain("shared");
    }
    expect(await store.getUserToken("acct_2")).toBeNull();
  });

  it("frees a slot on revocation, so the budget is a live count and not a high-water mark", async () => {
    const store = new FakeStore();
    const source = provider(store, 1);
    await source.forAccount("acct_1");
    await source.revokeForAccount("acct_1");
    expect(await store.countLiveUserTokens()).toBe(0);
    // A budget that counted revoked rows would strand capacity forever after any churn.
    expect(await source.forAccount("acct_2")).toMatchObject({ outcome: "ok", minted: true });
  });

  it("reuses a stored credential instead of spending another slot", async () => {
    const store = new FakeStore();
    const source = provider(store, 1);
    const first = await source.forAccount("acct_1");
    const second = await source.forAccount("acct_1");
    expect(first).toMatchObject({ minted: true });
    // Not merely a cache: minting per request would burn the account's entire quota on a single user.
    expect(second).toMatchObject({ outcome: "ok", minted: false });
  });

  it("refuses when no KEK is installed rather than storing a spendable token in plaintext", async () => {
    const store = new FakeStore();
    const source = new CfUserTokenProvider(
      mintingApi().api,
      store,
      kekRing(""),
      () => 1_785_900_000,
      10,
    );
    expect(await source.forAccount("acct_1")).toMatchObject({ outcome: "unavailable" });
    expect(await store.getUserToken("acct_1")).toBeNull();
  });
});

describe("userTokenName", () => {
  it("is deterministic, so a mint that never persisted is still revocable", () => {
    // If a mint succeeds and the D1 write fails, this name is the only handle left on a live credential.
    expect(userTokenName("acct_1")).toBe("prism-cp-user-acct_1");
    expect(userTokenName("acct_1")).toBe(userTokenName("acct_1"));
  });
});
