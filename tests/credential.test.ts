// The upstream credential seam.
//
// THIS IS THE FILE THAT PROTECTS AN ARCHITECTURE DECISION, not just some code. Cloudflare caps an account
// at 500 API tokens in total, across every service on it, so "one Cloudflare token per Prism user" cannot be
// the default and cannot be unbounded:
//   https://developers.cloudflare.com/fundamentals/api/reference/limits/
//
// What must hold, and what these tests pin:
//   1. The default is the SHARED credential. A missing or misspelled mode never resolves to per-user, because
//      that would start silently consuming a finite account-wide quota.
//   2. Per-user mode refuses to run at all without an explicit budget. There is no default budget, because a
//      default would be a guess about how much of a SHARED quota this one product may take.
//   3. The budget is enforced BEFORE a mint, so the ceiling is hit as a clean refusal rather than as a
//      Cloudflare rejection during someone's signup -- and rather than by taking the last slots that
//      vivijure's tenant provisioning also needs.
//   4. Neither mode ever hands a credential to a client. Covered end to end in router.test.ts.

import { describe, expect, it } from "vitest";
import { CfApi } from "../src/cf-api";
import { credentialMode, userTokenBudget, type Env } from "../src/env";
import { upstreamCredentialSource } from "../src/index";
import {
  CF_ACCOUNT_TOKEN_QUOTA,
  CfUserTokenProvider,
  SharedTokenSource,
  userTokenName,
} from "../src/token-minter";
import { kekRing } from "../src/token-crypto";
import { FakeStore } from "./fake-store";

/** A 32-byte AES key, base64. Test-only, and it never leaves this file. */
const KEK = Buffer.alloc(32, 7).toString("base64");

const WIRED: Partial<Env> = { CF_ACCOUNT_ID: "acct-cf", AI_GATEWAY_ID: "prism-proxy" };

describe("credentialMode", () => {
  it("defaults to shared, including for junk", () => {
    // A typo must not be read as "per-user". This is the assertion that keeps a misconfiguration from
    // quietly eating the account's token quota.
    expect(credentialMode({} as Env)).toBe("shared");
    expect(credentialMode({ UPSTREAM_CREDENTIAL_MODE: "" } as Env)).toBe("shared");
    expect(credentialMode({ UPSTREAM_CREDENTIAL_MODE: "peruser" } as Env)).toBe("shared");
    expect(credentialMode({ UPSTREAM_CREDENTIAL_MODE: "PER_USER" } as Env)).toBe("shared");
  });

  it("honours an exact per-user, case- and space-insensitively", () => {
    expect(credentialMode({ UPSTREAM_CREDENTIAL_MODE: "per-user" } as Env)).toBe("per-user");
    expect(credentialMode({ UPSTREAM_CREDENTIAL_MODE: " Per-User " } as Env)).toBe("per-user");
  });
});

describe("userTokenBudget", () => {
  it("returns null rather than inventing a number", () => {
    // Null closes per-user mode. The budget is the only thing between this plane and a shared 500-token
    // quota, so an absent or malformed one is a configuration error to refuse on.
    expect(userTokenBudget({} as Env, CF_ACCOUNT_TOKEN_QUOTA)).toBeNull();
    expect(userTokenBudget({ USER_TOKEN_BUDGET: "0" } as Env, CF_ACCOUNT_TOKEN_QUOTA)).toBeNull();
    expect(userTokenBudget({ USER_TOKEN_BUDGET: "-5" } as Env, CF_ACCOUNT_TOKEN_QUOTA)).toBeNull();
    expect(userTokenBudget({ USER_TOKEN_BUDGET: "10.5" } as Env, CF_ACCOUNT_TOKEN_QUOTA)).toBeNull();
    expect(userTokenBudget({ USER_TOKEN_BUDGET: "lots" } as Env, CF_ACCOUNT_TOKEN_QUOTA)).toBeNull();
  });

  it("clamps to the Cloudflare account quota", () => {
    // No local config can authorise more tokens than Cloudflare will issue, so a hopeful 10,000 becomes 500
    // rather than a promise that fails on the 501st user.
    expect(userTokenBudget({ USER_TOKEN_BUDGET: "10000" } as Env, CF_ACCOUNT_TOKEN_QUOTA)).toBe(
      CF_ACCOUNT_TOKEN_QUOTA,
    );
    expect(userTokenBudget({ USER_TOKEN_BUDGET: "50" } as Env, CF_ACCOUNT_TOKEN_QUOTA)).toBe(50);
  });
});

describe("upstreamCredentialSource", () => {
  const store = new FakeStore();
  const now = () => 1_785_900_000;

  it("builds the shared source by default", () => {
    const source = upstreamCredentialSource({ ...WIRED, CF_AIG_TOKEN: "shared-token" } as Env, store, now);
    expect(source?.mode).toBe("shared");
  });

  it("returns null rather than falling back when a mode's config is incomplete", () => {
    // FALLING BACK WOULD BE THE WORST BEHAVIOUR IN BOTH DIRECTIONS: silently sharing one credential when the
    // operator asked for per-user isolation, or silently minting against a finite quota when they asked for
    // shared. A half-configured deploy closes the inference door instead.
    expect(upstreamCredentialSource({ ...WIRED } as Env, store, now)).toBeNull();
    expect(
      upstreamCredentialSource(
        { ...WIRED, UPSTREAM_CREDENTIAL_MODE: "per-user", CF_AIG_TOKEN: "shared-token" } as Env,
        store,
        now,
      ),
    ).toBeNull();
    expect(
      upstreamCredentialSource(
        {
          ...WIRED,
          UPSTREAM_CREDENTIAL_MODE: "per-user",
          PCP_CF_API_TOKEN: "minting",
          USER_TOKEN_KEK: KEK,
        } as Env,
        store,
        now,
      ),
      "per-user without a budget must not build",
    ).toBeNull();
  });

  it("builds the per-user source only when all three secrets and a budget are present", () => {
    const source = upstreamCredentialSource(
      {
        ...WIRED,
        UPSTREAM_CREDENTIAL_MODE: "per-user",
        PCP_CF_API_TOKEN: "minting",
        USER_TOKEN_KEK: KEK,
        USER_TOKEN_BUDGET: "50",
      } as Env,
      store,
      now,
    );
    expect(source?.mode).toBe("per-user");
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
  /** A CfApi whose fetch records calls and answers a successful mint. */
  function mintingApi(): { api: CfApi; minted: string[] } {
    const minted: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/tokens")) {
        const body = JSON.parse(String(init.body)) as { name: string };
        minted.push(body.name);
        return new Response(
          JSON.stringify({ success: true, result: { id: `cftok_${minted.length}`, value: "v" } }),
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

  it("mints within budget and stores the credential encrypted", async () => {
    const store = new FakeStore();
    const result = await provider(store, 2).forAccount("acct_1");
    expect(result).toMatchObject({ outcome: "ok", minted: true });

    const row = await store.getUserToken("acct_1");
    expect(row?.cf_token_id).toBe("cftok_1");
    // THE CIPHERTEXT MUST NOT BE THE PLAINTEXT. A stored credential readable from a database dump is the
    // breach this envelope encryption exists to prevent.
    expect(row?.token_enc).not.toContain("v");
    expect(row?.token_enc.length).toBeGreaterThan(10);
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
