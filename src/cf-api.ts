// The Cloudflare account API, reached with the plane's own minting credential.
//
// This is the ONLY file that holds the account-level token, and it does exactly two things with it:
// mint a per-user upstream token, and revoke one. It deliberately cannot run inference -- the minting
// credential must never be the credential that spends, or the per-user attribution this plane is built
// around would be a fiction the first time something took a shortcut.
//
// THE MINTING CREDENTIAL MUST BE DASHBOARD-CREATED. Cloudflare refuses API-created tokens any
// token-management rights at all ("sub-token is not allowed to have permissions to manage other
// tokens"), so a token minted through this very endpoint can never replace the one configured here.
// That is a credential constraint, not a code constraint, and it is written here because it is the
// first thing that confuses whoever tries to automate the bootstrap.
//
// PERMISSION GROUP IDS BELOW WERE READ OFF THE ACCOUNT, never guessed:
//   GET /accounts/{id}/tokens/permission_groups, 2026-08-04, account fabcb25d (Skyphusion Labs).
// They are stable Cloudflare ids and are not secrets.

/** Envelope every api.cloudflare.com response uses. */
interface CfEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
}

/**
 * A Cloudflare API failure, carrying the operation and the upstream's own error list.
 *
 * The message is built from CF's codes rather than replaced with a generic string: a 9109 (bad token
 * permissions) and a 1001 (bad request) demand completely different operator actions, and flattening
 * them into "mint failed" costs an afternoon.
 */
export class CfApiError extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
    readonly errors: Array<{ code: number; message: string }>,
  ) {
    super(`${op}: HTTP ${status}${errors.length ? ` (${errors.map((e) => `${e.code} ${e.message}`).join("; ")})` : ""}`);
    this.name = "CfApiError";
  }
}

/** A minted credential. The VALUE is a secret; see token-minter.ts for its custody rules. */
export interface MintedToken {
  /** The Cloudflare token id. Safe to store and log: revocation needs it. */
  id: string;
  /** The token value. Encrypted before it touches D1, never logged, never returned to a client. */
  value: string;
}

/**
 * `Workers AI Read` -- lets the token call Workers AI (`@cf/`) models through the AI REST API.
 * Account-scoped.
 */
export const PG_WORKERS_AI_READ = "a92d2450e05d4e7bb7d0a64968f83d11";

/**
 * `AI Gateway Run` -- lets the token push inference through a gateway, including keyless Unified
 * Billing for third-party models. Account-scoped: the permission model has NO per-gateway resource, so
 * the user boundary is the token itself and not a resource scope.
 */
export const PG_AI_GATEWAY_RUN = "644535f4ed854494a59cb289d634b257";

/** `AI Gateway Read` -- the REST API documents an AI Gateway read permission alongside Run. */
export const PG_AI_GATEWAY_READ = "4dc8917b4b40457d88d3035d5dadb054";

/**
 * The exact grant a per-user upstream token gets. Nothing else.
 *
 * Notably absent: any token-management permission, any Workers Scripts permission, any R2 or D1
 * permission. If one of these credentials ever leaks, the blast radius is "can run inference on our
 * account", which is bounded by revoking that one token -- not "can rewrite the plane".
 */
export const USER_TOKEN_PERMISSION_GROUPS: readonly string[] = [
  PG_WORKERS_AI_READ,
  PG_AI_GATEWAY_RUN,
  PG_AI_GATEWAY_READ,
];

const CF_API = "https://api.cloudflare.com/client/v4";

export interface CfApiDeps {
  accountId: string;
  /** The account-level minting token. Held here and nowhere else. */
  token: string;
  fetchImpl?: typeof fetch;
}

export class CfApi {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: CfApiDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  private async call<T>(op: string, path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${CF_API}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        authorization: `Bearer ${this.deps.token}`,
      },
    });
    let body: CfEnvelope<T> | null = null;
    try {
      body = (await res.json()) as CfEnvelope<T>;
    } catch {
      // A non-JSON body from api.cloudflare.com is an infrastructure answer (a 5xx HTML page, a
      // truncated response). Reporting the status alone is honest; inventing an error code is not.
      throw new CfApiError(op, res.status, []);
    }
    if (!res.ok || !body?.success) {
      throw new CfApiError(op, res.status, body?.errors ?? []);
    }
    return body.result;
  }

  /**
   * Mint an account-scoped upstream token for one user.
   *
   * `name` is DETERMINISTIC (see userTokenName in token-minter.ts) so that a mint whose id never made
   * it into D1 is still findable and revocable by name. An orphaned live credential is the worst
   * outcome available here, worse than a duplicate.
   */
  async mintUserToken(name: string): Promise<MintedToken> {
    return await this.call<MintedToken>("tokens.create", `/accounts/${this.deps.accountId}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        policies: [
          {
            effect: "allow",
            permission_groups: USER_TOKEN_PERMISSION_GROUPS.map((id) => ({ id })),
            resources: { [`com.cloudflare.api.account.${this.deps.accountId}`]: "*" },
          },
        ],
      }),
    });
  }

  /**
   * Revoke a token by id.
   *
   * REVOCATION IS REAL BUT NOT INSTANT: roughly 8 to 16 seconds of propagation was measured on this
   * estate (vivijure cf#56). Treat it as a kill switch with a delay, and never as a substitute for the
   * plane's own refusal path, which is immediate.
   */
  async revokeToken(tokenId: string): Promise<void> {
    await this.call<unknown>("tokens.delete", `/accounts/${this.deps.accountId}/tokens/${tokenId}`, {
      method: "DELETE",
    });
  }

  /** Find a token by exact name, for the case where a mint landed but its id did not persist. */
  async findTokenByName(name: string): Promise<{ id: string; name: string } | null> {
    const rows = await this.call<Array<{ id: string; name: string }>>(
      "tokens.listByName",
      `/accounts/${this.deps.accountId}/tokens?name=${encodeURIComponent(name)}&per_page=50`,
    );
    return (rows ?? []).find((row) => row?.name === name) ?? null;
  }
}
