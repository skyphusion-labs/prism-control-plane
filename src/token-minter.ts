// How a request gets a Cloudflare credential to reach the model with.
//
// TWO SOURCES, AND THE DEFAULT IS THE SHARED ONE. That is a reversal of the design this file was first
// written for, forced by a hard Cloudflare number:
//
//   ACCOUNT API TOKEN QUOTA: 500 PER ACCOUNT.
//   https://developers.cloudflare.com/fundamentals/api/reference/limits/
//
// One Cloudflare token per Prism user therefore caps the product at 500 users MINUS every token the
// account already uses for anything else -- 73 were already in use on 2026-08-04, and vivijure mints two
// per hosted tenant from the same pool. A per-user credential scheme that runs out at a few hundred users
// and starves a sibling product on the way is not a scheme, so `shared` is the default and `per-user` is an
// opt-in for a deployment that knows it is small.
//
// The seam stays because the CHOICE is real and Conrad's to make, and because a plane that can only do one
// of these would have to be rewritten to change its mind. Both implement one interface; the route does not
// know which it got.
//
// ---------------------------------------------------------------------------------------------------
// WHAT A PER-USER TOKEN BUYS, STATED HONESTLY, because the wrong belief about it would be dangerous:
//
//   IT IS AN ACCESS AND REVOCATION BOUNDARY. Revoking one user's token stops exactly that user's
//   inference and nothing else. That was proven live on this estate rather than reasoned about (vivijure
//   cf#56): a minted token reached the gateway, a bogus one was refused AT the gateway, and revoking a
//   working token turned the same call into a 401 within roughly 8 to 16 seconds.
//
//   IT IS NOT A TENANCY BOUNDARY. These are account-scoped Cloudflare tokens on OUR account. Two users'
//   tokens can reach the same models and the same bill. The isolation that exists is per-token
//   revocation, not per-token sandboxing.
//
//   IT IS NOT, BY ITSELF, ATTRIBUTION. Cloudflare's gateway logs do not break spend down by which token
//   presented it; Cloudflare's own documented way to attribute usage to an individual is `cf-aig-metadata`,
//   which is what User Insights reads. Attribution here comes from OUR ledger (usage_events, one row per
//   request, priced from token counts) plus that metadata, in BOTH modes. The per-user token is what makes a
//   single user stoppable at the Cloudflare layer; the ledger is what makes them accountable.
//
//   IT IS NOT THE FASTEST KILL SWITCH. Revocation lands in roughly 8 to 16 seconds. This plane's own
//   refusals -- suspend the account, revoke the client key -- are immediate, and they work in both modes. So
//   per-user tokens are defence in depth, not the stop button.
//
// THE TOKEN IS NEVER GIVEN TO THE CLIENT. This is the load-bearing custody rule. A device holding one of
// these could call api.cloudflare.com directly, on our account, at our cost, past every gate in this
// plane -- no prepaid check, no rate limit, no ledger row. The client only ever holds its own `pcp_` key.
// The upstream token lives encrypted in D1, is decrypted inside a single request, and is used to reach
// exactly one endpoint. Any future feature that proposes handing it out is proposing to delete the meter.
//
// MINTING IS LAZY, at first inference rather than at enrollment. An account that never runs a request
// never consumes a Cloudflare token slot, and the mint failure surfaces on a route that already knows how
// to refuse rather than in an enrollment path that would then have to unwind.

import { CfApi, CfApiError, type MintedToken } from "./cf-api";
import type { ControlPlaneStore } from "./store";
import { decryptToken, encryptToken, ringUsable, type KekRing } from "./token-crypto";

/** A usable upstream credential for one account. The value is live and must not be logged or returned. */
export interface UpstreamCredential {
  tokenId: string;
  value: string;
}

export type CredentialOutcome =
  | { outcome: "ok"; credential: UpstreamCredential; minted: boolean }
  /**
   * No credential, and the request must be refused.
   *
   * `reason` is for the operator log; it never reaches a client verbatim, because a Cloudflare
   * permissions message is operator information and not something a phone should be told.
   */
  | { outcome: "unavailable"; reason: string };

/**
 * Where a request's upstream credential comes from. Implemented twice; see the header.
 *
 * The route calls `forAccount` and never learns which implementation answered, which is the whole point:
 * switching modes must not be able to change the gates, the meter, or the ledger.
 */
export interface UpstreamCredentialSource {
  /** The credential to reach the model with for this account. */
  forAccount(accountId: string): Promise<CredentialOutcome>;
  /**
   * Revoke this account's credential at Cloudflare, where that is a thing this source can do.
   *
   * Returns false when there was nothing to revoke. The SHARED source always returns false and revokes
   * nothing, deliberately: revoking a shared credential would stop every user, which is an outage and not a
   * moderation action. In shared mode the per-user stop button is `revokeClient` / account suspension.
   */
  revokeForAccount(accountId: string): Promise<boolean>;
  /** Which mode this is, for /health/deep and for the operator route's honest answer. */
  readonly mode: "shared" | "per-user";
}

/**
 * The DEFAULT source: one account-scoped AI Gateway token, held as a Worker secret, used for every user.
 *
 * WHY THIS IS THE DEFAULT rather than a fallback. Cloudflare API tokens are service credentials: the account
 * quota is 500, and Cloudflare's documented way to attribute spend to an individual user is custom metadata,
 * not a token per user. Using one service credential and attributing in metadata plus our own ledger is
 * therefore the supported shape, not a compromise.
 *
 * WHAT IS GIVEN UP, stated plainly: there is no Cloudflare-layer per-user revocation. A leaked copy of this
 * credential would be usable against the whole account until it is rotated, whereas a leaked per-user token
 * is one revocation away. That is why the credential never leaves the Worker in either mode, and why the
 * plane's own immediate refusals are the primary stop button in both.
 */
export class SharedTokenSource implements UpstreamCredentialSource {
  readonly mode = "shared" as const;
  constructor(private readonly token: string) {}

  // The account id is accepted and IGNORED, which is the definition of this mode rather than an oversight:
  // every account gets the same credential. Keeping the parameter is what lets the route stay ignorant of
  // which source it holds.
  async forAccount(_accountId: string): Promise<CredentialOutcome> {
    if (!this.token) {
      return { outcome: "unavailable", reason: "CF_AIG_TOKEN is not configured" };
    }
    // tokenId is a LABEL, not a Cloudflare id: there is no per-account token to name. It rides in
    // `cf-aig-metadata` so a gateway log says which credential mode served the request.
    return { outcome: "ok", credential: { tokenId: "shared", value: this.token }, minted: false };
  }

  async revokeForAccount(_accountId: string): Promise<boolean> {
    return false;
  }
}

/**
 * The Cloudflare-side token name for an account.
 *
 * DETERMINISTIC ON PURPOSE. If a mint succeeds and the D1 write that records its id then fails, the
 * credential is live on the account with nothing pointing at it. A deterministic name is the only handle
 * left, and `findTokenByName` turns an orphan into something revocable instead of something permanent.
 */
export const userTokenName = (accountId: string): string => `prism-cp-user-${accountId}`;

/**
 * The account-wide Cloudflare ceiling this mode spends against.
 * https://developers.cloudflare.com/fundamentals/api/reference/limits/
 */
export const CF_ACCOUNT_TOKEN_QUOTA = 500;

/**
 * The opt-in source: one Cloudflare token per account, minted on first inference and held encrypted.
 *
 * BOUNDED BY CONSTRUCTION. `budget` is how many of the account's 500 token slots this plane may consume, and
 * it is not optional. Once the plane holds that many live credentials it refuses to mint the next one instead
 * of discovering the quota by having Cloudflare reject a mint during a signup -- and, worse, by having taken
 * the last slots that vivijure's tenant provisioning also needs. Running out is a capacity decision, so it
 * is made in config by a human, not at 2am by whoever signed up 500th.
 */
export class CfUserTokenProvider implements UpstreamCredentialSource {
  readonly mode = "per-user" as const;
  constructor(
    private readonly cf: CfApi,
    private readonly store: ControlPlaneStore,
    private readonly ring: KekRing,
    private readonly now: () => number,
    private readonly budget: number,
  ) {}

  async forAccount(accountId: string): Promise<CredentialOutcome> {
    if (!ringUsable(this.ring)) {
      return {
        outcome: "unavailable",
        reason: "USER_TOKEN_KEK is not installed, so a minted credential could not be stored safely",
      };
    }

    const existing = await this.store.getUserToken(accountId);
    if (existing && existing.revoked_at === null) {
      try {
        const value = await decryptToken(this.ring, existing.token_enc);
        return { outcome: "ok", credential: { tokenId: existing.cf_token_id, value }, minted: false };
      } catch {
        // A row no installed key can open is NOT re-minted here, and that restraint is deliberate. It is
        // either a KEK the operator removed too early or a tampered row; both are operator conditions,
        // and quietly minting a second live credential on top of an unreadable one would hide the first
        // and leave it spendable. Refuse loudly, let the census and the revoke path deal with it.
        return {
          outcome: "unavailable",
          reason: `stored upstream token for ${accountId} could not be decrypted under any installed KEK`,
        };
      }
    }

    // BUDGET BEFORE MINT. Checked here rather than at enrollment because this is where a slot is actually
    // consumed, and checked on every mint rather than cached because the count is shared with every other
    // service on the Cloudflare account and a stale local number would authorise a mint the account cannot
    // afford. One extra D1 count per new account is a cheap price for not being the product that exhausted
    // the account quota.
    const live = await this.store.countLiveUserTokens();
    if (live >= this.budget) {
      return {
        outcome: "unavailable",
        reason:
          `per-user token budget exhausted: ${live} live of ${this.budget} allowed ` +
          `(Cloudflare account quota is ${CF_ACCOUNT_TOKEN_QUOTA}, shared with every other service on the ` +
          `account). Raise USER_TOKEN_BUDGET only with headroom to spare, or switch ` +
          `UPSTREAM_CREDENTIAL_MODE to shared.`,
      };
    }

    // Clear any same-named orphan BEFORE minting, so a retry after a partial failure converges on one live
    // credential instead of accumulating one per attempt.
    const name = userTokenName(accountId);
    try {
      const orphan = await this.cf.findTokenByName(name);
      if (orphan) await this.cf.revokeToken(orphan.id);
    } catch (err) {
      // Not fatal: the census may be refused by a reduced credential, and failing the whole request over
      // a cleanup probe would take the plane down for a housekeeping problem. Logged, then onward.
      console.error("orphan upstream token sweep failed", {
        accountId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    let minted: MintedToken;
    try {
      minted = await this.cf.mintUserToken(name);
    } catch (err) {
      const detail =
        err instanceof CfApiError
          ? `${err.op} HTTP ${err.status} ${err.errors.map((e) => e.code).join(",")}`
          : err instanceof Error
            ? err.message
            : String(err);
      return { outcome: "unavailable", reason: `mint refused by Cloudflare: ${detail}` };
    }

    // ENCRYPT, THEN STORE, THEN USE. If the store write fails the credential is revoked again rather
    // than used: a token we cannot remember is a token we cannot revoke on request, and an unrevocable
    // live credential is worse than a failed request.
    try {
      const enc = await encryptToken(this.ring, minted.value);
      await this.store.putUserToken({
        account_id: accountId,
        cf_token_id: minted.id,
        token_enc: enc,
        minted_at: this.now(),
        revoked_at: null,
        last_used_at: null,
      });
    } catch (err) {
      try {
        await this.cf.revokeToken(minted.id);
      } catch (revokeErr) {
        // Both legs failed: there is now a live credential this plane does not remember. This is the one
        // condition that deserves a loud, specific log line, because the recovery is a named human task
        // (revoke `prism-cp-user-<id>` on the account) and nothing automatic will do it.
        console.error("ORPHANED upstream token: minted, not stored, not revoked", {
          accountId,
          tokenName: name,
          cfTokenId: minted.id,
          storeError: err instanceof Error ? err.message : String(err),
          revokeError: revokeErr instanceof Error ? revokeErr.message : String(revokeErr),
        });
      }
      return { outcome: "unavailable", reason: "minted credential could not be persisted" };
    }

    return { outcome: "ok", credential: { tokenId: minted.id, value: minted.value }, minted: true };
  }

  async revokeForAccount(accountId: string): Promise<boolean> {
    const row = await this.store.getUserToken(accountId);
    const targetId = row?.cf_token_id ?? (await this.cf.findTokenByName(userTokenName(accountId)))?.id;
    if (!targetId) return false;
    // CLOUDFLARE FIRST, then D1. If the order were reversed and the CF call failed, D1 would say revoked
    // while the credential still spent -- a lie in the direction that costs money.
    await this.cf.revokeToken(targetId);
    await this.store.markUserTokenRevoked(accountId, this.now());
    return true;
  }
}
